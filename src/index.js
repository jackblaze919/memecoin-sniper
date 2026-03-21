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

// Health endpoint
app.get('/health', async (req, res) => {
  try {
    const result = await health.runAll();
    res.status(result.healthy ? 200 : 503).json(result);
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
    const failedChecks = Object.entries(healthResult.checks)
      .filter(([, c]) => !c.ok)
      .map(([name, c]) => `${name}: ${c.error || c.note}`);

    logger.error({ failedChecks }, 'Startup health checks failed');

    await telegram.sendAlert(
      `❌ Startup health checks failed:\n${failedChecks.join('\n')}`
    ).catch(() => {});

    // In scanner mode, allow startup with just DB + DexScreener
    if (config.tradingMode === 'scanner') {
      const dbOk = healthResult.checks.database?.ok;
      const dexOk = healthResult.checks.dexscreener?.ok;
      if (dbOk && dexOk) {
        logger.warn('Scanner mode — proceeding with partial health');
      } else {
        logger.fatal('Cannot start even in scanner mode — DB or DexScreener down');
        process.exit(1);
      }
    } else {
      logger.fatal('Cannot start trading bot with failed health checks');
      process.exit(1);
    }
  } else {
    logger.info('All health checks passed');
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
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});

startup().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
