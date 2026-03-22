const config = require('./config');
const logger = require('./logger');
const birdeye = require('./apis/birdeye');
const helius = require('./apis/helius');
const jupiter = require('./apis/jupiter');
const tokenModel = require('./models/token');
const stats = require('./models/stats');
const { cache, TTL } = require('./cache');
const { safeNumber, pctChange, clamp } = require('./utils');

// Run ranker on all current candidates
async function rank(candidateMap) {
  const results = [];
  let errors = 0;
  for (const [address, candidate] of candidateMap) {
    try {
      const result = await scoreCandidate(address, candidate);
      results.push(result);
    } catch (err) {
      errors++;
      logger.error({ err: err.message, address, symbol: candidate?.pair?.symbol }, 'Ranker error for candidate');
    }
  }
  if (errors > 0) {
    logger.warn({ errors, total: candidateMap.size, scored: results.length }, 'Ranker had scoring errors');
  }
  // Sort by total score descending
  results.sort((a, b) => b.totalScore - a.totalScore);
  return results;
}

async function scoreCandidate(address, candidate) {
  const pair = candidate.pair;

  // -- Pre-scoring safety gate --
  const safety = await runSafetyGate(address);
  const safetyGatePassed = safety.passed;

  // -- Fetch Birdeye overview for scoring --
  const overviewKey = `overview:${address}`;
  let overview = cache.get(overviewKey);
  let overviewStale = false;
  if (!overview) {
    overview = await birdeye.getTokenOverview(address);
    if (overview) {
      cache.set(overviewKey, overview, TTL.HOLDER_COUNT);
      await stats.incrementBirdeyeCus(1);
    } else {
      // Fresh fetch failed — try stale cache as fallback
      const stale = cache.getStale(overviewKey);
      if (stale) {
        overview = stale.value;
        overviewStale = true;
        logger.warn({ address, ageMs: stale.ageMs }, 'Birdeye overview: using stale cache (fresh fetch failed)');
      }
    }
  }

  // -- Compute scores --
  const discoveryScore = computeDiscoveryScore(pair, overview);
  const flowScore = computeFlowScore(pair, overview);
  const mispricingScore = computeMispricingScore(pair, overview);
  const safetyScore = computeSafetyScore(safety);

  const totalScore =
    discoveryScore * 0.30 +
    flowScore * 0.30 +
    mispricingScore * 0.20 +
    safetyScore * 0.20;

  // -- Anti-FOMO check --
  const antiFomo = checkAntiFomo(pair, overview);

  // Persist scores
  await tokenModel.upsert({
    address,
    symbol: pair?.symbol,
    name: pair?.name,
    pairAddress: pair?.pairAddress,
    totalScore,
    discoveryScore,
    flowScore,
    mispricingScore,
    safetyScore,
    antiFomoRejected: antiFomo.rejected,
    antiFomoReason: antiFomo.reason,
    safetyGatePassed,
    holderCount: overview?.holderCount || safety.holderCount || null,
    liquidityUsd: pair?.liquidityUsd,
    marketCapUsd: pair?.marketCapUsd,
    priceUsd: pair?.priceUsd,
    volume24h: pair?.volume24h,
    data: {
      safetyDetails: safety,
      discoveryScore,
      flowScore,
      mispricingScore,
      safetyScore,
    },
  });

  const result = {
    address,
    symbol: pair?.symbol,
    totalScore,
    discoveryScore,
    flowScore,
    mispricingScore,
    safetyScore,
    safetyGatePassed,
    antiFomoRejected: antiFomo.rejected,
    antiFomoReason: antiFomo.reason,
    buyEligible: totalScore >= config.buyScoreThreshold && safetyGatePassed && !antiFomo.rejected,
    holderCount: overview?.holderCount || safety.holderCount,
    liquidityUsd: pair?.liquidityUsd,
    pair,
    overview,
    safety,
  };

  logger.info({
    address,
    symbol: pair?.symbol,
    totalScore: totalScore.toFixed(1),
    buyEligible: result.buyEligible,
    safetyGatePassed,
    safetyMissingData: safety.missingData,
    safetyFreeze: safety.freezeAuthorityInactive,
    safetyMint: safety.mintAuthorityInactive,
    safetyTop10: safety.top10Pct,
    safetyHolders: safety.holderCount,
    safetyLP: safety.lpControlled,
    safetySlippage: safety.slippageOk,
    safetyTransferFee: safety.hasTransferFee,
    antiFomo: antiFomo.rejected ? antiFomo.reason : 'pass',
  }, 'Candidate scored');

  return result;
}

