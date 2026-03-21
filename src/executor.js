const config = require('./config');
const logger = require('./logger');
const jupiter = require('./apis/jupiter');
const dexscreener = require('./apis/dexscreener');
const birdeye = require('./apis/birdeye');
const wallet = require('./wallet');
const risk = require('./risk');
const positionModel = require('./models/position');
const statsModel = require('./models/stats');
const telegram = require('./telegram');
const { cache, TTL } = require('./cache');
const { formatSol, formatPct, safeNumber, truncateAddress, minutesAgo, pctChange } = require('./utils');

// DB-backed exit lock helpers — survive crash/restart unlike the old in-memory Set.
const db = require('./db');

async function acquireExitLock(positionId, lockType) {
  try {
    await db.query(
      `INSERT INTO exit_locks (position_id, lock_type) VALUES ($1, $2)`,
      [positionId, lockType]
    );
    return true;
  } catch (err) {
    if (err.code === '23505') return false; // already locked
    throw err;
  }
}

async function releaseExitLock(positionId, lockType) {
  await db.query(`DELETE FROM exit_locks WHERE position_id = $1 AND lock_type = $2`, [positionId, lockType]);
}

// ---- Entry ----

async function tryBuy(candidate) {
  const { address, symbol, totalScore, pair, overview, safety } = candidate;

  logger.info({ address, symbol, totalScore }, 'Evaluating buy');

  // Risk check
  const riskCheck = await risk.canTrade(address);
  if (!riskCheck.allowed) {
    logger.info({ address, reasons: riskCheck.reasons }, 'Buy blocked by risk');
    return { bought: false, reasons: riskCheck.reasons };
  }

  // Acquire trade lock
  const locked = await risk.acquireTradeLock(address, 'buy');
  if (!locked) {
    return { bought: false, reasons: ['Could not acquire trade lock'] };
  }

  try {
    const positionSol = config.getMaxPositionSol();
    const lamports = Math.floor(positionSol * 1e9);

    if (config.tradingMode === 'paper') {
      return await executePaperBuy(address, symbol, totalScore, lamports, positionSol, pair, overview);
    }

    if (config.tradingMode === 'tiny_live' || config.tradingMode === 'live') {
      return await executeLiveBuy(address, symbol, totalScore, lamports, positionSol, pair, overview);
    }

    return { bought: false, reasons: ['Invalid trading mode for execution'] };
  } catch (err) {
    logger.error({ err, address }, 'Buy execution error');
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: [err.message] };
  }
}

async function executePaperBuy(address, symbol, score, lamports, positionSol, pair, overview) {
  // Get live quote for paper simulation
  let quote;
  try {
    quote = await jupiter.getQuote({
      inputMint: jupiter.SOL_MINT,
      outputMint: address,
      amount: lamports,
    });
  } catch (err) {
    logger.warn({ err, address }, 'Paper buy quote failed');
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: ['Quote failed'] };
  }

  if (!quote || safeNumber(quote.outAmount) <= 0) {
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: ['Invalid quote'] };
  }

  if (quote.priceImpactPct > 5) {
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: [`Price impact too high: ${quote.priceImpactPct}%`] };
  }

  const entryPrice = pair?.priceUsd || 0;
  const tokensReceived = safeNumber(quote.outAmount);

  const posId = await positionModel.create({
    tokenAddress: address,
    symbol,
    entryPrice,
    entryAmountSol: positionSol,
    entryAmountTokens: tokensReceived,
    entryScore: score,
    entryReason: `Paper buy | Score: ${score.toFixed(1)} | Impact: ${quote.priceImpactPct.toFixed(2)}%`,
    entryTx: 'paper_' + Date.now(),
    holderCountAtEntry: overview?.holderCount || null,
    liquidityAtEntry: pair?.liquidityUsd || null,
    mode: 'paper',
  });

  await statsModel.incrementTrades();
  await statsModel.incrementBought();

  logger.info({ posId, address, symbol, positionSol, entryPrice }, 'Paper buy executed');

  // Release buy lock — position is created, lock served its purpose
  await risk.releaseTradeLock(address, 'buy');

  await telegram.sendAlert(
    `📝 PAPER BUY: ${symbol}\n` +
    `Address: ${truncateAddress(address)}\n` +
    `Amount: ${formatSol(positionSol)} SOL\n` +
    `Score: ${score.toFixed(1)}\n` +
    `Price: $${entryPrice.toFixed(8)}`
  );

  return { bought: true, positionId: posId, mode: 'paper' };
}

