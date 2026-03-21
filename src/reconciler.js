const logger = require('./logger');
const config = require('./config');
const helius = require('./apis/helius');
const positionModel = require('./models/position');
const telegram = require('./telegram');
const db = require('./db');

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

// Run on startup and periodically to resolve ambiguous transaction states.
async function reconcile() {
  if (config.tradingMode === 'scanner' || config.tradingMode === 'paper') return;

  await reconcilePendingReviewPositions();
  await reconcilePendingPartials();
  await cleanStaleExitLocks();
}

// 1. Positions stuck in pending_review (buy or full exit tx unconfirmed)
async function reconcilePendingReviewPositions() {
  const pending = await positionModel.getPendingReview();
  if (pending.length === 0) return;

  logger.info({ count: pending.length }, 'Reconciling pending_review positions');

  for (const pos of pending) {
    try {
      const tx = pos.exit_tx || pos.entry_tx;
      if (!tx || tx.startsWith('paper_') || tx.startsWith('exit_') || tx.startsWith('partial_')) {
        // Synthetic TX — cannot check on-chain. Alert operator.
        await alertStale(pos, 'Synthetic TX — cannot verify on-chain');
        continue;
      }

      const txInfo = await helius.getTransaction(tx);

      if (!txInfo) {
        // TX not found on-chain. Check age.
        const age = Date.now() - new Date(pos.entry_timestamp).getTime();
        if (age > STALE_THRESHOLD_MS) {
          await alertStale(pos, `TX ${tx.substring(0, 12)}... not found after ${Math.round(age / 60000)}min`);
        }
        continue;
      }

      // TX found — check if it succeeded
      const err = txInfo.meta?.err;
      if (err) {
        // TX failed on-chain. If this was a buy, mark closed (tokens never received).
        // If exit, revert to open so exit can be retried.
        if (!pos.exit_tx || pos.exit_tx === pos.entry_tx) {
          // Failed buy
          await positionModel.close(pos.id, {
            exitPrice: 0, exitReason: 'Buy TX failed on-chain', exitTx: tx,
            finalPnlSol: -pos.entry_amount_sol, finalPnlPct: -100,
          });
          logger.info({ posId: pos.id }, 'Reconciled: buy TX failed, position closed');
        } else {
          // Failed exit — revert to open for retry
          await db.query(`UPDATE positions SET status = 'open' WHERE id = $1`, [pos.id]);
          await releaseExitLockSafe(pos.id);
          logger.info({ posId: pos.id }, 'Reconciled: exit TX failed, position reopened');
        }
        await telegram.sendAlert(`🔄 RECONCILED: ${pos.symbol} (pos ${pos.id}) — TX failed on-chain`);
        continue;
      }

      // TX succeeded on-chain
      if (!pos.exit_tx || pos.exit_tx === pos.entry_tx) {
        // Confirmed buy — mark open
        await db.query(`UPDATE positions SET status = 'open' WHERE id = $1`, [pos.id]);
        logger.info({ posId: pos.id }, 'Reconciled: buy TX confirmed, position open');
      } else {
        // Confirmed exit — was already partially handled, just clear status
        await db.query(`UPDATE positions SET status = 'closed' WHERE id = $1`, [pos.id]);
        await releaseExitLockSafe(pos.id);
        logger.info({ posId: pos.id }, 'Reconciled: exit TX confirmed, position closed');
      }
      await telegram.sendAlert(`🔄 RECONCILED: ${pos.symbol} (pos ${pos.id}) — TX confirmed on-chain`);
    } catch (err) {
      logger.error({ err, posId: pos.id }, 'Reconciliation error for position');
    }
  }
}

