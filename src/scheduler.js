const config = require('./config');
const logger = require('./logger');
const scanner = require('./scanner');
const ranker = require('./ranker');
const executor = require('./executor');
const risk = require('./risk');
const report = require('./report');
const reconciler = require('./reconciler');
const { sleep } = require('./utils');

let running = false;
let scanInterval = null;
let rankInterval = null;
let monitorInterval = null;
let reconcileInterval = null;
let dailyResetInterval = null;
let dailyReportInterval = null;

// Ring buffer of recent skip reasons — accessible via /skips
const MAX_SKIPS = 30;
const recentSkips = [];
function recordSkip(entry) {
  recentSkips.push({ ...entry, at: new Date().toISOString() });
  if (recentSkips.length > MAX_SKIPS) recentSkips.shift();
}
function getRecentSkips(n = 10) {
  return recentSkips.slice(-n).reverse();
}

function start() {
  if (running) {
    logger.warn('Scheduler already running');
    return;
  }
  running = true;
  logger.info({ mode: config.tradingMode }, 'Scheduler starting');

  // Scanner: every 60s
  scanInterval = setInterval(runScanTick, 60000);
  // Run first scan immediately
  runScanTick();

  // Ranker: every 90s (offset from scanner)
  setTimeout(() => {
    rankInterval = setInterval(runRankTick, 90000);
  }, 30000);

  // Position monitor: every 30s (only in paper/live modes)
  if (config.tradingMode !== 'scanner') {
    monitorInterval = setInterval(runMonitorTick, 30000);
  }

  // Reconciliation: every 5 minutes (only in live modes)
  if (config.isLiveMode()) {
    reconcileInterval = setInterval(runReconcileTick, 300000);
  }

  // Daily reset at midnight UTC — check every 5 minutes
  dailyResetInterval = setInterval(checkDailyReset, 300000);

  // Daily report — check every 5 minutes near midnight UTC
  dailyReportInterval = setInterval(checkDailyReport, 300000);

  logger.info('Scheduler started');
}

function stop() {
  running = false;
  clearInterval(scanInterval);
  clearInterval(rankInterval);
  clearInterval(monitorInterval);
  clearInterval(reconcileInterval);
  clearInterval(dailyResetInterval);
  clearInterval(dailyReportInterval);
  logger.info('Scheduler stopped');
}

async function runScanTick() {
  if (!running) return;
  try {
    await scanner.scan();
  } catch (err) {
    logger.error({ err }, 'Scan tick failed');
  }
}

