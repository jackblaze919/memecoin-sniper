const logger = require('../logger');
const { retry, fetchWithTimeout } = require('../utils');

const BASE_URL = 'https://api.dexscreener.com';

async function request(path, label) {
  return retry(async () => {
    const url = `${BASE_URL}${path}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json' },
    }, 10000);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DexScreener ${label} ${res.status}: ${text.substring(0, 200)}`);
    }
    return res.json();
  }, { maxRetries: 3, baseDelay: 1000, label: `dexscreener:${label}` });
}

// GET /token-profiles/latest/v1 — newest token profiles
async function getLatestTokenProfiles() {
  try {
    const data = await request('/token-profiles/latest/v1', 'latestProfiles');
    // Filter to Solana tokens only
    if (!Array.isArray(data)) return [];
    return data
      .filter((t) => t.chainId === 'solana' && t.tokenAddress)
      .map((t) => ({
        address: t.tokenAddress,
        chainId: t.chainId,
        description: t.description || null,
        icon: t.icon || null,
        links: t.links || [],
      }));
  } catch (err) {
    logger.error({ err }, 'DexScreener getLatestTokenProfiles failed');
    return [];
  }
}

// GET /tokens/v1/solana/{address} — token pair data
async function getTokenPairs(tokenAddress) {
  try {
    const data = await request(`/tokens/v1/solana/${tokenAddress}`, 'tokenPairs');
    if (!Array.isArray(data)) return [];
    return data.map(normalizePair);
  } catch (err) {
    logger.error({ err, tokenAddress }, 'DexScreener getTokenPairs failed');
    return [];
  }
}

// GET /token-boosts/latest/v1 — recently boosted tokens (higher activity)
async function getLatestBoostedTokens() {
  try {
    const data = await request('/token-boosts/latest/v1', 'boostedTokens');
    if (!Array.isArray(data)) return [];
    return data
      .filter((t) => t.chainId === 'solana' && t.tokenAddress)
      .map((t) => ({
        address: t.tokenAddress,
        chainId: t.chainId,
        description: t.description || null,
        icon: t.icon || null,
        links: t.links || [],
        source: 'boosted',
      }));
  } catch (err) {
    logger.error({ err }, 'DexScreener getLatestBoostedTokens failed');
    return [];
  }
}

// GET /latest/dex/pairs/solana/{pairAddress}
async function getPairByAddress(pairAddress) {
  try {
    const data = await request(`/latest/dex/pairs/solana/${pairAddress}`, 'pair');
    if (!data || !data.pairs || data.pairs.length === 0) return null;
    return normalizePair(data.pairs[0]);
  } catch (err) {
    logger.error({ err, pairAddress }, 'DexScreener getPairByAddress failed');
    return null;
  }
}

// GET /latest/dex/search?q={query}
async function search(query) {
  try {
    const data = await request(`/latest/dex/search?q=${encodeURIComponent(query)}`, 'search');
    if (!data || !Array.isArray(data.pairs)) return [];
    return data.pairs
      .filter((p) => p.chainId === 'solana')
      .map(normalizePair);
  } catch (err) {
    logger.error({ err, query }, 'DexScreener search failed');
    return [];
  }
}

function normalizePair(pair) {
  if (!pair) return null;
  const baseToken = pair.baseToken || {};
  const txns = pair.txns || {};
  const h1 = txns.h1 || {};
  const h24 = txns.h24 || {};
  const m5 = txns.m5 || {};
  const priceChange = pair.priceChange || {};

  return {
    pairAddress: pair.pairAddress || null,
    tokenAddress: baseToken.address || null,
    symbol: baseToken.symbol || null,
    name: baseToken.name || null,
    priceUsd: parseFloat(pair.priceUsd) || 0,
    priceNative: parseFloat(pair.priceNative) || 0,
    liquidityUsd: pair.liquidity ? parseFloat(pair.liquidity.usd) || 0 : 0,
    marketCapUsd: parseFloat(pair.marketCap) || parseFloat(pair.fdv) || 0,
    volume24h: pair.volume ? parseFloat(pair.volume.h24) || 0 : 0,
    volume1h: pair.volume ? parseFloat(pair.volume.h1) || 0 : 0,
    volume5m: pair.volume ? parseFloat(pair.volume.m5) || 0 : 0,
    pairCreatedAt: pair.pairCreatedAt || null,
    // Transaction counts
    txnsBuys1h: h1.buys || 0,
    txnsSells1h: h1.sells || 0,
    txnsBuys24h: h24.buys || 0,
    txnsSells24h: h24.sells || 0,
    txnsBuys5m: m5.buys || 0,
    txnsSells5m: m5.sells || 0,
    // Price changes
    priceChangeH1: parseFloat(priceChange.h1) || 0,
    priceChangeH24: parseFloat(priceChange.h24) || 0,
    priceChangeM5: parseFloat(priceChange.m5) || 0,
    // Raw for extended analysis
    raw: pair,
  };
}

module.exports = {
  getLatestTokenProfiles,
  getLatestBoostedTokens,
  getTokenPairs,
  getPairByAddress,
  search,
};
