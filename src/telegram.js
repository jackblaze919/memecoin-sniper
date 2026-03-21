const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logger = require('./logger');
const positionModel = require('./models/position');
const statsModel = require('./models/stats');
const { formatSol, formatPct, formatUsd, truncateAddress } = require('./utils');

let bot = null;
let started = false;

function init() {
  if (!config.telegramBotToken) {
    logger.warn('Telegram bot token not configured — commands disabled');
    return;
  }
  bot = new TelegramBot(config.telegramBotToken, { polling: true });
  registerCommands();
  started = true;
  logger.info('Telegram bot initialized');
}

function registerCommands() {
  bot.onText(/\/status/, handleStatus);
  bot.onText(/\/stop/, handleStop);
  bot.onText(/\/start/, handleStart);
  bot.onText(/\/mode(?:\s+(.+))?/, handleMode);
  bot.onText(/\/positions/, handlePositions);
  bot.onText(/\/history/, handleHistory);
  bot.onText(/\/balance/, handleBalance);
  bot.onText(/\/stats/, handleStats);
  bot.onText(/\/config/, handleConfig);
  bot.onText(/\/health/, handleHealth);
  bot.onText(/\/candidates/, handleCandidates);

  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Telegram polling error');
  });
}

function isAuthorized(msg) {
  return String(msg.chat.id) === String(config.telegramChatId);
}

async function handleStatus(msg) {
  if (!isAuthorized(msg)) return;
  try {
    const openPositions = await positionModel.getOpen();
    const todayStats = await statsModel.getToday();
    const mode = config.tradingMode;
    const dryRun = config.dryRun;
    const pausedUntil = await statsModel.getState('paused_until');
    const consecutiveLosses = await statsModel.getState('consecutive_losses');

    let text = `📊 Bot Status\n`;
    text += `Mode: ${mode} | DRY_RUN: ${dryRun}\n`;
    text += `Open positions: ${openPositions.length}\n`;
    text += `Today trades: ${todayStats?.total_trades || 0}\n`;
    text += `Today PnL: ${formatSol(todayStats?.total_pnl_sol || 0)} SOL\n`;
    text += `Consecutive losses: ${consecutiveLosses || 0}\n`;
    if (pausedUntil && pausedUntil !== null && new Date(pausedUntil) > new Date()) {
      text += `⏸️ Paused until: ${pausedUntil}\n`;
    }
    await reply(msg.chat.id, text);
  } catch (err) {
    await reply(msg.chat.id, `Error: ${err.message}`);
  }
}

async function handleStop(msg) {
  if (!isAuthorized(msg)) return;
  const until = new Date(Date.now() + 24 * 3600000).toISOString();
  await statsModel.setState('paused_until', until);
  await reply(msg.chat.id, `⏸️ Bot paused until ${until}`);
  logger.info('Bot paused via Telegram /stop');
}

async function handleStart(msg) {
  if (!isAuthorized(msg)) return;
  await statsModel.setState('paused_until', null);
  await reply(msg.chat.id, '▶️ Bot resumed');
  logger.info('Bot resumed via Telegram /start');
}

