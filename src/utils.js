const logger = require('./logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry with exponential backoff
async function retry(fn, { maxRetries = 3, baseDelay = 1000, label = 'operation' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn({ attempt, maxRetries, delay, label, error: err.message }, 'Retrying');
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function minutesAgo(date) {
  return (Date.now() - new Date(date).getTime()) / 60000;
}

function hoursAgo(date) {
  return minutesAgo(date) / 60;
}

function pctChange(from, to) {
  if (!from || from === 0) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeNumber(val, fallback = 0) {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

function truncateAddress(addr) {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatSol(amount) {
  return safeNumber(amount).toFixed(4);
}

function formatPct(pct) {
  return safeNumber(pct).toFixed(1) + '%';
}

function formatUsd(amount) {
  return '$' + safeNumber(amount).toFixed(2);
}

module.exports = {
  sleep,
  retry,
  fetchWithTimeout,
  todayDate,
  minutesAgo,
  hoursAgo,
  pctChange,
  clamp,
  safeNumber,
  truncateAddress,
  formatSol,
  formatPct,
  formatUsd,
};
