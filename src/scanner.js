const config = require('./config');
const logger = require('./logger');
const dexscreener = require('./apis/dexscreener');
const tokenModel = require('./models/token');
const positionModel = require('./models/position');
const stats = require('./models/stats');
const { cache, TTL } = require('./cache');
const { minutesAgo, hoursAgo } = require('./utils');

// In-memory candidate universe
let candidates = new Map();

async function scan() {
  logger.info({ candidateCount: candidates.size }, 'Scanner tick starting');

  try {
    // Stage 1: Discover new tokens from DexScreener
    const profiles = await dexscreener.getLatestTokenProfiles();
    let newCount = 0;

    for (const profile of profiles) {
      if (!profile.address) continue;
      if (candidates.has(profile.address)) continue;

      // Fetch pair data for this token
      const cacheKey = `pairs:${profile.address}`;
      let pairs = cache.get(cacheKey);
      if (!pairs) {
        pairs = await dexscreener.getTokenPairs(profile.address);
        if (pairs.length > 0) {
          cache.set(cacheKey, pairs, TTL.MARKET_DATA);
        }
      }

      if (!pairs || pairs.length === 0) continue;

      // Use highest liquidity pair
      const pair = pairs.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      if (!pair) continue;

      // Apply inclusion filters
      if (!passesInclusionFilter(pair)) continue;

      candidates.set(profile.address, {
        address: profile.address,
        pair,
        addedAt: Date.now(),
        lastRefreshed: Date.now(),
      });
      newCount++;
    }

    if (newCount > 0) {
      logger.info({ newCount }, 'New candidates discovered');
    }

    // Refresh existing candidates
    await refreshCandidates();

    // Evict to stay under cap
    evictExcess();

    // Persist to DB and update stats
    await persistCandidates();
    await stats.incrementScanned(candidates.size);

    logger.info({ totalCandidates: candidates.size }, 'Scanner tick complete');
  } catch (err) {
    logger.error({ err }, 'Scanner tick error');
  }

  return getCandidateList();
}

function passesInclusionFilter(pair) {
  if (!pair.pairCreatedAt) return false;

  const ageMinutes = minutesAgo(pair.pairCreatedAt);

  // Too young
  if (ageMinutes < config.minTokenAgeMinutes) return false;

  // Liquidity floor
  if (pair.liquidityUsd < config.minLiquidityUsd) return false;

  // Market cap floor
  if (pair.marketCapUsd < 50000) return false;

  // Preferred age < 24h, allow up to 72h for re-acceleration
  const ageHours = ageMinutes / 60;
  if (ageHours > 72) return false;

  return true;
}

async function refreshCandidates() {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 min

  for (const [address, candidate] of candidates) {
    if (now - candidate.lastRefreshed < staleThreshold) continue;

    try {
      const pairs = await dexscreener.getTokenPairs(address);
      if (!pairs || pairs.length === 0) {
        candidates.delete(address);
        continue;
      }
      const pair = pairs.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];

      // Re-check inclusion
      if (!passesInclusionFilter(pair)) {
        candidates.delete(address);
        continue;
      }

      // Check if already in open position
      const openPos = await positionModel.getOpenByToken(address);
      if (openPos) {
        candidates.delete(address);
        continue;
      }

      candidate.pair = pair;
      candidate.lastRefreshed = now;
      cache.set(`pairs:${address}`, pairs, TTL.MARKET_DATA);
    } catch (err) {
      logger.warn({ err, address }, 'Failed to refresh candidate');
    }
  }
}

function evictExcess() {
  if (candidates.size <= config.maxActiveCandidates) return;

  // Sort by quality (liquidity * volume proxy) descending, keep top N
  const sorted = [...candidates.entries()]
    .sort((a, b) => {
      const scoreA = (a[1].pair?.liquidityUsd || 0) * (a[1].pair?.volume1h || 0);
      const scoreB = (b[1].pair?.liquidityUsd || 0) * (b[1].pair?.volume1h || 0);
      return scoreB - scoreA;
    });

  const toKeep = new Set(sorted.slice(0, config.maxActiveCandidates).map(([addr]) => addr));
  for (const [addr] of candidates) {
    if (!toKeep.has(addr)) candidates.delete(addr);
  }
}

async function persistCandidates() {
  for (const [address, candidate] of candidates) {
    const pair = candidate.pair;
    if (!pair) continue;
    try {
      await tokenModel.upsert({
        address,
        symbol: pair.symbol,
        name: pair.name,
        pairAddress: pair.pairAddress,
        liquidityUsd: pair.liquidityUsd,
        marketCapUsd: pair.marketCapUsd,
        priceUsd: pair.priceUsd,
        volume24h: pair.volume24h,
        data: {
          volume1h: pair.volume1h,
          txnsBuys1h: pair.txnsBuys1h,
          txnsSells1h: pair.txnsSells1h,
          priceChangeH1: pair.priceChangeH1,
          pairCreatedAt: pair.pairCreatedAt,
        },
      });
    } catch (err) {
      logger.warn({ err, address }, 'Failed to persist candidate');
    }
  }
}

function getCandidateList() {
  return [...candidates.values()].map((c) => ({
    address: c.address,
    symbol: c.pair?.symbol,
    name: c.pair?.name,
    liquidityUsd: c.pair?.liquidityUsd,
    marketCapUsd: c.pair?.marketCapUsd,
    volume1h: c.pair?.volume1h,
    priceChangeH1: c.pair?.priceChangeH1,
    ageMinutes: c.pair?.pairCreatedAt ? minutesAgo(c.pair.pairCreatedAt) : null,
  }));
}

function getCandidateMap() {
  return candidates;
}

module.exports = { scan, getCandidateList, getCandidateMap };
