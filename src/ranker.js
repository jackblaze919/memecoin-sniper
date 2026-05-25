const { PublicKey } = require('@solana/web3.js');
const config = require('./config');
const logger = require('./logger');
const birdeye = require('./apis/birdeye');
const helius = require('./apis/helius');
const jupiter = require('./apis/jupiter');
const tokenModel = require('./models/token');
const stats = require('./models/stats');
const { cache, TTL } = require('./cache');
const { safeNumber, pctChange, clamp, minutesAgo } = require('./utils');

// Well-known program IDs for LP/pool account filtering
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

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
  const safety = await runSafetyGate(address, pair?.pairAddress);
  const safetyGatePassed = safety.passed;

  // -- Birdeye overview (optional enrichment, NOT required for scoring) --
  // If Birdeye works, it adds holder count for the safety gate.
  // If it doesn't, scoring uses DexScreener data exclusively.
  const overviewKey = `overview:${address}`;
  let overview = cache.get(overviewKey);
  if (!overview) {
    overview = await birdeye.getTokenOverview(address);
    if (overview) {
      cache.set(overviewKey, overview, TTL.HOLDER_COUNT);
      await stats.incrementBirdeyeCus(1);
    } else {
      const stale = cache.getStale(overviewKey);
      if (stale && !stale.value?._negativeCached) {
        overview = stale.value;
      } else {
        cache.set(overviewKey, { _negativeCached: true }, TTL.HOLDER_COUNT);
        overview = null;
      }
    }
  }
  if (overview && overview._negativeCached) overview = null;

  // -- Compute scores (DexScreener-primary, Birdeye-bonus) --
  const discoveryScore = computeDiscoveryScore(pair, overview);
  const flowScore = computeFlowScore(pair, overview);
  const mispricingScore = computeMispricingScore(pair, overview);
  const safetyScore = computeSafetyScore(safety);

  const totalScore =
    discoveryScore * 0.25 +
    flowScore * 0.30 +
    mispricingScore * 0.25 +
    safetyScore * 0.20;

  // -- Anti-FOMO check (DexScreener-only, no Birdeye dependency) --
  const antiFomo = checkAntiFomo(pair);

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
    buyEligible: checkBuyEligibility(pair, safetyGatePassed, antiFomo),
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
    discoveryScore: discoveryScore.toFixed(1),
    flowScore: flowScore.toFixed(1),
    mispricingScore: mispricingScore.toFixed(1),
    safetyScore: safetyScore.toFixed(1),
    buyEligible: result.buyEligible,
    safetyGatePassed,
    antiFomo: antiFomo.rejected ? antiFomo.reason : 'pass',
    hasBirdeye: !!overview,
  }, 'Candidate scored');

  return result;
}

// ---- Safety Gate ----

