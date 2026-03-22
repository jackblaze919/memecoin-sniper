const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const jupiter = require('./apis/jupiter');
const dexscreener = require('./apis/dexscreener');
const birdeye = require('./apis/birdeye');
const telegram = require('./telegram');

async function runAll() {
  const checks = {};

  // 1. PostgreSQL
  checks.database = await checkDatabase();

  // 2. Wallet balance (only if private key configured)
  checks.wallet = await checkWallet();

  // 3. Jupiter quote
  checks.jupiter = await checkJupiter();

  // 4. DexScreener
  checks.dexscreener = await checkDexScreener();

  // 5. Birdeye API
  checks.birdeye = await checkBirdeye();

  // 6. Telegram
  checks.telegram = await checkTelegram();

  // 7. Config
  checks.config = checkConfig();

  // Only checks required for the current mode determine overall health.
  // Scanner needs DB + DexScreener. Paper adds Birdeye (ranker). Live needs everything.
  //
  // Paper mode: Birdeye is SOFT-REQUIRED — if it's down, health is "degraded"
  // not "unhealthy". The ranker uses stale cache as fallback, so paper mode
  // continues functioning. Live/tiny_live: Birdeye is hard-required.
  const HARD_REQUIRED = {
    scanner:   ['database', 'dexscreener', 'config'],
    paper:     ['database', 'dexscreener', 'config'],
    tiny_live: ['database', 'wallet', 'jupiter', 'dexscreener', 'birdeye', 'telegram', 'config'],
    live:      ['database', 'wallet', 'jupiter', 'dexscreener', 'birdeye', 'telegram', 'config'],
  };
  const SOFT_REQUIRED = {
    scanner:   [],
    paper:     ['birdeye'],
    tiny_live: [],
    live:      [],
  };

  const hardRequired = HARD_REQUIRED[config.tradingMode] || HARD_REQUIRED.live;
  const softRequired = SOFT_REQUIRED[config.tradingMode] || [];
  const hardHealthy = hardRequired.every((name) => checks[name]?.ok);
  const softHealthy = softRequired.every((name) => checks[name]?.ok);

  // Tag soft-failed checks as degraded rather than failed
  for (const name of softRequired) {
    if (checks[name] && !checks[name].ok) {
      checks[name].degraded = true;
      checks[name].note = 'Temporarily unavailable — using cached/stale data if available';
    }
  }

  const healthy = hardHealthy;
  const degraded = hardHealthy && !softHealthy;

  return { healthy, degraded, checks, required: hardRequired, softRequired };
}

async function checkDatabase() {
  try {
    await db.testConnection();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkWallet() {
  if (!config.solanaPrivateKey) {
    if (config.isLiveMode()) {
      return { ok: false, error: 'Wallet not configured for live mode' };
    }
    return { ok: true, note: 'Wallet not needed for scanner/paper mode' };
  }
  try {
    const wallet = require('./wallet');
    const balance = await wallet.getBalance();
    if (balance < config.solReserve) {
      return { ok: false, error: `Balance ${balance} SOL < reserve ${config.solReserve} SOL` };
    }
    return { ok: true, balance };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkJupiter() {
  try {
    const quote = await jupiter.testQuote();
    if (!quote || !quote.outAmount || quote.outAmount === '0') {
      return { ok: false, error: 'Invalid quote response' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkDexScreener() {
  try {
    const results = await dexscreener.search('SOL');
    if (!results || results.length === 0) {
      return { ok: false, error: 'No search results' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkBirdeye() {
  if (!config.birdeyeApiKey) {
    return { ok: false, error: 'BIRDEYE_API_KEY not set' };
  }
  try {
    const ok = await birdeye.testApiKey();
    return { ok };
  } catch (err) {
    // Report the failure but also check if we have any cached Birdeye data
    const { cache } = require('./cache');
    const cacheSize = cache.size();
    return {
      ok: false,
      error: err.message,
      hasCachedData: cacheSize > 0,
      note: cacheSize > 0
        ? `API unreachable but ${cacheSize} cached entries available`
        : 'API unreachable and no cached data',
    };
  }
}

async function checkTelegram() {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return { ok: false, error: 'Telegram not configured' };
  }
  try {
    await telegram.testSend();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkConfig() {
  try {
    config.validate();
    return { ok: true, mode: config.tradingMode };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { runAll };
