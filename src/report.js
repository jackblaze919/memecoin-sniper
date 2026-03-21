const { Resend } = require('resend');
const config = require('./config');
const logger = require('./logger');
const statsModel = require('./models/stats');
const positionModel = require('./models/position');
const tokenModel = require('./models/token');
const telegram = require('./telegram');
const { formatSol, formatPct, formatUsd, todayDate } = require('./utils');

async function sendDailyReport() {
  logger.info('Generating daily report');

  try {
    const s = await statsModel.getToday();
    const todayTrades = await positionModel.getTodayTrades();
    const candidates = await tokenModel.getCandidates(50);

    // Find best/worst trade
    let bestTrade = null;
    let worstTrade = null;
    for (const t of todayTrades) {
      if (t.final_pnl_sol !== null) {
        if (!bestTrade || t.final_pnl_sol > bestTrade.final_pnl_sol) bestTrade = t;
        if (!worstTrade || t.final_pnl_sol < worstTrade.final_pnl_sol) worstTrade = t;
      }
    }

    // Top 3 unbought candidates
    const unbought = candidates
      .filter((c) => c.total_score && !todayTrades.find((t) => t.token_address === c.address))
      .slice(0, 3);

    const totalTrades = s?.total_trades || 0;
    const wins = s?.wins || 0;
    const losses = s?.losses || 0;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';
    const selectivity = candidates.length > 0
      ? (((s?.tokens_bought || 0) / candidates.length) * 100).toFixed(1)
      : '0';

    const reportText = [
      `📊 Daily Report — ${todayDate()}`,
      ``,
      `Mode: ${config.tradingMode}`,
      `Trades: ${totalTrades} (W:${wins} L:${losses})`,
      `Win Rate: ${winRate}%`,
      `Total PnL: ${formatSol(s?.total_pnl_sol || 0)} SOL / ${formatUsd(s?.total_pnl_usd || 0)}`,
      ``,
      `Best trade: ${bestTrade ? `${bestTrade.symbol} ${formatPct(bestTrade.final_pnl_pct)}` : 'N/A'}`,
      `Worst trade: ${worstTrade ? `${worstTrade.symbol} ${formatPct(worstTrade.final_pnl_pct)}` : 'N/A'}`,
      ``,
      `Tokens scanned: ${s?.tokens_scanned || 0}`,
      `Tokens bought: ${s?.tokens_bought || 0}`,
      `Selectivity: ${selectivity}%`,
      `Birdeye CUs: ${s?.birdeye_cus_used || 0}`,
      ``,
      `Top unbought candidates:`,
      ...unbought.map((c, i) => {
        const reasons = [];
        if (!c.safety_gate_passed) reasons.push('safety gate');
        if (c.anti_fomo_rejected) reasons.push(`anti-FOMO: ${c.anti_fomo_reason}`);
        if ((c.total_score || 0) < config.buyScoreThreshold) reasons.push(`score ${(c.total_score || 0).toFixed(1)} < ${config.buyScoreThreshold}`);
        return `${i + 1}. ${c.symbol || '?'} (${(c.total_score || 0).toFixed(1)}) — ${reasons.join(', ') || 'eligible but not traded'}`;
      }),
    ].join('\n');

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

module.exports = { sendDailyReport };