async function runRankTick() {
  if (!running) return;

  // SAFETY: Scanner mode skips ranking entirely to avoid burning Birdeye credits.
  // Ranker calls Birdeye for safety gate + overview on every candidate.
  if (config.tradingMode === 'scanner') {
    logger.debug('Scanner mode — skipping rank tick (no Birdeye calls)');
    return;
  }

  try {
    const candidateMap = scanner.getCandidateMap();
    if (candidateMap.size === 0) {
      logger.debug('No candidates to rank');
      return;
    }

    const ranked = await ranker.rank(candidateMap);
    const eligible = ranked.filter((r) => r.buyEligible);
    const ineligible = ranked.filter((r) => !r.buyEligible && r.totalScore >= config.buyScoreThreshold);
    const aboveThreshold = ranked.filter((r) => r.totalScore >= config.buyScoreThreshold).length;

    logger.info({
      candidates: candidateMap.size,
      ranked: ranked.length,
      buyEligible: eligible.length,
      ineligible: ineligible.length,
      aboveThreshold,
      threshold: config.buyScoreThreshold,
    }, 'Rank tick complete');

    // PIPELINE STUCK ALERT — fires once when candidates exist but
    // ranker returns 0 results (likely scoreCandidate is throwing)
    // or when high scores exist but 0 eligible (hidden blocker).
    if (!runRankTick._alertSent) {
      const top3 = ranked.slice(0, 3).map(c => ({
        s: c.symbol, sc: c.totalScore?.toFixed(1),
        safe: c.safetyGatePassed, fomo: c.antiFomoRejected,
        elig: c.buyEligible,
      }));
      if (candidateMap.size > 0 && ranked.length === 0) {
        await telegram.sendAlert(
          `🔍 PIPELINE DIAG: ${candidateMap.size} candidates but ranker returned 0 results.\n` +
          `scoreCandidate is likely throwing for every candidate. Check logs for "Ranker error".`
        );
        runRankTick._alertSent = true;
      } else if (aboveThreshold > 0 && eligible.length === 0) {
        await telegram.sendAlert(
          `🔍 PIPELINE DIAG: ${aboveThreshold} above threshold ${config.buyScoreThreshold} but 0 eligible.\n` +
          `Top 3: ${top3.map(c => `${c.s}:${c.sc} safe=${c.safe} fomo=${c.fomo} elig=${c.elig}`).join(' | ')}`
        );
        runRankTick._alertSent = true;
      } else if (eligible.length > 0) {
        await telegram.sendAlert(
          `🔍 PIPELINE DIAG: ${eligible.length} eligible for buy.\n` +
          `Top 3: ${top3.map(c => `${c.s}:${c.sc} elig=${c.elig}`).join(' | ')}\n` +
          `Entering executor loop now...`
        );
        runRankTick._alertSent = true;
      }
    }

    // Log + record why high-score candidates were NOT eligible
    for (const c of ineligible) {
      const reasons = [];
      if (!c.safetyGatePassed) reasons.push('safety_gate_failed');
      if (c.antiFomoRejected) reasons.push(`anti_fomo: ${c.antiFomoReason}`);
      logger.info({ address: c.address, symbol: c.symbol, score: c.totalScore.toFixed(1), reasons }, 'High-score candidate NOT eligible');
      recordSkip({ symbol: c.symbol, score: c.totalScore.toFixed(1), reasons });
    }

    // Also log candidates with score >= 65 but below threshold
    for (const c of ranked) {
      if (c.totalScore >= 65 && c.totalScore < config.buyScoreThreshold && !ineligible.includes(c)) {
        recordSkip({ symbol: c.symbol, score: c.totalScore.toFixed(1), reasons: [`score_below_threshold (${c.totalScore.toFixed(1)} < ${config.buyScoreThreshold})`] });
      }
    }

    // In paper/live modes, attempt to buy eligible candidates
    if (eligible.length > 0) {
      logger.info({
        eligibleCount: eligible.length,
        symbols: eligible.map(c => c.symbol).join(', '),
      }, 'DIAG:buyLoop — entering executor loop');
    } else {
      logger.info('DIAG:buyLoop — eligible list is EMPTY, no buys attempted');
    }
    for (const candidate of eligible) {
      if (!running) break;

      try {
        const result = await executor.tryBuy(candidate);
        if (result.bought) {
          logger.info({ address: candidate.address, symbol: candidate.symbol }, 'Buy executed');
          await sleep(2000);
        } else {
          logger.info({ address: candidate.address, symbol: candidate.symbol, reasons: result.reasons }, 'Buy attempt rejected');
          recordSkip({ symbol: candidate.symbol, score: candidate.totalScore.toFixed(1), reasons: result.reasons });
        }
      } catch (err) {
        logger.error({ err, address: candidate.address, symbol: candidate.symbol }, 'Buy attempt threw — continuing to next candidate');
        recordSkip({ symbol: candidate.symbol, score: candidate.totalScore.toFixed(1), reasons: [`exception: ${err.message}`] });
      }
    }
  } catch (err) {
    logger.error({ err }, 'Rank tick failed');
  }
}

async function runMonitorTick() {
  if (!running) return;
  try {
    await executor.monitorPositions();
  } catch (err) {
    logger.error({ err }, 'Monitor tick failed');
  }
}

async function runReconcileTick() {
  if (!running) return;
  try {
    await reconciler.reconcile();
  } catch (err) {
    logger.error({ err }, 'Reconcile tick failed');
  }
}

// Track which UTC date we last ran reset for. Uses a DURABLE DB marker
// so stale risk state from previous days is always cleaned on startup,
// even if the bot restarts mid-day.
let lastResetDate = null;
async function checkDailyReset() {
  const utcDate = new Date().toISOString().slice(0, 10);

  if (lastResetDate === null) {
    // First check after startup — read the last reset date from DB.
    // If it's before today, reset now. If it's today, skip (already done).
    const stats = require('./models/stats');
    const dbResetDate = await stats.getState('last_daily_reset');
    if (dbResetDate !== utcDate) {
      logger.info({ dbResetDate, utcDate }, 'Daily reset: stale risk state detected, resetting now');
      await risk.resetDaily();
      await stats.setState('last_daily_reset', utcDate);
    } else {
      logger.debug('Daily reset: already done for today');
    }
    lastResetDate = utcDate;
    return;
  }

  if (utcDate !== lastResetDate) {
    lastResetDate = utcDate;
    const stats = require('./models/stats');
    await risk.resetDaily();
    await stats.setState('last_daily_reset', utcDate);
  }
}

let lastReportDate = null;
async function checkDailyReport() {
  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10);
  // Send report near midnight UTC (23:55-23:59)
  if (utcDate !== lastReportDate && now.getUTCHours() === 23 && now.getUTCMinutes() >= 55) {
    lastReportDate = utcDate;
    await report.sendDailyReport();
  }
}

module.exports = { start, stop, getRecentSkips };