async function executeLiveBuy(address, symbol, score, lamports, positionSol, pair, overview) {
  if (config.dryRun) {
    logger.warn({ address }, 'DRY_RUN=true — blocking real trade');
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: ['DRY_RUN=true'] };
  }

  // Check wallet balance
  const balance = await wallet.getBalance();
  if (balance < positionSol + config.solReserve) {
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: [`Insufficient balance: ${balance} SOL`] };
  }

  // Get quote
  const quote = await jupiter.getQuote({
    inputMint: jupiter.SOL_MINT,
    outputMint: address,
    amount: lamports,
  });

  if (!quote || safeNumber(quote.outAmount) <= 0) {
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: ['Invalid quote'] };
  }

  if (quote.priceImpactPct > 5) {
    await risk.releaseTradeLock(address, 'buy');
    return { bought: false, reasons: [`Price impact: ${quote.priceImpactPct}%`] };
  }

  // Get swap transaction
  const swapResult = await jupiter.getSwapTransaction({
    quoteResponse: quote.raw,
    userPublicKey: wallet.getPublicKey(),
  });

  // Sign and send
  const txResult = await wallet.signAndSendTransaction(swapResult.swapTransaction);

  if (!txResult.success) {
    const posId = await positionModel.create({
      tokenAddress: address,
      symbol,
      entryPrice: pair?.priceUsd || 0,
      entryAmountSol: positionSol,
      entryAmountTokens: safeNumber(quote.outAmount),
      entryScore: score,
      entryReason: `Live buy PENDING | Score: ${score.toFixed(1)}`,
      entryTx: txResult.signature,
      holderCountAtEntry: overview?.holderCount || null,
      liquidityAtEntry: pair?.liquidityUsd || null,
      mode: config.tradingMode,
    });
    await positionModel.markPendingReview(posId);
    await risk.releaseTradeLock(address, 'buy');
    logger.error({ posId, signature: txResult.signature }, 'Buy tx not confirmed — marked pending_review');

    await telegram.sendAlert(
      `⚠️ BUY PENDING REVIEW: ${symbol}\n` +
      `TX: ${txResult.signature}\n` +
      `Error: ${txResult.error}`
    );

    return { bought: false, reasons: ['TX confirmation failed'], pendingReview: true };
  }

  const entryPrice = pair?.priceUsd || 0;
  const posId = await positionModel.create({
    tokenAddress: address,
    symbol,
    entryPrice,
    entryAmountSol: positionSol,
    entryAmountTokens: safeNumber(quote.outAmount),
    entryScore: score,
    entryReason: `Live buy | Score: ${score.toFixed(1)} | Impact: ${quote.priceImpactPct.toFixed(2)}%`,
    entryTx: txResult.signature,
    holderCountAtEntry: overview?.holderCount || null,
    liquidityAtEntry: pair?.liquidityUsd || null,
    mode: config.tradingMode,
  });

  await statsModel.incrementTrades();
  await statsModel.incrementBought();

  // Release buy lock — position is created, lock served its purpose
  await risk.releaseTradeLock(address, 'buy');

  logger.info({ posId, address, symbol, positionSol, signature: txResult.signature }, 'Live buy executed');

  await telegram.sendAlert(
    `🟢 LIVE BUY: ${symbol}\n` +
    `Address: ${truncateAddress(address)}\n` +
    `Amount: ${formatSol(positionSol)} SOL\n` +
    `Score: ${score.toFixed(1)}\n` +
    `TX: ${txResult.signature}`
  );

  return { bought: true, positionId: posId, mode: config.tradingMode, signature: txResult.signature };
}

// ---- Exit Management ----

async function monitorPositions() {
  const openPositions = await positionModel.getOpen();
  if (openPositions.length === 0) return;

  for (const pos of openPositions) {
    try {
      await evaluateExit(pos);
    } catch (err) {
      logger.error({ err, posId: pos.id }, 'Exit evaluation error');
    }
  }
}

async function evaluateExit(pos) {
  // SAFETY: DB-backed lock — survives crash/restart.
  // If a lock already exists (from this tick or a crashed process), skip cleanly.
  const locked = await acquireExitLock(pos.id, 'evaluate');
  if (!locked) {
    logger.debug({ posId: pos.id }, 'Exit already in progress (DB lock), skipping');
    return;
  }

  try {
    const address = pos.token_address;

    // Get current price from DexScreener
    const cacheKey = `pairs:${address}`;
    let pairs = cache.get(cacheKey);
    if (!pairs) {
      pairs = await dexscreener.getTokenPairs(address);
      if (pairs && pairs.length > 0) {
        cache.set(cacheKey, pairs, TTL.MARKET_DATA);
      }
    }

    const pair = pairs && pairs.length > 0
      ? pairs.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
      : null;

    if (!pair) {
      logger.warn({ posId: pos.id, address }, 'Cannot get current price for position');
      return;
    }

    const currentPrice = pair.priceUsd;
    const entryPrice = pos.entry_price;
    const pnlPct = pctChange(entryPrice, currentPrice);
    const holdMinutes = minutesAgo(pos.entry_timestamp);

    await positionModel.updateCurrent(pos.id, currentPrice, pnlPct);

    // Check exit conditions
    const exitReason = checkExitConditions(pos, pair, pnlPct, holdMinutes);

    if (exitReason) {
      await executeExit(pos, pair, pnlPct, exitReason);
      return;
    }

    // Check partial exits
    await checkPartialExits(pos, pnlPct, pair);
  } finally {
    await releaseExitLock(pos.id, 'evaluate');
  }
}

