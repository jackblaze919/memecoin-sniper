const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const positionModel = require('./models/position');
const stats = require('./models/stats');
const { todayDate } = require('./utils');

// Check if a new trade is allowed by all risk rules
async function canTrade(tokenAddress) {
  const reasons = [];

  // Check if bot is paused
  const pausedUntil = await stats.getState('paused_until');
  if (pausedUntil && pausedUntil !== null && new Date(pausedUntil) > new Date()) {
    reasons.push(`Bot paused until ${pausedUntil}`);
    return { allowed: false, reasons };
  }

  // Check trading mode
  if (config.tradingMode === 'scanner') {
    reasons.push('Scanner mode — no trades');
    return { allowed: false, reasons };
  }

  // Check daily loss limit
  const dailyLoss = await stats.getState('daily_loss_total');
  if (dailyLoss && Math.abs(parseFloat(dailyLoss)) >= config.dailyLossLimitSol) {
    reasons.push(`Daily loss limit hit: ${dailyLoss} SOL`);
    await stats.setDailyLossLimitHit();
    return { allowed: false, reasons };
  }

  // Check trades in last hour
  const tradesLastHour = await positionModel.getTradesInLastHour();
  if (tradesLastHour >= config.maxTradesPerHour) {
    reasons.push(`Max trades/hour reached: ${tradesLastHour}`);
    return { allowed: false, reasons };
  }

  // Check concurrent positions
  const openCount = await positionModel.getOpenCount();
  const maxPositions = config.getMaxConcurrentPositions();
  if (openCount >= maxPositions) {
    reasons.push(`Max concurrent positions: ${openCount}/${maxPositions}`);
    return { allowed: false, reasons };
  }

  // Check cooldown after loss
  const lastTradeAt = await stats.getState('last_trade_at');
  const consecutiveLosses = parseInt(await stats.getState('consecutive_losses')) || 0;
  if (consecutiveLosses >= 5) {
    // 1 hour pause after 5 consecutive losses
    if (lastTradeAt) {
      const elapsed = Date.now() - new Date(lastTradeAt).getTime();
      if (elapsed < 3600000) {
        reasons.push(`5 consecutive losses — paused for ${Math.ceil((3600000 - elapsed) / 60000)} min`);
        return { allowed: false, reasons };
      }
    }
  } else if (consecutiveLosses > 0 && lastTradeAt) {
    // 5 minute cooldown after any loss
    const elapsed = Date.now() - new Date(lastTradeAt).getTime();
    if (elapsed < 300000) {
      reasons.push(`Post-loss cooldown: ${Math.ceil((300000 - elapsed) / 1000)}s remaining`);
      return { allowed: false, reasons };
    }
  }

  // Check same-day rebuy lock after loss
  const lockCheck = await db.query(`
    SELECT 1 FROM trade_locks
    WHERE token_address = $1 AND date = $2 AND action = 'rebuy_lock'
    LIMIT 1
  `, [tokenAddress, todayDate()]);
  if (lockCheck.rows.length > 0) {
    reasons.push('Same-day rebuy lock after loss');
    return { allowed: false, reasons };
  }

  // Check for existing open position on this token
  const existing = await positionModel.getOpenByToken(tokenAddress);
  if (existing) {
    reasons.push('Already have open position on this token');
    return { allowed: false, reasons };
  }

  // DRY_RUN check for live modes
  if (config.isLiveMode() && config.dryRun) {
    reasons.push('DRY_RUN=true blocks real trades');
    return { allowed: false, reasons };
  }

  return { allowed: true, reasons: [] };
}

// Record trade outcome for risk tracking
async function recordTradeOutcome(pnlSol, tokenAddress) {
  await stats.setState('last_trade_at', new Date().toISOString());

  if (pnlSol < 0) {
    const losses = (parseInt(await stats.getState('consecutive_losses')) || 0) + 1;
    await stats.setState('consecutive_losses', losses);

    const dailyLoss = (parseFloat(await stats.getState('daily_loss_total')) || 0) + pnlSol;
    await stats.setState('daily_loss_total', dailyLoss);

    // Set rebuy lock for this token today
    await db.query(`
      INSERT INTO trade_locks (token_address, date, action)
      VALUES ($1, $2, 'rebuy_lock')
      ON CONFLICT DO NOTHING
    `, [tokenAddress, todayDate()]);

    logger.info({ losses, dailyLoss, tokenAddress }, 'Loss recorded');
  } else {
    await stats.setState('consecutive_losses', 0);
    logger.info({ pnlSol, tokenAddress }, 'Win recorded');
  }
}

// Acquire idempotency lock for a trade action
async function acquireTradeLock(tokenAddress, action) {
  try {
    await db.query(`
      INSERT INTO trade_locks (token_address, date, action)
      VALUES ($1, $2, $3)
    `, [tokenAddress, todayDate(), action]);
    return true;
  } catch (err) {
    // Unique constraint violation means lock already exists
    if (err.code === '23505') {
      logger.warn({ tokenAddress, action }, 'Trade lock already exists');
      return false;
    }
    throw err;
  }
}

async function releaseTradeLock(tokenAddress, action) {
  await db.query(`
    DELETE FROM trade_locks
    WHERE token_address = $1 AND date = $2 AND action = $3
  `, [tokenAddress, todayDate(), action]);
}

// Reset daily counters (call at midnight)
async function resetDaily() {
  await stats.setState('daily_loss_total', 0);
  await stats.setState('consecutive_losses', 0);
  // Clean old trade locks (buy locks, rebuy locks from previous days)
  await db.query(`DELETE FROM trade_locks WHERE date < $1`, [todayDate()]);
  logger.info('Daily risk counters reset (including consecutive_losses)');
}

// Clean stranded buy locks from crashed processes.
// After repeated restarts, buy locks for specific tokens can persist
// because the process died between acquireLock and releaseLock.
// Only cleans 'buy' locks (not rebuy_locks which are intentional).
async function cleanStrandedBuyLocks() {
  const result = await db.query(
    `DELETE FROM trade_locks WHERE action = 'buy' AND date = $1 RETURNING token_address`,
    [todayDate()]
  );
  if (result.rowCount > 0) {
    logger.warn({ cleaned: result.rowCount, tokens: result.rows.map(r => r.token_address) },
      'Cleaned stranded buy locks from crashed processes');
  }
}

module.exports = {
  canTrade, recordTradeOutcome, acquireTradeLock, releaseTradeLock, resetDaily,
  cleanStrandedBuyLocks,
};
