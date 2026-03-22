const express = require('express');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const health = require('./health');
const telegram = require('./telegram');
const scheduler = require('./scheduler');
const reconciler = require('./reconciler');
const { cache } = require('./cache');

const app = express();
app.use(express.json());

// Health endpoint — must respond fast for Railway's health probe.
// CRITICAL: In paper/scanner mode, ALWAYS return 200 to prevent
// Railway from killing the process. API outages are transient and
// the scheduler has its own error handling.
let lastHealthResult = { healthy: true, note: 'initial' };
app.get('/health', async (req, res) => {
  try {
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), 10000)
    );
    const result = await Promise.race([health.runAll(), timeout]);
    if (result) {
      lastHealthResult = result;
    }
    const payload = result || { ...lastHealthResult, note: 'Health check timed out' };
    // Paper/scanner mode: always 200 so Railway doesn't restart us
    const httpStatus = config.isLiveMode() ? (payload.healthy ? 200 : 503) : 200;
    res.status(httpStatus).json(payload);
  } catch (err) {
    // Even on error, return 200 in non-live mode
    const httpStatus = config.isLiveMode() ? 500 : 200;
    res.status(httpStatus).json({ healthy: false, error: err.message, mode: config.tradingMode });
  }
});

// Basic status
app.get('/', (req, res) => {
  res.json({
    name: 'memecoin-sniper',
    mode: config.tradingMode,
    dryRun: config.dryRun,
    uptime: process.uptime(),
  });
});

async function startup() {
  logger.info({ mode: config.tradingMode, dryRun: config.dryRun }, 'Starting memecoin-sniper');

  // Validate config
  try {
    config.validate();
  } catch (err) {
    logger.fatal({ err }, 'Config validation failed');
    process.exit(1);
  }

  // Initialize Telegram
  telegram.init();

  // Run health checks
  logger.info('Running startup health checks...');
  const healthResult = await health.runAll();

  for (const [name, check] of Object.entries(healthResult.checks)) {
    if (check.ok) {
      logger.info({ check: name }, 'Health check passed');
    } else {
      logger.error({ check: name, error: check.error, note: check.note }, 'Health check failed');
    }
  }

  if (!healthResult.healthy) {
    const failedRequired = Object.entries(healthResult.checks)
      .filter(([name, c]) => !c.ok && healthResult.required.includes(name))
      .map(([name, c]) => `${name}: ${c.error || c.note}`);

    if (config.isLiveMode()) {
      // Live mode: fail-closed — do not start with broken dependencies
      logger.fatal({ failedRequired }, 'Required health checks failed — exiting (live mode)');
      await telegram.sendAlert(
        `❌ Required health checks failed:\n${failedRequired.join('\n')}`
      ).catch(() => {});
      process.exit(1);
    } else {
      // Paper/scanner mode: warn and continue — the scheduler has its own
      // error handling. Crashing here causes Railway restart loops.
      logger.error({ failedRequired }, 'Required health checks failed — continuing anyway (non-live mode)');
      await telegram.sendAlert(
        `⚠️ Health checks failed but continuing in ${config.tradingMode} mode:\n${failedRequired.join('\n')}`
      ).catch(() => {});
    }
  } else {
    // Log non-required checks that failed (informational)
    const optionalFailed = Object.entries(healthResult.checks)
      .filter(([name, c]) => !c.ok && !healthResult.required.includes(name));
    if (optionalFailed.length > 0) {
      for (const [name, c] of optionalFailed) {
        logger.warn({ check: name, error: c.error }, 'Optional health check failed');
      }
    }
    if (healthResult.degraded) {
      logger.warn('Health: DEGRADED — soft-required checks failed, running with cached data');
      await telegram.sendAlert(
        `⚠️ DEGRADED: Birdeye temporarily unavailable. Paper mode continues with cached data.`
      ).catch(() => {});
    }
    logger.info({ required: healthResult.required }, 'All required health checks passed');
    await telegram.sendAlert(`✅ Memecoin Sniper started in ${config.tradingMode} mode`);
  }

  // Start Express
  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Express server listening');
  });

  // Reconcile any pending_review positions from prior crash/restart
  try {
    await reconciler.reconcile();
  } catch (err) {
    logger.error({ err }, 'Startup reconciliation failed — continuing');
  }

  // Clean stranded buy locks from previous crash/restart cycles
  const risk = require('./risk');
  try {
    await risk.cleanStrandedBuyLocks();
  } catch (err) {
    logger.error({ err }, 'Stranded lock cleanup failed — continuing');
  }

  // Close stale paper positions that were never properly exited.
  // Previous crash/restart cycles left paper positions "open" indefinitely,
  // blocking new buys (max_concurrent_positions: 3/3).
  if (config.tradingMode === 'paper') {
    try {
      const positionModel = require('./models/position');
      const stale = await positionModel.getOpen();
      if (stale.length > 0) {
        for (const pos of stale) {
          await positionModel.close(pos.id, {
            exitPrice: pos.current_price || pos.entry_price || 0,
            exitReason: 'Stale paper position closed on startup',
            exitTx: 'startup_cleanup_' + Date.now(),
            finalPnlSol: 0,
            finalPnlPct: 0,
          });
        }
        logger.info({ count: stale.length }, 'Closed stale paper positions on startup');
        await telegram.sendAlert(`🧹 Closed ${stale.length} stale paper position(s) from previous session`);
      }
    } catch (err) {
      logger.error({ err }, 'Stale position cleanup failed — continuing');
    }
  }

  // Start scheduler
  scheduler.start();
}

// Graceful shutdown
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  scheduler.stop();
  telegram.shutdown();
  cache.shutdown();
  await db.shutdown();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('exit', (code) => {
  // This fires synchronously just before the process exits.
  // Cannot do async work here, but can log.
  console.log(`PROCESS EXIT code=${code} uptime=${process.uptime().toFixed(0)}s`);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  // Log but do NOT exit. The bot should try to self-heal.
  // Previous behavior called shutdown() → process.exit(0), causing
  // Railway to restart the bot on every transient error (Telegram
  // polling hiccup, DB connection drop, etc.).
  logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception (continuing)');
});
process.on('unhandledRejection', (err) => {
  logger.error({ err: err?.message || err, stack: err?.stack }, 'Unhandled rejection');
});

startup().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
