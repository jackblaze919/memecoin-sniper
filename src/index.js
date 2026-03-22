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
// health.runAll() can take 60+ seconds if APIs are rate-limited.
// Use a 10s timeout: if health checks hang, return last-known status.
let lastHealthResult = { healthy: true, note: 'initial' };
app.get('/health', async (req, res) => {
  try {
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), 10000)
    );
    const result = await Promise.race([health.runAll(), timeout]);
    if (result) {
      lastHealthResult = result;
      res.status(result.healthy ? 200 : 503).json(result);
    } else {
      // Health checks timed out — return last-known status
      res.status(lastHealthResult.healthy ? 200 : 503).json({
        ...lastHealthResult,
        note: 'Health check timed out — returning cached result',
      });
    }
  } catch (err) {
    res.status(500).json({ healthy: false, error: err.message });
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

    logger.fatal({ failedRequired }, 'Required health checks failed');
    await telegram.sendAlert(
      `❌ Required health checks failed:\n${failedRequired.join('\n')}`
    ).catch(() => {});
    process.exit(1);
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