async function runSafetyGate(address, pairAddress) {
  const result = {
    passed: false,
    freezeAuthorityInactive: null,
    mintAuthorityInactive: null,
    top10Pct: null,
    onChainTop10Pct: null,
    holderCount: null,
    lpControlled: null,
    slippageOk: null,
    hasTransferFee: null,
    missingData: [],
  };

  // 1. Check freeze/mint authority via Helius (REQUIRED)
  const authKey = `auth:${address}`;
  let authInfo = cache.get(authKey);
  if (!authInfo) {
    const accountInfo = await helius.getAccountInfo(address);
    if (!accountInfo) {
      authInfo = { parsed: false, mintAuthority: null, freezeAuthority: null };
    } else {
      authInfo = helius.parseMintAuthority(accountInfo);
    }
    cache.set(authKey, authInfo, TTL.AUTHORITY_CHECK);
  }

  if (!authInfo.parsed) {
    result.missingData.push('authority');
  } else {
    result.freezeAuthorityInactive = authInfo.freezeAuthority === null;
    result.mintAuthorityInactive = authInfo.mintAuthority === null;
  }

  // 1b. On-chain holder concentration via getTokenLargestAccounts (Helius RPC).
  // Backstop for Birdeye top10HolderPercent — works even when Birdeye is degraded.
  const holderConcKey = `holder_conc:${address}`;
  let holderConc = cache.get(holderConcKey);
  if (holderConc === null) {
    try {
      const largestAccounts = await helius.getTokenLargestAccounts(address);
      if (largestAccounts && authInfo.parsed && authInfo.supply) {
        const totalSupply = BigInt(authInfo.supply); // raw units (string → BigInt)
        if (totalSupply > 0n) {
          // Derive LP/pool ATA to exclude from concentration calc
          let poolAta = null;
          let poolExcluded = false;
          if (pairAddress) {
            try {
              const [ata] = PublicKey.findProgramAddressSync(
                [
                  new PublicKey(pairAddress).toBuffer(),
                  TOKEN_PROGRAM_ID.toBuffer(),
                  new PublicKey(address).toBuffer(),
                ],
                ATA_PROGRAM_ID,
              );
              poolAta = ata.toBase58();
            } catch (e) {
              // Invalid pair address — skip filtering, result is conservative
            }
          }

          // Filter out LP/pool account, then take top 10
          const filtered = largestAccounts.filter((a) => {
            if (poolAta && a.address === poolAta) {
              poolExcluded = true;
              return false;
            }
            return true;
          });
          const top10 = filtered.slice(0, 10);
          // Sum raw amounts (string → BigInt) for unit consistency with totalSupply
          const top10Amount = top10.reduce((sum, a) => sum + BigInt(a.amount || '0'), 0n);
          const pct = Number((top10Amount * 10000n) / totalSupply) / 100; // two-decimal %

          holderConc = { top10Pct: pct, poolExcluded, accountsChecked: largestAccounts.length };
          logger.info({
            address,
            onChainTop10Pct: pct.toFixed(1),
            poolExcluded,
            poolAta: poolAta || 'none',
            accountsChecked: largestAccounts.length,
          }, 'Holder concentration computed');
        } else {
          holderConc = { _negativeCached: true };
        }
      } else {
        holderConc = { _negativeCached: true };
      }
      cache.set(holderConcKey, holderConc, TTL.TOP_HOLDERS);
    } catch (err) {
      logger.warn({ err, address }, 'Holder concentration check failed');
      holderConc = { _negativeCached: true };
      cache.set(holderConcKey, holderConc, TTL.TOP_HOLDERS);
    }
  }

  if (holderConc && !holderConc._negativeCached) {
    result.onChainTop10Pct = holderConc.top10Pct;
  }

  // 2. Birdeye security (optional — paid tier only, negative-cached)
  const secKey = `security:${address}`;
  let security = cache.get(secKey);
  if (!security) {
    security = await birdeye.getTokenSecurity(address);
    if (security) {
      cache.set(secKey, security, TTL.TOP_HOLDERS);
      await stats.incrementBirdeyeCus(1);
    } else {
      const staleSec = cache.getStale(secKey);
      if (staleSec && !staleSec.value._negativeCached) {
        security = staleSec.value;
      } else {
        cache.set(secKey, { _negativeCached: true }, TTL.TOP_HOLDERS);
        security = null;
      }
    }
  }

  if (security && !security._negativeCached) {
    result.top10Pct = security.top10HolderPercent;
    result.hasTransferFee = security.transferFeeEnable || false;
    result.lpControlled = security.creatorPercentage > 30 ? true : false;
  } else {
    result.missingData.push('security');
  }

  // 3. Birdeye overview for holder count (optional, negative-cached)
  const overviewKeyGate = `overview:${address}`;
  let overviewGate = cache.get(overviewKeyGate);
  if (!overviewGate) {
    overviewGate = await birdeye.getTokenOverview(address);
    if (overviewGate) {
      cache.set(overviewKeyGate, overviewGate, TTL.HOLDER_COUNT);
      await stats.incrementBirdeyeCus(1);
    } else {
      const staleOv = cache.getStale(overviewKeyGate);
      if (staleOv && !staleOv.value?._negativeCached) {
        overviewGate = staleOv.value;
      } else {
        cache.set(overviewKeyGate, { _negativeCached: true }, TTL.HOLDER_COUNT);
        overviewGate = null;
      }
    }
  }
  if (overviewGate && overviewGate._negativeCached) overviewGate = null;

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
    result.slippageOk = true;
  }

  result.passed = evaluateSafetyGate(result);
  return result;
}