function checkExitConditions(pos, pair, pnlPct, holdMinutes) {
  // Hard stop loss
  if (pnlPct <= -config.stopLossPct) {
    return `Stop loss at ${pnlPct.toFixed(1)}%`;
  }

  // Max hold time (4 hours)
  if (holdMinutes >= 240) {
    return `Max hold time: ${holdMinutes.toFixed(0)} min`;
  }

  // Liquidity drop > 25% from entry
  const liquidityAtEntry = pos.liquidity_at_entry || 0;
  if (liquidityAtEntry > 0 && pair.liquidityUsd < liquidityAtEntry * 0.75) {
    return `Liquidity dropped ${pctChange(liquidityAtEntry, pair.liquidityUsd).toFixed(0)}%`;
  }

  return null;
}

async function checkPartialExits(pos, pnlPct, pair) {
  const partials = pos.partial_exits || [];
  const exitedStages = new Set(partials.map((p) => p.stage));

  // Stage 1: +80% to +100%, sell 50%
  if (pnlPct >= 80 && !exitedStages.has('stage1')) {
    await executePartialExit(pos, pair, 0.50, 'stage1', `+${pnlPct.toFixed(0)}% — sell 50%`);
  }
  // Stage 2: +300%, sell 25%
  else if (pnlPct >= 300 && !exitedStages.has('stage2')) {
    await executePartialExit(pos, pair, 0.25, 'stage2', `+${pnlPct.toFixed(0)}% — sell 25%`);
  }
  // Stage 3: +500%, sell remaining
  else if (pnlPct >= 500 && !exitedStages.has('stage3')) {
    await executeExit(pos, pair, pnlPct, `+${pnlPct.toFixed(0)}% — final exit`);
  }
}

async function executePartialExit(pos, pair, fraction, stage, reason) {
  logger.info({ posId: pos.id, stage, fraction, reason }, 'Partial exit');

  // SAFETY: Acquire a stage-specific DB lock to prevent duplicate partial exits
  const partialLocked = await acquireExitLock(pos.id, `partial_${stage}`);
  if (!partialLocked) {
    logger.warn({ posId: pos.id, stage }, 'Partial exit lock exists, skipping duplicate');
    return;
  }

  let tx = `partial_${stage}_${Date.now()}`;
  let swapExecuted = false;

  if (config.canExecuteRealTrades() && pos.mode !== 'paper') {
    // SAFETY: Record intent BEFORE swap so incomplete partials are detectable on restart
    await positionModel.setPendingPartial(pos.id, {
      stage, fraction, reason, status: 'pending', startedAt: new Date().toISOString(),
    });

    try {
      const tokenAmount = Math.floor(pos.entry_amount_tokens * fraction);
      const quote = await jupiter.getQuote({
        inputMint: pos.token_address,
        outputMint: jupiter.SOL_MINT,
        amount: tokenAmount,
      });

      if (quote && quote.priceImpactPct < 10) {
        const swapResult = await jupiter.getSwapTransaction({
          quoteResponse: quote.raw,
          userPublicKey: wallet.getPublicKey(),
        });
        const txResult = await wallet.signAndSendTransaction(swapResult.swapTransaction);
        if (!txResult.success) {
          // Swap sent but not confirmed — mark pending_review, leave lock
          await positionModel.setPendingPartial(pos.id, {
            stage, fraction, reason, status: 'pending_review',
            signature: txResult.signature, startedAt: new Date().toISOString(),
          });
          logger.error({ posId: pos.id, stage, sig: txResult.signature }, 'Partial exit tx not confirmed');
          await telegram.sendAlert(`⚠️ PARTIAL EXIT PENDING: ${pos.symbol} (${stage}) — TX not confirmed`);
          return; // leave exit_lock in place for reconciliation
        }
        tx = txResult.signature || tx;
        swapExecuted = true;
      } else {
        // Quote null or slippage too high — no swap attempted
        logger.warn({ posId: pos.id, stage, impact: quote?.priceImpactPct }, 'Partial exit skipped — bad quote or high slippage');
      }
    } catch (err) {
      logger.error({ err, posId: pos.id, stage }, 'Partial exit swap failed');
      // Clear pending intent — swap never sent or outright failed
      await positionModel.clearPendingPartial(pos.id);
      await releaseExitLock(pos.id, `partial_${stage}`);
      return;
    }

    // Clear pending intent regardless of whether swap executed
    await positionModel.clearPendingPartial(pos.id);

    // If no real swap happened, do NOT record a partial exit
    if (!swapExecuted) {
      await releaseExitLock(pos.id, `partial_${stage}`);
      return;
    }
  } else {
    // Paper mode — synthetic partial exit is intentional
    swapExecuted = true;
  }

  await positionModel.addPartialExit(pos.id, {
    stage,
    fraction,
    reason,
    price: pair.priceUsd,
    tx,
    timestamp: new Date().toISOString(),
  });

  // Release the stage-specific lock now that the partial is recorded
  await releaseExitLock(pos.id, `partial_${stage}`);

  await telegram.sendAlert(
    `📊 PARTIAL EXIT: ${pos.symbol} (${stage})\n` +
    `Sold: ${(fraction * 100).toFixed(0)}%\n` +
    `Reason: ${reason}`
  );
}