async function handleMode(msg, match) {
  if (!isAuthorized(msg)) return;
  const newMode = match[1]?.trim();
  if (!newMode) {
    await reply(msg.chat.id, `Current mode: ${config.tradingMode}`);
    return;
  }
  if (!config.VALID_MODES.includes(newMode)) {
    await reply(msg.chat.id, `Invalid mode. Valid: ${config.VALID_MODES.join(', ')}`);
    return;
  }

  // SAFETY: Block runtime escalation to live trading modes.
  // Switching to tiny_live/live requires proper health checks, wallet verification,
  // and monitor loop startup that only happen at boot. Require env var change + restart.
  if (newMode === 'tiny_live' || newMode === 'live') {
    await reply(msg.chat.id,
      `Switching to ${newMode} via Telegram is blocked for safety.\n` +
      `Set TRADING_MODE=${newMode} in env vars and restart the bot.\n` +
      `This ensures health checks, wallet balance, and monitor loops are verified.`
    );
    logger.warn({ newMode }, 'Blocked runtime escalation to live mode via Telegram');
    return;
  }

  const oldMode = config.tradingMode;
  config.tradingMode = newMode;
  await statsModel.setState('trading_mode', newMode);

  // If switching from scanner to paper, notify that monitor loop needs restart
  if (oldMode === 'scanner' && newMode === 'paper') {
    await reply(msg.chat.id,
      `Mode changed to: ${newMode}\n` +
      `Note: position monitor loop was not started at boot (started in scanner mode).\n` +
      `Restart the bot in paper mode for full functionality.`
    );
  } else {
    await reply(msg.chat.id, `Mode changed to: ${newMode}`);
  }
  logger.info({ oldMode, newMode }, 'Trading mode changed via Telegram');
}

async function handlePositions(msg) {
  if (!isAuthorized(msg)) return;
  const positions = await positionModel.getOpen();
  if (positions.length === 0) {
    await reply(msg.chat.id, 'No open positions');
    return;
  }
  let text = '📈 Open Positions:\n\n';
  for (const p of positions) {
    text += `${p.symbol} | ${formatPct(p.current_pnl_pct)} | `;
    text += `${formatSol(p.entry_amount_sol)} SOL | `;
    text += `${truncateAddress(p.token_address)}\n`;
  }
  await reply(msg.chat.id, text);
}

async function handleHistory(msg) {
  if (!isAuthorized(msg)) return;
  const positions = await positionModel.getRecent(10);
  if (positions.length === 0) {
    await reply(msg.chat.id, 'No trade history');
    return;
  }
  let text = '📜 Recent Trades:\n\n';
  for (const p of positions) {
    const emoji = (p.final_pnl_sol || 0) >= 0 ? '🟢' : '🔴';
    text += `${emoji} ${p.symbol} | ${formatPct(p.final_pnl_pct)} | `;
    text += `${p.exit_reason || p.status}\n`;
  }
  await reply(msg.chat.id, text);
}

async function handleBalance(msg) {
  if (!isAuthorized(msg)) return;
  try {
    let text = '💰 Balance: ';
    if (config.solanaPrivateKey) {
      const wallet = require('./wallet');
      const balance = await wallet.getBalance();
      text += `${formatSol(balance)} SOL`;
    } else {
      text += 'Wallet not configured';
    }
    await reply(msg.chat.id, text);
  } catch (err) {
    await reply(msg.chat.id, `Error: ${err.message}`);
  }
}

async function handleStats(msg) {
  if (!isAuthorized(msg)) return;
  const s = await statsModel.getToday();
  if (!s) {
    await reply(msg.chat.id, 'No stats for today');
    return;
  }
  const winRate = s.total_trades > 0 ? ((s.wins / s.total_trades) * 100).toFixed(1) : '0';
  let text = `📊 Today's Stats:\n`;
  text += `Trades: ${s.total_trades} (W:${s.wins} L:${s.losses})\n`;
  text += `Win Rate: ${winRate}%\n`;
  text += `PnL: ${formatSol(s.total_pnl_sol)} SOL\n`;
  text += `Scanned: ${s.tokens_scanned} | Bought: ${s.tokens_bought}\n`;
  text += `Birdeye CUs: ${s.birdeye_cus_used}`;
  await reply(msg.chat.id, text);
}

async function handleConfig(msg) {
  if (!isAuthorized(msg)) return;
  let text = `⚙️ Config:\n`;
  text += `Mode: ${config.tradingMode}\n`;
  text += `DRY_RUN: ${config.dryRun}\n`;
  text += `Max position: ${config.getMaxPositionSol()} SOL\n`;
  text += `Max concurrent: ${config.getMaxConcurrentPositions()}\n`;
  text += `Max trades/hr: ${config.maxTradesPerHour}\n`;
  text += `Daily loss limit: ${config.dailyLossLimitSol} SOL\n`;
  text += `Stop loss: ${config.stopLossPct}%\n`;
  text += `Buy threshold: ${config.buyScoreThreshold}\n`;
  text += `SOL reserve: ${config.solReserve}`;
  await reply(msg.chat.id, text);
}