function evaluateSafetyGate(g) {
  // Only 'authority' (Helius) is hard-required.
  // security, overview, slippage are optional enrichment.
  const OPTIONAL_DATA = new Set(['security', 'overview', 'slippage']);
  const requiredMissing = g.missingData.filter((d) => !OPTIONAL_DATA.has(d));
  if (requiredMissing.length > 0) return false;

  if (g.freezeAuthorityInactive === false) return false;
  if (g.mintAuthorityInactive === false) return false;
  if (g.top10Pct !== null && g.top10Pct > 40) return false;
  if (g.onChainTop10Pct !== null && g.onChainTop10Pct > 40) return false;
  if (g.lpControlled === true) return false;
  if (g.holderCount !== null && g.holderCount < config.minHolderCount) return false;
  if (g.slippageOk === false) return false;
  if (g.hasTransferFee === true) return false;

  return true;
}

// ========================================================================
// SCORING FUNCTIONS — DexScreener-primary, Birdeye-bonus
//
// Design principle: every score component can reach its full range using
// DexScreener pair data alone. Birdeye overview adds a small bonus when
// available but is never required for differentiation.
//
// Score ranges (DexScreener-only):
//   Discovery:  30 – 95   (volume acceleration, buy momentum, age signal)
//   Flow:       25 – 95   (buy/sell imbalance at 5m and 1h, conviction)
//   Mispricing: 30 – 95   (vol/liq ratio, mcap/liq ratio, price efficiency)
//   Safety:     50 – 80   (Helius authority + Jupiter slippage)
//
// Total range: 0.25*30 + 0.30*25 + 0.25*30 + 0.20*50 = 32.5  (worst)
//              0.25*95 + 0.30*95 + 0.25*95 + 0.20*80 = 92.25 (best)
// Threshold 70 is comfortably reachable with good DexScreener signals.
// ========================================================================

function computeDiscoveryScore(pair, overview) {
  let score = 40; // baseline (lower than before to create more range)

  if (!pair) return score;

  // --- Volume acceleration (5m vs 1h) ---
  // If recent 5m volume annualized exceeds 1h volume, activity is accelerating
  const vol5m = pair.volume5m || 0;
  const vol1h = pair.volume1h || 0;
  if (vol1h > 0 && vol5m > 0) {
    const accel = (vol5m * 12) / vol1h; // annualized 5m vs actual 1h
    if (accel > 2.0) score += 20;       // strong acceleration
    else if (accel > 1.3) score += 12;  // moderate acceleration
    else if (accel > 0.8) score += 5;   // steady
    // below 0.8 = decelerating, no bonus
  }

  // --- Buy momentum (5m buys annualized vs 1h buys) ---
  const buys5m = pair.txnsBuys5m || 0;
  const buys1h = pair.txnsBuys1h || 0;
  if (buys1h > 0 && buys5m > 0) {
    const buyAccel = (buys5m * 12) / buys1h;
    if (buyAccel > 2.0) score += 15;
    else if (buyAccel > 1.2) score += 8;
  }

  // --- Volume-to-liquidity ratio (activity relative to pool size) ---
  const liquidity = pair.liquidityUsd || 0;
  if (liquidity > 0 && vol1h > 0) {
    const volLiqRatio = vol1h / liquidity;
    if (volLiqRatio > 1.0) score += 10;      // very active
    else if (volLiqRatio > 0.3) score += 5;   // moderately active
  }

  // --- Birdeye bonus: holder count (when available) ---
  if (overview) {
    const holderCount = overview.holderCount || 0;
    if (holderCount > 500) score += 10;
    else if (holderCount > 200) score += 5;
  }

  return clamp(score, 0, 100);
}

