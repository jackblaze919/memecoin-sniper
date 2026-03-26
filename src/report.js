const { Resend } = require('resend');
const config = require('./config');
const logger = require('./logger');
const statsModel = require('./models/stats');
const positionModel = require('./models/position');
const tokenModel = require('./models/token');
const telegram = require('./telegram');
const { formatSol, formatPct, formatUsd, todayDate } = require('./utils');

/**
 * Generate the daily report text. Throws on error so callers can
 * decide how to surface the failure (log-only for scheduled runs,
 * reply to user for on-demand /report).
 */
async function generateReportText() {
  const s = await statsModel.getToday();
  const todayTrades = await positionModel.getTodayTrades();
  // Use recent candidates (scored within last 10 min) to avoid showing stale
  // DB records for tokens that left the active pipeline hours ago.
  const candidates = await tokenModel.getRecentCandidates(10, 50);
  const pendingReview = await positionModel.getPendingReview();
  const pendingPartials = await positionModel.getWithPendingPartials();

  // Closed trades analysis
  const closed = todayTrades.filter((t) => t.status === 'closed' && t.final_pnl_sol !== null);
  const winners = closed.filter((t) => t.final_pnl_sol >= 0);
  const losers = closed.filter((t) => t.final_pnl_sol < 0);

  const avgWin = winners.length > 0
    ? winners.reduce((sum, t) => sum + t.final_pnl_pct, 0) / winners.length
    : 0;
  const avgLoss = losers.length > 0
    ? losers.reduce((sum, t) => sum + t.final_pnl_pct, 0) / losers.length
    : 0;
  const maxDrawdown = closed.length > 0
    ? Math.min(...closed.map((t) => t.final_pnl_pct))
    : 0;
  const avgHold = closed.length > 0
    ? closed.reduce((sum, t) => sum + (t.hold_time_minutes || 0), 0) / closed.length
    : 0;

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of closed) {
    const reason = t.exit_reason || 'unknown';
    // Normalize to category
    let cat = 'other';
    if (reason.includes('Stop loss')) cat = 'stop_loss';
    else if (reason.includes('Max hold')) cat = 'max_hold';
    else if (reason.includes('Liquidity')) cat = 'liq_drop';
    else if (reason.includes('final exit')) cat = 'target_hit';
    else if (reason.includes('sell 50%') || reason.includes('sell 25%')) cat = 'partial';
    else cat = reason.slice(0, 25);
    exitReasons[cat] = (exitReasons[cat] || 0) + 1;
  }

  // Skip reason summary from in-memory buffer (lazy require to avoid circular dep)
  const scheduler = require('./scheduler');
  const skips = scheduler.getRecentSkips(30);
  const skipReasons = {};
  for (const skip of skips) {
    for (const r of skip.reasons) {
      const key = r.split(':')[0].split(' ')[0]; // first word
      skipReasons[key] = (skipReasons[key] || 0) + 1;
    }
  }

  // Top 5 unbought candidates
  const unbought = candidates
    .filter((c) => c.total_score && !todayTrades.find((t) => t.token_address === c.address))
    .slice(0, 5);

  const totalTrades = s?.total_trades || 0;
  const wins = s?.wins || 0;
  const losses = s?.losses || 0;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';

  const sections = [
    `📊 Daily Report — ${todayDate()}`,
    `Mode: ${config.tradingMode} | DRY_RUN: ${config.dryRun}`,
    ``,
    `── Performance ──`,
    `Trades: ${totalTrades} (W:${wins} L:${losses})`,
    `Win Rate: ${winRate}%`,
    `Total PnL: ${formatSol(s?.total_pnl_sol || 0)} SOL`,
    `Avg Winner: ${formatPct(avgWin)}`,
    `Avg Loser: ${formatPct(avgLoss)}`,
    `Max Drawdown: ${formatPct(maxDrawdown)}`,
    `Avg Hold: ${avgHold.toFixed(0)} min`,
    ``,
    `── Exit Reasons ──`,
    ...Object.entries(exitReasons).map(([k, v]) => `  ${k}: ${v}`),
    ...(Object.keys(exitReasons).length === 0 ? ['  (no exits yet)'] : []),
    ``,
    `── Skipped Entries ──`,
    ...Object.entries(skipReasons).map(([k, v]) => `  ${k}: ${v}`),
    ...(Object.keys(skipReasons).length === 0 ? ['  (no skips recorded)'] : []),
    ``,
    `── Top Unbought ──`,
    ...unbought.map((c, i) => {
      const reasons = [];
      if (!c.safety_gate_passed) reasons.push('safety');
      if (c.anti_fomo_rejected) reasons.push('FOMO');
      if ((c.total_score || 0) < config.buyScoreThreshold) reasons.push('score');
      // Show how recently this candidate was scored
      const agoMin = c.last_scored_at
        ? Math.round((Date.now() - new Date(c.last_scored_at).getTime()) / 60000)
        : null;
      const agoLabel = agoMin !== null ? ` ${agoMin}m ago` : '';
      return `${i + 1}. ${c.symbol || '?'} (${(c.total_score || 0).toFixed(1)}) — ${reasons.join(', ') || 'eligible'}${agoLabel}`;
    }),
    ...(unbought.length === 0 ? ['  (none)'] : []),
  ];

  // Reconciliation events
  if (pendingReview.length > 0 || pendingPartials.length > 0) {
    sections.push(``, `── Reconciliation ──`);
    if (pendingReview.length > 0) sections.push(`Pending review: ${pendingReview.length}`);
    if (pendingPartials.length > 0) sections.push(`Pending partials: ${pendingPartials.length}`);
  }

  sections.push(``, `Scanned: ${s?.tokens_scanned || 0} | Birdeye CUs: ${s?.birdeye_cus_used || 0}`);

  return sections.join('\n');
}

/**
 * Scheduled daily report: generate, send via Telegram + email.
 * Errors are logged but not re-thrown so the scheduler doesn't crash.
 */
async function sendDailyReport() {
  logger.info('Generating daily report');

  try {
    const reportText = await generateReportText();

    // Send via Telegram
    await telegram.sendAlert(reportText);

    // Send via Resend email
    if (config.resendApiKey && config.reportEmail) {
      const resend = new Resend(config.resendApiKey);
      await resend.emails.send({
        from: 'Memecoin Sniper <onboarding@resend.dev>',
        to: config.reportEmail,
        subject: `Memecoin Sniper Report — ${todayDate()}`,
        text: reportText,
      });
      logger.info('Daily report email sent');
    }

    logger.info('Daily report complete');
  } catch (err) {
    logger.error({ err }, 'Daily report failed');
  }
}

module.exports = { sendDailyReport, generateReportText };