// ---- Safety Gate ----

async function runSafetyGate(address) {
  const result = {
    passed: false,
    freezeAuthorityInactive: null,
    mintAuthorityInactive: null,
    top10Pct: null,
    holderCount: null,
    lpControlled: null,
    slippageOk: null,
    hasTransferFee: null,
    missingData: [],
  };

  // 1. Check freeze/mint authority via Helius
  // SAFETY: If account info is null (network error, bad address, rate limit),
  // we MUST treat authority as unknown and fail the safety gate.
  // On Solana, null authority in parsed data = no authority = safe.
  // But null accountInfo = we couldn't check = unsafe to assume.
  const authKey = `auth:${address}`;
  let authInfo = cache.get(authKey);
  if (!authInfo) {
    const accountInfo = await helius.getAccountInfo(address);
    if (!accountInfo) {
      // Could not retrieve account info — mark as unparsed
      authInfo = { parsed: false, mintAuthority: null, freezeAuthority: null };
    } else {
      authInfo = helius.parseMintAuthority(accountInfo);
    }
    cache.set(authKey, authInfo, TTL.AUTHORITY_CHECK);
  }

  if (!authInfo.parsed) {
    // Could not determine authority state — fail safe, block buys
    result.missingData.push('authority');
  } else {
    result.freezeAuthorityInactive = authInfo.freezeAuthority === null;
    result.mintAuthorityInactive = authInfo.mintAuthority === null;
  }

  // 2. Check top10 holders via Birdeye security
  const secKey = `security:${address}`;
  let security = cache.get(secKey);
  if (!security) {
    security = await birdeye.getTokenSecurity(address);
    if (security) {
      cache.set(secKey, security, TTL.TOP_HOLDERS);
      await stats.incrementBirdeyeCus(1);
    } else {
      // Stale fallback — security is already optional in evaluateSafetyGate,
      // but stale data is better than no data for the optional checks
      const staleSec = cache.getStale(secKey);
      if (staleSec && !staleSec.value._negativeCached) {
        security = staleSec.value;
        logger.warn({ address, ageMs: staleSec.ageMs }, 'Birdeye security: using stale cache');
      } else {
        // Negative cache: the security endpoint likely requires a paid
        // Birdeye plan.  Cache the failure so we don't retry 50 × 3
        // retries = 150 wasted HTTP requests every 90-second rank tick.
        cache.set(secKey, { _negativeCached: true }, TTL.TOP_HOLDERS);
        security = null;
      }
    }
  }

  // A negative-cache sentinel is not real security data
  if (security && !security._negativeCached) {
    result.top10Pct = security.top10HolderPercent;
    result.hasTransferFee = security.transferFeeEnable || false;
    result.lpControlled = security.creatorPercentage > 30 ? true : false;
  } else {
    result.missingData.push('security');
  }

  // 3. Holder count via Birdeye overview
  const overviewKeyGate = `overview:${address}`;
  let overviewGate = cache.get(overviewKeyGate);
  if (!overviewGate) {
    overviewGate = await birdeye.getTokenOverview(address);
    if (overviewGate) {
      cache.set(overviewKeyGate, overviewGate, TTL.HOLDER_COUNT);
      await stats.incrementBirdeyeCus(1);
    } else {
      // Stale fallback — overview is REQUIRED by evaluateSafetyGate.
      // Using stale data prevents a temporary Birdeye outage from
      // blocking all candidates for the entire scan cycle.
      const staleOv = cache.getStale(overviewKeyGate);
      if (staleOv) {
        overviewGate = staleOv.value;
        logger.warn({ address, ageMs: staleOv.ageMs }, 'Birdeye overview (safety gate): using stale cache');
      }
    }
  }

  if (overviewGate) {
    result.holderCount = overviewGate.holderCount;
  } else {
    result.missingData.push('overview');
  }

  // 4. Slippage check via Jupiter quote (only in paper/live modes)
  if (config.tradingMode !== 'scanner') {
    const slipKey = `slippage:${address}`;
    let slippage = cache.get(slipKey);
    if (slippage === null) {
      try {
        const lamports = Math.floor(config.getMaxPositionSol() * 1e9) || 10_000_000;
        const quote = await jupiter.getQuote({
          inputMint: jupiter.SOL_MINT,
          outputMint: address,
          amount: lamports,
        });
        slippage = quote ? quote.priceImpactPct : null;
        cache.set(slipKey, slippage, TTL.SLIPPAGE);
      } catch (err) {
        logger.warn({ err, address }, 'Slippage check failed');
        slippage = null;
      }
    }
    result.slippageOk = slippage !== null ? slippage < 5 : null;
    if (slippage === null) result.missingData.push('slippage');
  } else {
    result.slippageOk = true; // Skip in scanner mode
  }

  // Evaluate gate
  result.passed = evaluateSafetyGate(result);
  return result;
}

