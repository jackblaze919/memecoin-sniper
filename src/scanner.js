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
    // Stage 1: Discover new tokens from DexScreener (two sources)
    const [profiles, boosted] = await Promise.all([
      dexscreener.getLatestTokenProfiles(),
      dexscreener.getLatestBoostedTokens(),
    ]);

    // Merge and deduplicate by address
    const seen = new Set();
    const allProfiles = [];
    for (const p of [...profiles, ...boosted]) {
      if (p.address && !seen.has(p.address)) {
        seen.add(p.address);
        allProfiles.push(p);
      }
    }

    let newCount = 0;
    let skippedNoPairs = 0;
    let skippedFilter = 0;

    for (const profile of allProfiles) {
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

      if (!pairs || pairs.length === 0) {
        skippedNoPairs++;
        continue;
      }

      // Use highest liquidity pair
      const pair = pairs.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      if (!pair) continue;

      // Apply inclusion filters
      const filterResult = checkInclusionFilter(pair);
      if (!filterResult.passed) {
        skippedFilter++;
        // Log first few rejections per tick for diagnostics
        if (skippedFilter <= 3) {
          logger.debug({
            address: profile.address,
            symbol: pair.symbol,
            reason: filterResult.reason,
            liquidity: pair.liquidityUsd,
            marketCap: pair.marketCapUsd,
            source: profile.source || 'profiles',
          }, 'Candidate rejected by inclusion filter');
        }
        continue;
      }

      candidates.set(profile.address, {
        address: profile.address,
        pair,
        addedAt: Date.now(),
        lastRefreshed: Date.now(),
      });
      newCount++;
    }

    logger.info({
      profileCount: profiles.length,
      boostedCount: boosted.length,
      merged: allProfiles.length,
      newCandidates: newCount,
      skippedNoPairs,
      skippedFilter,
    }, 'Discovery complete');

    // Refresh existing candidates
    await refreshCandidates();

    // Evict to stay under cap
    evictExcess();

    // Persist to DB and update stats
    await persistCandidates();
    await stats.incrementScanned(candidates.size);

    logger.info({ totalCandidates: candidates.size }, 'Scanner tick complete');

    // One-time Telegram alert on first successful scan showing discovery results
    if (!scan._firstScanSent) {
      const telegram = require('./telegram');
      await telegram.sendAlert(
        `🔍 SCANNER: profiles=${profiles.length} boosted=${boosted.length} → ` +
        `${newCount} new candidates (${skippedFilter} filtered, ${skippedNoPairs} no pairs)\n` +
        `Total in-memory: ${candidates.size}`
      );
      scan._firstScanSent = true;
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Scanner tick error');
    // One-time alert on scan failure
    if (!scan._firstScanSent) {
      const telegram = require('./telegram');
      await telegram.sendAlert(`❌ SCANNER FAILED: ${err.message}`).catch(() => {});
      scan._firstScanSent = true;
    }
  }

  return getCandidateList();
}

/**
 * Check inclusion filter and return { passed, reason }.
 * Reason is a short string explaining why the token was rejected.
 *
 * Paper mode uses relaxed thresholds so the pipeline can be validated.
 * Tokens with enough liq+mcap are almost always > 72h old; tokens
 * young enough (< 72h) rarely have $25k+ liquidity. The combination
 * creates a deadlock where zero tokens pass. Paper mode widens the
 * net so we can evaluate the scoring and exit strategy.
 */
function checkInclusionFilter(pair) {
  if (!pair.pairCreatedAt) return { passed: false, reason: 'no_created_at' };

  const isPaper = config.tradingMode === 'paper';
  const minLiq = isPaper ? 10000 : config.minLiquidityUsd;      // $10k paper, $25k live
  const minMcap = isPaper ? 25000 : 50000;                       // $25k paper, $50k live
  const maxAgeH = isPaper ? 336 : config.maxTokenAgeHours;       // 14d paper, config live

  const ageMinutes = minutesAgo(pair.pairCreatedAt);

  if (ageMinutes < config.minTokenAgeMinutes)
    return { passed: false, reason: `too_young: ${ageMinutes.toFixed(0)}m < ${config.minTokenAgeMinutes}m` };

  if (pair.liquidityUsd < minLiq)
    return { passed: false, reason: `low_liq: $${pair.liquidityUsd.toFixed(0)} < $${minLiq}` };

  if (pair.marketCapUsd < minMcap)
    return { passed: false, reason: `low_mcap: $${pair.marketCapUsd.toFixed(0)} < $${minMcap.toLocaleString()}` };

  const ageHours = ageMinutes / 60;
  if (ageHours > maxAgeH)
    return { passed: false, reason: `too_old: ${ageHours.toFixed(0)}h > ${maxAgeH}h` };

  return { passed: true, reason: null };
}

// Backward-compatible wrapper used by refreshCandidates
function passesInclusionFilter(pair) {
  return checkInclusionFilter(pair).passed;
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
