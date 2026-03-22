const config = require('../config');
const logger = require('../logger');
const { retry, fetchWithTimeout } = require('../utils');

const BASE_URL = 'https://public-api.birdeye.so';

async function request(path, label) {
  if (!config.birdeyeApiKey) {
    throw new Error('BIRDEYE_API_KEY not configured');
  }
  return retry(async () => {
    const url = `${BASE_URL}${path}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'application/json',
        'X-API-KEY': config.birdeyeApiKey,
        'x-chain': 'solana',
      },
    }, 20000);
    if (res.status === 429) {
      // Rate limited — throw with explicit label so retry backoff kicks in
      throw new Error(`Birdeye ${label} 429: rate limited`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Birdeye ${label} ${res.status}: ${text.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data.success && data.success !== undefined) {
      throw new Error(`Birdeye ${label} returned success=false`);
    }
    return data.data || data;
  }, { maxRetries: 3, baseDelay: 3000, label: `birdeye:${label}` });
}

// GET /defi/token_overview?address={TOKEN}
async function getTokenOverview(address) {
  try {
    const data = await request(`/defi/token_overview?address=${address}`, 'overview');
    return normalizeOverview(data);
  } catch (err) {
    logger.error({ err, address }, 'Birdeye getTokenOverview failed');
    return null;
  }
}

// GET /defi/token_security?address={TOKEN}
async function getTokenSecurity(address) {
  try {
    const data = await request(`/defi/token_security?address=${address}`, 'security');
    return normalizeSecurity(data);
  } catch (err) {
    logger.error({ err, address }, 'Birdeye getTokenSecurity failed');
    return null;
  }
}

// GET /defi/token_holder?address={TOKEN}
async function getTokenHolders(address) {
  try {
    const data = await request(`/defi/token_holder?address=${address}`, 'holders');
    return normalizeHolders(data);
  } catch (err) {
    logger.error({ err, address }, 'Birdeye getTokenHolders failed');
    return null;
  }
}

// Quick test that the API key works
async function testApiKey() {
  // Use SOL token overview as a test
  const data = await request(
    '/defi/token_overview?address=So11111111111111111111111111111111111111112',
    'test'
  );
  return !!data;
}

function normalizeOverview(data) {
  if (!data) return null;
  return {
    address: data.address || null,
    symbol: data.symbol || null,
    name: data.name || null,
    price: parseFloat(data.price) || 0,
    priceChange30m: parseFloat(data.priceChange30mPercent) || 0,
    priceChange1h: parseFloat(data.priceChange1hPercent) || 0,
    priceChange24h: parseFloat(data.priceChange24hPercent) || 0,
    volume24h: parseFloat(data.v24hUSD) || 0,
    volume1h: parseFloat(data.v1hUSD) || 0,
    volume30m: parseFloat(data.v30mUSD) || 0,
    liquidity: parseFloat(data.liquidity) || 0,
    marketCap: parseFloat(data.mc) || parseFloat(data.realMc) || 0,
    holderCount: data.holder != null ? parseInt(data.holder) : null,
    // Trade counts — field names may vary, guard accordingly
    buy30m: parseInt(data.buy30m) || 0,
    sell30m: parseInt(data.sell30m) || 0,
    buy1h: parseInt(data.buy1h) || 0,
    sell1h: parseInt(data.sell1h) || 0,
    uniqueBuy30m: parseInt(data.uniqueWallet30m) || parseInt(data.uniqueBuy30m) || 0,
    uniqueSell30m: parseInt(data.uniqueWalletSell30m) || parseInt(data.uniqueSell30m) || 0,
    trade30m: parseInt(data.trade30m) || 0,
    trade1h: parseInt(data.trade1h) || 0,
    raw: data,
  };
}

function normalizeSecurity(data) {
  if (!data) return null;
  return {
    // These field names are based on Birdeye v3 — guard for null
    freezeAuthority: data.freezeAuthority ?? null,
    mintAuthority: data.mintAuthority ?? null,
    isToken2022: data.isToken2022 ?? false,
    transferFeeEnable: data.transferFeeEnable ?? null,
    // Top10 holder percentage
    top10HolderPercent: parseFloat(data.top10HolderPercent) || null,
    top10HolderBalance: parseFloat(data.top10HolderBalance) || null,
    totalSupply: parseFloat(data.totalSupply) || null,
    // Creator info
    creatorAddress: data.creatorAddress || null,
    creatorBalance: parseFloat(data.creatorBalance) || null,
    creatorPercentage: parseFloat(data.creatorPercentage) || null,
    // LP info
    lpBurned: data.lpBurned ?? null,
    raw: data,
  };
}

function normalizeHolders(data) {
  if (!data) return null;
  // data might be { items: [...], total: N } or just an array
  const items = Array.isArray(data) ? data : (data.items || []);
  const total = data.total || items.length;
  return {
    total,
    items: items.slice(0, 20).map((h) => ({
      address: h.address || h.owner || null,
      amount: parseFloat(h.uiAmount || h.amount) || 0,
      percentage: parseFloat(h.percentage) || 0,
    })),
  };
}

module.exports = {
  getTokenOverview,
  getTokenSecurity,
  getTokenHolders,
  testApiKey,
};