async function handleHealth(msg) {
  if (!isAuthorized(msg)) return;
  try {
    const health = require('./health');
    const result = await health.runAll();
    let text = '🏥 Health Check:\n';
    for (const [check, status] of Object.entries(result.checks)) {
      text += `${status.ok ? '✅' : '❌'} ${check}\n`;
    }
    text += `\nOverall: ${result.healthy ? '✅ Healthy' : '❌ Unhealthy'}`;
    await reply(msg.chat.id, text);
  } catch (err) {
    await reply(msg.chat.id, `Error: ${err.message}`);
  }
}

async function handleCandidates(msg) {
  if (!isAuthorized(msg)) return;
  try {
    const tokenModel = require('./models/token');
    const candidates = await tokenModel.getCandidates(10);
    if (candidates.length === 0) {
      await reply(msg.chat.id, 'No candidates');
      return;
    }
    const isScannerMode = config.tradingMode === 'scanner';
    let text = isScannerMode
      ? '🔍 Discovered Candidates (not ranked in scanner mode):\n\n'
      : '🔍 Top Candidates:\n\n';
    for (const c of candidates) {
      if (isScannerMode) {
        // Scanner mode: show discovery data only — scores are not computed
        text += `${c.symbol || '?'} | Liq: ${formatUsd(c.liquidity_usd)} | `;
        text += `MCap: ${formatUsd(c.market_cap_usd)}\n`;
      } else {
        text += `${c.symbol || '?'} | Score: ${(c.total_score || 0).toFixed(1)} | `;
        text += `Liq: ${formatUsd(c.liquidity_usd)} | `;
        text += `${c.safety_gate_passed ? '✅' : '❌'} safe`;
        // Show why safety gate failed
        if (!c.safety_gate_passed && c.data?.safetyDetails) {
          const s = c.data.safetyDetails;
          const reasons = [];
          if (s.missingData?.length > 0) reasons.push(`missing: ${s.missingData.join(',')}`);
          if (s.freezeAuthorityInactive === false) reasons.push('freeze auth');
          if (s.mintAuthorityInactive === false) reasons.push('mint auth');
          if (s.top10Pct !== null && s.top10Pct > 40) reasons.push(`top10: ${s.top10Pct}%`);
          if (s.lpControlled === true) reasons.push('LP controlled');
          if (s.holderCount !== null && s.holderCount < config.minHolderCount) reasons.push(`holders: ${s.holderCount}`);
          if (s.slippageOk === false) reasons.push('slippage');
          if (s.hasTransferFee === true) reasons.push('transfer fee');
          if (reasons.length > 0) text += ` (${reasons.join(', ')})`;
        }
        text += '\n';
      }
    }
    await reply(msg.chat.id, text);
  } catch (err) {
    await reply(msg.chat.id, `Error: ${err.message}`);
  }
}

async function reply(chatId, text) {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    logger.error({ err }, 'Telegram send failed');
  }
}

async function sendAlert(text) {
  if (!bot || !config.telegramChatId) {
    logger.debug({ text }, 'Telegram alert (not sent — bot not configured)');
    return;
  }
  try {
    await bot.sendMessage(config.telegramChatId, text);
  } catch (err) {
    logger.error({ err }, 'Telegram alert failed');
  }
}

async function testSend() {
  if (!bot || !config.telegramChatId) {
    throw new Error('Telegram not configured');
  }
  await bot.sendMessage(config.telegramChatId, '🤖 Memecoin Sniper health check');
  return true;
}

function shutdown() {
  if (bot && started) {
    bot.stopPolling();
    started = false;
  }
}

module.exports = { init, sendAlert, testSend, shutdown };
