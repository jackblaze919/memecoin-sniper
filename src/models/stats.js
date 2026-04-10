const db = require('../db');
const { todayDate } = require('../utils');

async function getToday() {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date) VALUES ($1) ON CONFLICT (date) DO NOTHING
  `, [date]);
  const result = await db.query('SELECT * FROM daily_stats WHERE date = $1', [date]);
  return result.rows[0];
}

async function incrementTrades() {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, total_trades) VALUES ($1, 1)
    ON CONFLICT (date) DO UPDATE SET total_trades = daily_stats.total_trades + 1
  `, [date]);
}

async function recordWin(pnlSol, pnlUsd) {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, wins, total_pnl_sol, total_pnl_usd)
    VALUES ($1, 1, $2, $3)
    ON CONFLICT (date) DO UPDATE SET
      wins = daily_stats.wins + 1,
      total_pnl_sol = daily_stats.total_pnl_sol + $2,
      total_pnl_usd = daily_stats.total_pnl_usd + $3
  `, [date, pnlSol, pnlUsd]);
}

async function recordLoss(pnlSol, pnlUsd) {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, losses, total_pnl_sol, total_pnl_usd)
    VALUES ($1, 1, $2, $3)
    ON CONFLICT (date) DO UPDATE SET
      losses = daily_stats.losses + 1,
      total_pnl_sol = daily_stats.total_pnl_sol + $2,
      total_pnl_usd = daily_stats.total_pnl_usd + $3
  `, [date, pnlSol, pnlUsd]);
}

async function incrementScanned(count = 1) {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, tokens_scanned) VALUES ($1, $2)
    ON CONFLICT (date) DO UPDATE SET tokens_scanned = daily_stats.tokens_scanned + $2
  `, [date, count]);
}

async function incrementBought() {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, tokens_bought) VALUES ($1, 1)
    ON CONFLICT (date) DO UPDATE SET tokens_bought = daily_stats.tokens_bought + 1
  `, [date]);
}

async function setDailyLossLimitHit() {
  const date = todayDate();
  await db.query(`
    UPDATE daily_stats SET daily_loss_limit_hit = true WHERE date = $1
  `, [date]);
}

async function incrementBirdeyeCus(count = 1) {
  const date = todayDate();
  await db.query(`
    INSERT INTO daily_stats (date, birdeye_cus_used) VALUES ($1, $2)
    ON CONFLICT (date) DO UPDATE SET birdeye_cus_used = daily_stats.birdeye_cus_used + $2
  `, [date, count]);
}

// Pipeline funnel tracking — opportunity starvation detection.
// Stored in the JSONB `data` column of daily_stats (no migration needed).
async function recordFunnel({ scanned, inclusionPass, ranked, above70, above72, buyEligible }) {
  const date = todayDate();
  // Read current funnel values, increment, write back.
  // Simple read-modify-write avoids the fragile nested jsonb_set chain
  // that was silently failing (all funnel_* fields were null).
  try {
    const { rows } = await db.query(
      `SELECT data FROM daily_stats WHERE date = $1`, [date]
    );
    const existing = rows[0]?.data || {};
    const updated = {
      ...existing,
      funnel_ticks: (parseInt(existing.funnel_ticks) || 0) + 1,
      funnel_scanned: (parseInt(existing.funnel_scanned) || 0) + (scanned || 0),
      funnel_inclusion_pass: (parseInt(existing.funnel_inclusion_pass) || 0) + (inclusionPass || 0),
      funnel_ranked: (parseInt(existing.funnel_ranked) || 0) + (ranked || 0),
      funnel_above_70: (parseInt(existing.funnel_above_70) || 0) + (above70 || 0),
      funnel_above_72: (parseInt(existing.funnel_above_72) || 0) + (above72 || 0),
      funnel_buy_eligible: (parseInt(existing.funnel_buy_eligible) || 0) + (buyEligible || 0),
    };
    await db.query(
      `UPDATE daily_stats SET data = $2::jsonb WHERE date = $1`,
      [date, JSON.stringify(updated)]
    );
  } catch (err) {
    // Non-fatal — funnel is observability only
    const logger = require('../logger');
    logger.warn({ err: err.message }, 'recordFunnel failed');
  }
}

// Bot state helpers
async function getState(key) {
  const result = await db.query('SELECT value FROM bot_state WHERE key = $1', [key]);
  if (!result.rows[0]) return null;
  return result.rows[0].value;
}

async function setState(key, value) {
  await db.query(`
    INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

module.exports = {
  getToday, incrementTrades, recordWin, recordLoss,
  incrementScanned, incrementBought, setDailyLossLimitHit,
  incrementBirdeyeCus, recordFunnel, getState, setState,
};