function computeFlowScore(pair, overview) {
  let score = 40; // baseline

  if (!pair) return score;

  // --- 1h buy/sell imbalance (sustained flow) ---
  const buys1h = pair.txnsBuys1h || 0;
  const sells1h = pair.txnsSells1h || 0;
  const total1h = buys1h + sells1h;
  if (total1h > 0) {
    const buyRatio = buys1h / total1h; // 0.0 to 1.0
    if (buyRatio > 0.70) score += 20;       // strong buy dominance
    else if (buyRatio > 0.60) score += 12;  // moderate buy dominance
    else if (buyRatio > 0.55) score += 5;   // slight buy edge
    else if (buyRatio < 0.35) score -= 15;  // strong sell pressure
    else if (buyRatio < 0.45) score -= 8;   // moderate sell pressure
  }

  // --- 5m buy/sell imbalance (short-term momentum) ---
  const buys5m = pair.txnsBuys5m || 0;
  const sells5m = pair.txnsSells5m || 0;
  const total5m = buys5m + sells5m;
  if (total5m > 0) {
    const buyRatio5m = buys5m / total5m;
    if (buyRatio5m > 0.70) score += 15;
    else if (buyRatio5m > 0.60) score += 8;
    else if (buyRatio5m < 0.30) score -= 10;
  }

  // --- Flow deterioration penalty ---
  // If 1h flow is buy-heavy but 5m flow has deteriorated materially,
  // the token is likely in distribution / rollover phase. These are
  // the setups that die 4–13 minutes after entry.
  if (total1h > 10 && total5m > 3) {
    const buyRatio1h = buys1h / total1h;
    const buyRatio5m_d = buys5m / total5m;
    const deterioration = buyRatio1h - buyRatio5m_d; // positive = 5m is weaker

    if (deterioration > 0.30) {
      // Severe rollover: 1h buy-heavy but 5m is sell-heavy
      // e.g. 1h=0.70 but 5m=0.35 → distribution phase
      score -= 20;
    } else if (deterioration > 0.20) {
      // Moderate rollover: momentum fading fast
      // e.g. 1h=0.65 but 5m=0.42
      score -= 12;
    } else if (deterioration > 0.12) {
      // Mild deterioration: caution signal
      // e.g. 1h=0.65 but 5m=0.50
      score -= 5;
    }
    // If deterioration <= 0.12 or negative (5m stronger), no penalty
  }

  // --- Transaction volume conviction ---
  // High buy count + high volume = real conviction, not wash trading
  if (buys1h > 50 && (pair.volume1h || 0) > 10000) score += 10;
  else if (buys1h > 20 && (pair.volume1h || 0) > 5000) score += 5;

  // --- Birdeye bonus: unique buyers (when available) ---
  if (overview) {
    const uniqueBuyers = overview.uniqueBuy30m || 0;
    const uniqueSellers = overview.uniqueSell30m || 0;
    if (uniqueSellers > 0 && uniqueBuyers / uniqueSellers > 2.0) score += 5;
  }

  return clamp(score, 0, 100);
}

function computeMispricingScore(pair, overview) {
  let score = 40; // baseline

  if (!pair) return score;

  const vol1h = pair.volume1h || 0;
  const vol24h = pair.volume24h || 0;
  const liquidity = pair.liquidityUsd || 0;
  const marketCap = pair.marketCapUsd || 0;
  const priceChangeH1 = Math.abs(pair.priceChangeH1 || 0);

  // --- Volume/liquidity ratio (market activity vs pool depth) ---
  // High volume relative to liquidity = active trading, potential opportunity
  if (liquidity > 0 && vol1h > 0) {
    const volLiqRatio = vol1h / liquidity;
    if (volLiqRatio > 0.5 && priceChangeH1 < 100) {
      score += 18; // High activity, price hasn't moved proportionally
    } else if (volLiqRatio > 0.2 && priceChangeH1 < 50) {
      score += 10;
    }
  }

  // --- Market cap / liquidity ratio (valuation vs depth) ---
  // Lower mcap/liq ratio = better liquidity support for the valuation
  if (liquidity > 0 && marketCap > 0) {
    const mcapLiqRatio = marketCap / liquidity;
    if (mcapLiqRatio < 5) score += 12;       // well-supported
    else if (mcapLiqRatio < 10) score += 6;   // reasonable
    // > 10 = speculative valuation, no bonus
  }

  // --- Volume concentration (1h as % of 24h) ---
  // If a big chunk of 24h volume happened in the last hour = accelerating interest
  if (vol24h > 0 && vol1h > 0) {
    const hourPct = vol1h / vol24h;
    if (hourPct > 0.30) score += 10;    // >30% of daily volume in last hour
    else if (hourPct > 0.15) score += 5;
  }

  // --- Liquidity depth bonus ---
  if (liquidity > 100000) score += 8;
  else if (liquidity > 50000) score += 4;

  // --- Birdeye bonus: granular volume data (when available) ---
  if (overview && overview.volume30m > 0 && overview.volume1h > 0) {
    const accel30m = overview.volume30m / (overview.volume1h / 2);
    if (accel30m > 1.5) score += 5;
  }

  return clamp(score, 0, 100);
}

