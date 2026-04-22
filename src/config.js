require('dotenv').config();
const { execSync } = require('child_process');

const VALID_MODES = ['scanner', 'paper', 'tiny_live', 'live'];

// Experiment versioning — bump these when scoring logic changes materially
const STRATEGY_VERSION = '2.2';   // 2.0 = DexScreener-primary, 2.1 = flow-deterioration, 2.2 = $100k liq floor
const RANKER_VERSION = '2.1';     // tracks ranker.js scoring changes

// Git commit hash (best-effort, cached at startup)
let GIT_COMMIT = 'unknown';
try { GIT_COMMIT = execSync('git rev-parse --short HEAD', { timeout: 2000 }).toString().trim(); } catch (_) {}

// Single mutable config object. All helper functions read from this same object.
// No spread-export — Telegram mode changes affect the same instance all code uses.
const config = {
  // Database
  databaseUrl: process.env.DATABASE_URL,

  // Solana
  heliusApiKey: process.env.HELIUS_API_KEY,
  birdeyeApiKey: process.env.BIRDEYE_API_KEY,
  jupiterApiKey: process.env.JUPITER_API_KEY,
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,

  // Notifications
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  resendApiKey: process.env.RESEND_API_KEY,
  reportEmail: process.env.REPORT_EMAIL,

  // Trading
  tradingMode: process.env.TRADING_MODE || 'scanner',
  dryRun: process.env.DRY_RUN !== 'false',

  // Limits
  maxTradesPerHour: parseInt(process.env.MAX_TRADES_PER_HOUR, 10) || 5,
  maxPositionSol: parseFloat(process.env.MAX_POSITION_SOL) || 0.05,
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS, 10) || 3,
  dailyLossLimitSol: parseFloat(process.env.DAILY_LOSS_LIMIT_SOL) || 0.1,
  solReserve: parseFloat(process.env.SOL_RESERVE) || 0.05,
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT) || 30,

  // Scanner
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD) || 100000,
  minHolderCount: parseInt(process.env.MIN_HOLDER_COUNT, 10) || 100,
  minTokenAgeMinutes: parseInt(process.env.MIN_TOKEN_AGE_MINUTES, 10) || 240,
  maxTokenAgeHours: parseInt(process.env.MAX_TOKEN_AGE_HOURS, 10) || 24,
  buyScoreThreshold: parseFloat(process.env.BUY_SCORE_THRESHOLD) || 70,
  maxActiveCandidates: parseInt(process.env.MAX_ACTIVE_CANDIDATES, 10) || 50,

  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
};

// Attach constants and functions directly to the config object
// so all code that does require('./config').tradingMode and
// require('./config').isLiveMode() reads the same mutable state.
config.VALID_MODES = VALID_MODES;

config.validate = function validate() {
  if (!VALID_MODES.includes(config.tradingMode)) {
    throw new Error(`Invalid TRADING_MODE: ${config.tradingMode}. Must be one of: ${VALID_MODES.join(', ')}`);
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if ((config.tradingMode === 'tiny_live' || config.tradingMode === 'live') && !config.solanaPrivateKey) {
    throw new Error('SOLANA_PRIVATE_KEY is required for live trading modes');
  }
  return true;
};

config.isLiveMode = function isLiveMode() {
  return config.tradingMode === 'tiny_live' || config.tradingMode === 'live';
};

config.canExecuteRealTrades = function canExecuteRealTrades() {
  return config.isLiveMode() && !config.dryRun;
};

config.getMaxPositionSol = function getMaxPositionSol() {
  if (config.tradingMode === 'paper') return config.maxPositionSol;
  if (config.tradingMode === 'tiny_live') return 0.01;
  if (config.tradingMode === 'live') return config.maxPositionSol;
  return 0; // scanner mode — no trades
};

config.getMaxConcurrentPositions = function getMaxConcurrentPositions() {
  if (config.tradingMode === 'tiny_live') return 1;
  return config.maxConcurrentPositions;
};

// Experiment metadata — read-only, attached to each trade for analysis
config.strategyVersion = STRATEGY_VERSION;
config.rankerVersion = RANKER_VERSION;
config.gitCommit = GIT_COMMIT;
config.flowDeteriorationEnabled = true; // set to false if the penalty is removed

module.exports = config;