// 2. Partial exits stuck in pending_review status
async function reconcilePendingPartials() {
  const positions = await positionModel.getWithPendingPartials();
  if (positions.length === 0) return;

  logger.info({ count: positions.length }, 'Reconciling pending partial exits');

  for (const pos of positions) {
    try {
      const intent = pos.pending_partial;
      if (!intent || !intent.signature) {
        // No signature — swap may never have been sent
        const age = Date.now() - new Date(intent.startedAt).getTime();
        if (age > STALE_THRESHOLD_MS) {
          await positionModel.clearPendingPartial(pos.id);
          await releaseExitLockSafe(pos.id);
          await telegram.sendAlert(
            `⚠️ STALE PARTIAL cleared: ${pos.symbol} (${intent.stage}) — no signature, ${Math.round(age / 60000)}min old`
          );
        }
        continue;
      }

      const txInfo = await helius.getTransaction(intent.signature);

      if (!txInfo) {
        const age = Date.now() - new Date(intent.startedAt).getTime();
        if (age > STALE_THRESHOLD_MS) {
          await positionModel.clearPendingPartial(pos.id);
          await releaseExitLockSafe(pos.id);
          await telegram.sendAlert(
            `⚠️ PARTIAL TX not found: ${pos.symbol} (${intent.stage}) — cleared after ${Math.round(age / 60000)}min`
          );
        }
        continue;
      }

      const err = txInfo.meta?.err;
      if (err) {
        // Partial swap failed — clear intent, release lock
        await positionModel.clearPendingPartial(pos.id);
        await releaseExitLockSafe(pos.id);
        logger.info({ posId: pos.id, stage: intent.stage }, 'Partial exit TX failed on-chain, cleared');
      } else {
        // Partial swap confirmed — record the partial exit and clear intent
        await positionModel.addPartialExit(pos.id, {
          stage: intent.stage,
          fraction: intent.fraction,
          reason: intent.reason,
          price: null, // price at time of reconciliation unknown
          tx: intent.signature,
          timestamp: new Date().toISOString(),
          reconciled: true,
        });
        await positionModel.clearPendingPartial(pos.id);
        await releaseExitLockSafe(pos.id);
        logger.info({ posId: pos.id, stage: intent.stage }, 'Partial exit TX confirmed, recorded');
        await telegram.sendAlert(`🔄 PARTIAL RECONCILED: ${pos.symbol} (${intent.stage}) — confirmed on-chain`);
      }
    } catch (err) {
      logger.error({ err, posId: pos.id }, 'Partial reconciliation error');
    }
  }
}

// 3. Clean exit_locks that survived a crash but have no matching pending state
async function cleanStaleExitLocks() {
  try {
    const result = await db.query(`
      SELECT el.position_id, el.lock_type, el.created_at
      FROM exit_locks el
      LEFT JOIN positions p ON p.id = el.position_id
      WHERE el.created_at < NOW() - INTERVAL '15 minutes'
        AND (p.status IS NULL OR p.status NOT IN ('pending_review'))
        AND (p.pending_partial IS NULL OR p.pending_partial->>'status' NOT IN ('pending_review', 'pending'))
    `);
    for (const row of result.rows) {
      await db.query(`DELETE FROM exit_locks WHERE position_id = $1 AND lock_type = $2`, [row.position_id, row.lock_type]);
      logger.warn({ positionId: row.position_id, lockType: row.lock_type }, 'Cleaned stale exit lock');
    }
  } catch (err) {
    logger.error({ err }, 'Error cleaning stale exit locks');
  }
}

async function releaseExitLockSafe(positionId) {
  try {
    await db.query(`DELETE FROM exit_locks WHERE position_id = $1`, [positionId]);
  } catch (err) {
    logger.warn({ err, positionId }, 'Failed to release exit lock during reconciliation');
  }
}

async function alertStale(pos, detail) {
  const msg = `⚠️ STALE pending_review: ${pos.symbol} (pos ${pos.id}) — ${detail}`;
  logger.warn({ posId: pos.id }, msg);
  await telegram.sendAlert(msg).catch(() => {});
}

module.exports = { reconcile };
