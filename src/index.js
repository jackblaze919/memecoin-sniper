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
    const status = result.healthy ? 200 : 503;
    res.status(status).json(result);
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
    // Log soft-required checks that failed (degraded but not fatal)
    const softFailed = Object.entries(healthResult.checks)
      .filter(([name, c]) => !c.ok && (healthResult.softRequired || []).includes(name));
    if (softFailed.length > 0) {
      for (const [name, c] of softFailed) {
        logger.warn({ check: name, error: c.error }, 'Soft-required health check failed — degraded mode');
      }
    }
    // Log non-required checks that failed (informational)
    const optionalFailed = Object.entries(healthResult.checks)
      .filter(([name, c]) => !c.ok && !healthResult.required.includes(name) && !(healthResult.softRequired || []).includes(name));
    if (optionalFailed.length > 0) {
      for (const [name, c] of optionalFailed) {
        logger.warn({ check: name, error: c.error }, 'Optional health check failed');
      }
    }
    const startMsg = healthResult.degraded
      ? `⚠️ Memecoin Sniper started in ${config.tradingMode} mode (degraded — ${softFailed.map(([n]) => n).join(', ')} unavailable)`
      : `✅ Memecoin Sniper started in ${config.tradingMode} mode`;
    logger.info({ required: healthResult.required, degraded: healthResult.degraded }, 'Health checks passed');
    await telegram.sendAlert(startMsg);
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
