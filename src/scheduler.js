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
    logger.info({ ranked: ranked.length, buyEligible: eligible.length }, 'Rank tick complete');

    // Log why high-score candidates were NOT eligible
    for (const c of ineligible) {
      const reasons = [];
      if (c.totalScore < config.buyScoreThreshold) reasons.push(`score ${c.totalScore.toFixed(1)} < ${config.buyScoreThreshold}`);
      if (!c.safetyGatePassed) reasons.push('safety gate failed');
      if (c.antiFomoRejected) reasons.push(`anti-FOMO: ${c.antiFomoReason}`);
      logger.info({
        address: c.address,
        symbol: c.symbol,
        score: c.totalScore.toFixed(1),
        reasons,
      }, 'High-score candidate NOT eligible');
    }

    // In paper/live modes, attempt to buy eligible candidates
    for (const candidate of eligible) {
      if (!running) break;

      const result = await executor.tryBuy(candidate);
      if (result.bought) {
        logger.info({ address: candidate.address, symbol: candidate.symbol }, 'Buy executed');
        // Small delay between buys
        await sleep(2000);
      } else {
        logger.info({ address: candidate.address, symbol: candidate.symbol, reasons: result.reasons }, 'Buy attempt rejected');
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

// Track which UTC date we last ran reset for. Compare dates, not clock times,
// so we never miss reset due to setInterval drift.
let lastResetDate = null;
async function checkDailyReset() {
  const utcDate = new Date().toISOString().slice(0, 10);
  if (lastResetDate === null) {
    // First check after startup — record current date, don't reset mid-day
    lastResetDate = utcDate;
    return;
  }
  if (utcDate !== lastResetDate) {
    lastResetDate = utcDate;
    await risk.resetDaily();
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

module.exports = { start, stop };