function evaluateSafetyGate(g) {
  // Required data: authority check (Helius) — must always be verified.
  // Optional data (skip if missing, don't auto-fail):
  //   - 'security': Birdeye token_security requires paid tier
  //   - 'overview':  Birdeye token_overview may be degraded/stale;
  //                  holderCount check at line below handles null gracefully
  //   - 'slippage': Jupiter quote may be temporarily unavailable
  // Only 'authority' is a hard requirement — without it we can't verify
  // freeze/mint authority, which is the most critical safety check.
  const OPTIONAL_DATA = new Set(['security', 'overview', 'slippage']);
  const requiredMissing = g.missingData.filter((d) => !OPTIONAL_DATA.has(d));
  if (requiredMissing.length > 0) return false;

  // Freeze authority must be inactive (null = no authority = safe)
  if (g.freezeAuthorityInactive === false) return false;

  // Mint authority must be inactive
  if (g.mintAuthorityInactive === false) return false;

  // Top 10 holders must be <= 40% (only if security data available)
  if (g.top10Pct !== null && g.top10Pct > 40) return false;

  // LP not effectively controlled by one wallet (only if security data available)
  if (g.lpControlled === true) return false;

  // Holder count >= configured minimum
  if (g.holderCount !== null && g.holderCount < config.minHolderCount) return false;

  // Slippage acceptable
  if (g.slippageOk === false) return false;

  // No transfer fee surprises (only if security data available)
  if (g.hasTransferFee === true) return false;

  return true;
}

// ---- Scoring Functions ----

function computeDiscoveryScore(pair, overview) {
  // Holder growth, maker count growth, volume growth
  let score = 50; // baseline

  if (overview) {
    // Holder growth proxy: higher holder count relative to age = better
    const holderCount = overview.holderCount || 0;
    if (holderCount > 500) score += 15;
    else if (holderCount > 200) score += 10;
    else if (holderCount > 100) score += 5;

    // Volume growth: compare 30m volume to 1h/2 as baseline
    const vol30m = overview.volume30m || 0;
    const vol1hHalf = (overview.volume1h || 0) / 2;
    if (vol1hHalf > 0 && vol30m > vol1hHalf * 1.2) {
      score += 15; // accelerating
    } else if (vol1hHalf > 0 && vol30m > vol1hHalf) {
      score += 8;
    }
  }

  if (pair) {
    // Maker count growth proxy: buys in 5m as share of 1h buys
    const buys5m = pair.txnsBuys5m || 0;
    const buys1h = pair.txnsBuys1h || 0;
    if (buys1h > 0) {
      const ratio = (buys5m * 12) / buys1h; // annualized to 1h
      if (ratio > 1.5) score += 15;
      else if (ratio > 1.0) score += 8;
    }
  }

  return clamp(score, 0, 100);
}

