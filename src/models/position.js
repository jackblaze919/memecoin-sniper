const db = require('../db');
const logger = require('../logger');

async function create(pos) {
  const result = await db.query(`
    INSERT INTO positions (token_address, symbol, entry_price, entry_amount_sol,
      entry_amount_tokens, entry_score, entry_reason, entry_tx,
      holder_count_at_entry, liquidity_at_entry, status, mode, entry_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12)
    RETURNING id
  `, [
    pos.tokenAddress, pos.symbol, pos.entryPrice, pos.entryAmountSol,
    pos.entryAmountTokens, pos.entryScore, pos.entryReason, pos.entryTx,
    pos.holderCountAtEntry, pos.liquidityAtEntry, pos.mode || 'paper',
    pos.entryData ? JSON.stringify(pos.entryData) : null,
  ]);
  return result.rows[0].id;
}

async function getOpen() {
  const result = await db.query(`
    SELECT * FROM positions WHERE status = 'open' ORDER BY entry_timestamp ASC
  `);
  return result.rows;
}

async function getOpenByToken(tokenAddress) {
  const result = await db.query(`
    SELECT * FROM positions WHERE status = 'open' AND token_address = $1
  `, [tokenAddress]);
  return result.rows[0] || null;
}

async function getOpenCount() {
  const result = await db.query(`SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'`);
  return parseInt(result.rows[0].cnt);
}

async function updateCurrent(id, currentPrice, currentPnlPct) {
  await db.query(`
    UPDATE positions SET current_price = $2, current_pnl_pct = $3 WHERE id = $1
  `, [id, currentPrice, currentPnlPct]);
}

async function addPartialExit(id, partialExit) {
  await db.query(`
    UPDATE positions SET partial_exits = partial_exits || $2::jsonb WHERE id = $1
  `, [id, JSON.stringify([partialExit])]);
}

async function close(id, exitData) {
  await db.query(`
    UPDATE positions SET
      status = 'closed',
      exit_price = $2,
      exit_reason = $3,
      exit_tx = $4,
      exit_timestamp = NOW(),
      final_pnl_sol = $5,
      final_pnl_pct = $6,
      hold_time_minutes = EXTRACT(EPOCH FROM (NOW() - entry_timestamp)) / 60
    WHERE id = $1
  `, [id, exitData.exitPrice, exitData.exitReason, exitData.exitTx,
    exitData.finalPnlSol, exitData.finalPnlPct]);
}

async function markPendingReview(id) {
  await db.query(`UPDATE positions SET status = 'pending_review' WHERE id = $1`, [id]);
}

// Persist exit TX signature so reconciler can verify it on-chain
async function setExitTx(id, signature) {
  await db.query(`UPDATE positions SET exit_tx = $2 WHERE id = $1`, [id, signature]);
}

async function setPendingPartial(id, intent) {
  await db.query(`UPDATE positions SET pending_partial = $2::jsonb WHERE id = $1`, [id, JSON.stringify(intent)]);
}

async function clearPendingPartial(id) {
  await db.query(`UPDATE positions SET pending_partial = NULL WHERE id = $1`, [id]);
}

async function getPendingReview() {
  const result = await db.query(`SELECT * FROM positions WHERE status = 'pending_review' ORDER BY entry_timestamp ASC`);
  return result.rows;
}

async function getWithPendingPartials() {
  const result = await db.query(`SELECT * FROM positions WHERE pending_partial IS NOT NULL AND pending_partial->>'status' IN ('pending_review', 'pending')`);
  return result.rows;
}

async function getRecent(limit = 20) {
  const result = await db.query(`
    SELECT * FROM positions ORDER BY entry_timestamp DESC LIMIT $1
  `, [limit]);
  return result.rows;
}

async function getTodayTrades() {
  const result = await db.query(`
    SELECT * FROM positions
    WHERE entry_timestamp >= CURRENT_DATE
    ORDER BY entry_timestamp DESC
  `);
  return result.rows;
}

async function getTradesInLastHour() {
  const result = await db.query(`
    SELECT COUNT(*) as cnt FROM positions
    WHERE entry_timestamp >= NOW() - INTERVAL '1 hour'
  `);
  return parseInt(result.rows[0].cnt);
}

module.exports = {
  create, getOpen, getOpenByToken, getOpenCount, updateCurrent,
  addPartialExit, close, markPendingReview, getRecent, getTodayTrades,
  getTradesInLastHour, setPendingPartial, clearPendingPartial,
  getPendingReview, getWithPendingPartials, setExitTx,
};