function computeSafetyScore(safety) {
  let score = 50;

  if (safety.freezeAuthorityInactive) score += 10;
  if (safety.mintAuthorityInactive) score += 10;

  // Birdeye security bonuses (when available)
  if (safety.top10Pct !== null) {
    if (safety.top10Pct < 20) score += 15;
    else if (safety.top10Pct < 30) score += 10;
    else if (safety.top10Pct < 40) score += 5;
  }

  // On-chain holder concentration backstop (when Birdeye top10Pct is unavailable)
  if (safety.top10Pct === null && safety.onChainTop10Pct !== null) {
    if (safety.onChainTop10Pct < 20) score += 15;
    else if (safety.onChainTop10Pct < 30) score += 10;
    else if (safety.onChainTop10Pct < 40) score += 5;
  }

  if (safety.lpControlled === false) score += 10;
  if (safety.slippageOk === true) score += 10;
  if (safety.hasTransferFee === false) score += 5;

  return clamp(score, 0, 100);
}

// ---- Buy Eligibility (v2.4: filter-only, no composite score threshold) ----
// The composite score is logged for analysis but does NOT control buy decisions.
// Buy eligibility is determined entirely by:
//   1. Safety gate passed (Helius authority check)
//   2. Anti-FOMO not triggered
//   3. buyRatio5m > MIN_BUY_RATIO_5M (default 0.55)
//   4. vol/liq ratio < MAX_VOL_LIQ_RATIO (default 1.0)
function checkBuyEligibility(pair, safetyGatePassed, antiFomo) {
  if (!safetyGatePassed) return false;
  if (antiFomo.rejected) return false;

  // buyRatio5m: buys / (buys + sells) in last 5 minutes
  const buys5m = pair?.txnsBuys5m || 0;
  const sells5m = pair?.txnsSells5m || 0;
  const total5m = buys5m + sells5m;
  if (total5m < 3) return false; // not enough data to compute ratio
  const buyRatio5m = buys5m / total5m;
  if (buyRatio5m < config.minBuyRatio5m) return false;

  // vol/liq ratio: reject high-volume-relative-to-liquidity tokens (crash risk)
  const vol1h = pair?.volume1h || 0;
  const liq = pair?.liquidityUsd || 0;
  if (liq > 0 && vol1h > 0) {
    const volLiqRatio = vol1h / liq;
    if (volLiqRatio > config.maxVolLiqRatio) return false;
  }

  return true;
}

// ---- Anti-FOMO ----
// Now DexScreener-only. No Birdeye dependency.
// Threshold raised from 200% to 500% — boosted tokens routinely spike
// 200-300% and the old threshold rejected all of them.
function checkAntiFomo(pair) {
  const reasons = [];

  const priceChangeH1 = pair?.priceChangeH1 || 0;
  if (priceChangeH1 > 500) {
    reasons.push(`Price up ${priceChangeH1.toFixed(0)}% in 1h`);
  }

  // Extreme sell pressure (more sells than buys in 5m while 1h is buy-heavy)
  // = likely distribution phase after a pump
  const buys5m = pair?.txnsBuys5m || 0;
  const sells5m = pair?.txnsSells5m || 0;
  const buys1h = pair?.txnsBuys1h || 0;
  if (sells5m > buys5m * 2 && buys1h > 50) {
    reasons.push(`Sell pressure spike: ${sells5m} sells vs ${buys5m} buys in 5m`);
  }

  return {
    rejected: reasons.length > 0,
    reason: reasons.join('; ') || null,
  };
}

module.exports = { rank, scoreCandidate };