async function executeExit(pos, pair, pnlPct, reason) {
  const address = pos.token_address;

  logger.info({ posId: pos.id, address, pnlPct: pnlPct.toFixed(1), reason }, 'Executing exit');

  let exitTx = `exit_${Date.now()}`;
  const exitPrice = pair ? pair.priceUsd : pos.current_price;
  const pnlSol = pos.entry_amount_sol * (pnlPct / 100);

  if (config.canExecuteRealTrades() && pos.mode !== 'paper') {
    try {
      // Calculate remaining tokens (account for partial exits)
      let remainingFraction = 1;
      const partials = pos.partial_exits || [];
      for (const p of partials) {
        remainingFraction -= p.fraction;
      }
      const tokenAmount = Math.floor(pos.entry_amount_tokens * Math.max(remainingFraction, 0));

      if (tokenAmount > 0) {
        const quote = await jupiter.getQuote({
          inputMint: address,
          outputMint: jupiter.SOL_MINT,
          amount: tokenAmount,
        });

        if (quote && safeNumber(quote.outAmount) > 0) {
          if (quote.priceImpactPct > 10) {
            logger.warn({ posId: pos.id, impact: quote.priceImpactPct }, 'High exit slippage');
          }
          const swapResult = await jupiter.getSwapTransaction({
            quoteResponse: quote.raw,
            userPublicKey: wallet.getPublicKey(),
          });
          const txResult = await wallet.signAndSendTransaction(swapResult.swapTransaction);
          if (txResult.success) {
            exitTx = txResult.signature;
          } else {
            // SAFETY: Persist exit TX signature BEFORE marking pending_review
            // so reconciler can check the actual exit TX, not the buy TX.
            if (txResult.signature) {
              await positionModel.setExitTx(pos.id, txResult.signature);
            }
            await positionModel.markPendingReview(pos.id);
            logger.error({ posId: pos.id, exitSig: txResult.signature }, 'Exit tx not confirmed — pending review');
            await telegram.sendAlert(`⚠️ EXIT PENDING: ${pos.symbol} — TX not confirmed`);
            return;
          }
        }
      }
    } catch (err) {
      logger.error({ err, posId: pos.id }, 'Exit swap failed');
      await positionModel.markPendingReview(pos.id);
      return;
    }
  }

  await positionModel.close(pos.id, {
    exitPrice,
    exitReason: reason,
    exitTx,
    finalPnlSol: pnlSol,
    finalPnlPct: pnlPct,
  });

  // Record outcome for risk management
  await risk.recordTradeOutcome(pnlSol, address);

  // Update daily stats
  if (pnlSol >= 0) {
    await statsModel.recordWin(pnlSol, pnlSol * (pair?.priceNative ? 1 / pair.priceNative : 0));
  } else {
    await statsModel.recordLoss(pnlSol, pnlSol * (pair?.priceNative ? 1 / pair.priceNative : 0));
  }

  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  await telegram.sendAlert(
    `${emoji} EXIT: ${pos.symbol}\n` +
    `Reason: ${reason}\n` +
    `PnL: ${formatSol(pnlSol)} SOL (${formatPct(pnlPct)})\n` +
    `Hold: ${minutesAgo(pos.entry_timestamp).toFixed(0)} min\n` +
    `TX: ${exitTx}`
  );

  logger.info({ posId: pos.id, pnlSol, pnlPct, reason }, 'Position closed');
}

module.exports = { tryBuy, monitorPositions };
