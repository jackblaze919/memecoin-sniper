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

  const healthy = Object.values(checks).every((c) => c.ok);

  return { healthy, checks };
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
    return { ok: false, error: err.message };
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