function computeFlowScore(pair, overview) {
  let score = 50;

  if (pair) {
    // Buy/sell ratio over 1h
    const buys = pair.txnsBuys1h || 0;
    const sells = pair.txnsSells1h || 0;
    if (sells > 0) {
      const ratio = buys / sells;
      if (ratio > 2.0) score += 20;
      else if (ratio > 1.5) score += 15;
      else if (ratio > 1.2) score += 8;
      else if (ratio < 0.8) score -= 15;
    } else if (buys > 5) {
      score += 15; // all buys, no sells
    }
  }

  if (overview) {
    // Unique buyers vs sellers
    const uniqueBuyers = overview.uniqueBuy30m || 0;
    const uniqueSellers = overview.uniqueSell30m || 0;
    if (uniqueSellers > 0) {
      const ratio = uniqueBuyers / uniqueSellers;
      if (ratio > 2.0) score += 15;
      else if (ratio > 1.3) score += 8;
    } else if (uniqueBuyers > 3) {
      score += 10;
    }

    // Maker count rises with volume confirmation
    const trades30m = overview.trade30m || 0;
    const vol30m = overview.volume30m || 0;
    if (trades30m > 20 && vol30m > 5000) score += 10;
  }

  return clamp(score, 0, 100);
}

function computeMispricingScore(pair, overview) {
  let score = 50;

  if (pair && overview) {
    // Flow strength vs price response
    // High volume + many trades but price hasn't moved much = potential edge
    const vol1h = overview.volume1h || pair.volume1h || 0;
    const priceChange1h = Math.abs(pair.priceChangeH1 || overview.priceChange1h || 0);
    const liquidity = pair.liquidityUsd || overview.liquidity || 0;

    if (liquidity > 0 && vol1h > 0) {
      const volumeToLiqRatio = vol1h / liquidity;
      if (volumeToLiqRatio > 0.5 && priceChange1h < 50) {
        score += 20; // High relative volume, moderate price change
      } else if (volumeToLiqRatio > 0.3 && priceChange1h < 30) {
        score += 10;
      }
    }

    // Liquidity depth relative to buy pressure
    if (liquidity > 100000) score += 10;
    else if (liquidity > 50000) score += 5;
  }

  return clamp(score, 0, 100);
}

function computeSafetyScore(safety) {
  let score = 50;

  if (safety.freezeAuthorityInactive) score += 10;
  if (safety.mintAuthorityInactive) score += 10;

  // Improving concentration
  if (safety.top10Pct !== null) {
    if (safety.top10Pct < 20) score += 15;
    else if (safety.top10Pct < 30) score += 10;
    else if (safety.top10Pct < 40) score += 5;
  }

  // Liquidity stability (LP not controlled)
  if (safety.lpControlled === false) score += 10;

  // Slippage acceptable
  if (safety.slippageOk === true) score += 10;

  // No transfer fee
  if (safety.hasTransferFee === false) score += 5;

  return clamp(score, 0, 100);
}

// ---- Anti-FOMO ----

function checkAntiFomo(pair, overview) {
  const reasons = [];

  // Price already up > 200% in last hour
  const priceChangeH1 = pair?.priceChangeH1 || 0;
  if (priceChangeH1 > 200) {
    reasons.push(`Price up ${priceChangeH1.toFixed(0)}% in 1h`);
  }

  // Volume rising but holder count flat/down
  if (overview) {
    const vol1h = overview.volume1h || 0;
    const holderCount = overview.holderCount || 0;
    // If high volume but low holder count for the volume
    if (vol1h > 50000 && holderCount < 150) {
      reasons.push(`High volume ($${vol1h.toFixed(0)}) but only ${holderCount} holders`);
    }
  }

  // Buy/sell ratio high but maker count flat
  if (pair && overview) {
    const buys1h = pair.txnsBuys1h || 0;
    const sells1h = pair.txnsSells1h || 0;
    const trades30m = overview.trade30m || 0;
    if (sells1h > 0 && buys1h / sells1h > 3 && trades30m < 10) {
      reasons.push('High buy/sell ratio but low unique trade count');
    }
  }

  return {
    rejected: reasons.length > 0,
    reason: reasons.join('; ') || null,
  };
}

module.exports = { rank, scoreCandidate };
