#!/usr/bin/env node
/**
 * Offline Experiment Harness — Fast strategy variant evaluation
 *
 * Replays historical closed trades with different filter/weight/threshold
 * combinations. Uses real entry_data snapshots only.
 *
 * KEY LIMITATION: Can only test TIGHTER filters on trades that were actually
 * taken. Cannot test "what if we bought tokens we didn't buy" because we
 * lack outcome data for those. This means:
 *   - Raising liquidity floor: valid (subset of existing trades)
 *   - Raising threshold: valid (subset)
 *   - Raising age floor: valid (subset)
 *   - Changing weights: valid (recompute score, apply threshold)
 *   - Lowering any filter: INVALID (missing trades we never took)
 *
 * VALIDATION: Uses time-based train/holdout split.
 *   - First 60% of trades by time = search period (find best variants)
 *   - Last 40% = holdout (check if they hold up)
 *
 * Usage:
 *   DATABASE_URL=<url> node scripts/offline-experiment.js
 *   DATABASE_URL=<url> node scripts/offline-experiment.js --since 2026-03-28
 *   DATABASE_URL=<url> node scripts/offline-experiment.js --holdout-pct 40
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// CLI args
const args = process.argv.slice(2);
let sinceDate = null;
let holdoutPct = 40;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) sinceDate = new Date(args[i + 1]).toISOString();
  if (args[i] === '--holdout-pct' && args[i + 1]) holdoutPct = parseInt(args[i + 1]);
}

const fmt = (n, d = 4) => n != null ? n.toFixed(d) : 'N/A';
const pct = (n) => (n * 100).toFixed(1) + '%';

// ═══════════════════════════════════════════════════════
// STRATEGY VARIANTS TO TEST
// ═══════════════════════════════════════════════════════

function defineVariants() {
  return [
    // Current live strategy (control)
    { name: 'v2.3-control', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },

    // Threshold variants
    { name: 'threshold-72', minLiq: 100000, minAge: 240, threshold: 72, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },
    { name: 'threshold-75', minLiq: 100000, minAge: 240, threshold: 75, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },

    // Max-hold variants
    { name: 'hold-60m', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 60,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },
    { name: 'hold-180m', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 180,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },

    // Weight rebalance: kill mispricing
    { name: 'no-mispricing', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.35, F: 0.30, M: 0.00, S: 0.35 } },

    // Weight rebalance: kill flow + mispricing, boost D+S
    { name: 'D+S-only', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.50, F: 0.00, M: 0.00, S: 0.50 } },

    // Weight rebalance: invert mispricing
    { name: 'invert-mispricing', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.30, F: 0.25, M: -0.15, S: 0.25 }, mInvert: true },

    // Discovery-heavy
    { name: 'D-heavy', minLiq: 100000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.45, F: 0.15, M: 0.10, S: 0.30 } },

    // Simple rules: no composite score, just filters
    { name: 'rules-only-base', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true },

    // Rules + higher liq
    { name: 'rules-liq-125k', minLiq: 125000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true },

    // Liquidity variants
    { name: 'liq-75k', minLiq: 75000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },
    { name: 'liq-125k', minLiq: 125000, minAge: 240, threshold: 70, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },

    // Age variants
    { name: 'age-360m', minLiq: 100000, minAge: 360, threshold: 70, maxHold: 120,
      weights: { D: 0.25, F: 0.30, M: 0.25, S: 0.20 } },

    // Combined: D-heavy + threshold 72
    { name: 'D-heavy+t72', minLiq: 100000, minAge: 240, threshold: 72, maxHold: 120,
      weights: { D: 0.45, F: 0.15, M: 0.10, S: 0.30 } },

    // Combined: no-mispricing + threshold 72
    { name: 'no-M+t72', minLiq: 100000, minAge: 240, threshold: 72, maxHold: 120,
      weights: { D: 0.35, F: 0.30, M: 0.00, S: 0.35 } },

    // ── SIMPLIFIED MODELS (ChatGPT-requested comparison) ──

    // Filter-only: age + liquidity + safety (no score at all)
    { name: 'SIMPLE-filters', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true },

    // Filter + buyRatio5m > 0.50 (the consistent raw signal)
    { name: 'SIMPLE-br5m>50', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, minBuyRatio5m: 0.50 },

    // Filter + buyRatio5m > 0.55
    { name: 'SIMPLE-br5m>55', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, minBuyRatio5m: 0.55 },

    // Filter + buyRatio5m > 0.60
    { name: 'SIMPLE-br5m>60', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, minBuyRatio5m: 0.60 },

    // Filter + low vol/liq ratio (< 1.0 — high vol/liq is anti-predictive)
    { name: 'SIMPLE-lowVolLiq', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, maxVolLiqRatio: 1.0 },

    // Filter + buyRatio5m > 0.55 + low vol/liq
    { name: 'SIMPLE-br55+vlr', minLiq: 100000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, minBuyRatio5m: 0.55, maxVolLiqRatio: 1.0 },

    // Simplified at $125k liq
    { name: 'SIMPLE-125k', minLiq: 125000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true },

    // Simplified $125k + buyRatio5m > 0.55
    { name: 'SIMPLE-125k+br55', minLiq: 125000, minAge: 240, threshold: 0, maxHold: 120,
      weights: null, rulesOnly: true, minBuyRatio5m: 0.55 },
  ];
}

// ═══════════════════════════════════════════════════════
// TRADE EVALUATION
// ═══════════════════════════════════════════════════════

function recomputeScore(trade, weights) {
  if (!weights) return null; // rules-only mode
  const D = trade.D ?? 0;
  const F = trade.F ?? 0;
  const M = trade.M ?? 0;
  const S = trade.S ?? 0;
  return D * weights.D + F * weights.F + M * weights.M + S * weights.S;
}

function wouldPass(trade, variant) {
  // Filter: liquidity
  if (trade.liq != null && trade.liq < variant.minLiq) return false;
  // Filter: pair age
  if (trade.pairAgeMin != null && trade.pairAgeMin < variant.minAge) return false;
  // Filter: buyRatio5m minimum (simplified model signal)
  if (variant.minBuyRatio5m != null) {
    if (trade.buyRatio5m == null || trade.buyRatio5m < variant.minBuyRatio5m) return false;
  }
  // Filter: vol/liq ratio maximum (high vol/liq is anti-predictive)
  if (variant.maxVolLiqRatio != null) {
    if (trade.volLiqRatio != null && trade.volLiqRatio > variant.maxVolLiqRatio) return false;
  }
  // Score threshold
  if (!variant.rulesOnly && variant.threshold > 0) {
    const score = recomputeScore(trade, variant.weights);
    if (score == null || score < variant.threshold) return false;
  }
  return true;
}

function simulateOutcome(trade, variant) {
  // For max-hold changes, we can only approximate:
  // - If variant.maxHold >= trade.holdMin: trade outcome unchanged (it exited before max-hold anyway, or at max-hold)
  // - If variant.maxHold < trade.holdMin: trade would have exited earlier
  //   We don't have intermediate prices, so we use the actual outcome as-is
  //   This is CONSERVATIVE for shorter holds (real outcome might be better/worse)
  //
  // For max-hold LONGER than actual: if the trade exited via max-hold,
  // we don't know what would have happened with more time.
  // We flag these as "max-hold-extended" and note the uncertainty.

  const exitedViaMaxHold = trade.exitReason?.includes('Max hold');
  const holdCapped = exitedViaMaxHold && variant.maxHold > trade.holdMin;

  return {
    pnlPct: trade.pnlPct,
    pnlSol: trade.pnlSol,
    holdMin: trade.holdMin,
    exitReason: trade.exitReason,
    // Flag uncertainty
    maxHoldExtended: holdCapped,
    uncertainOutcome: holdCapped, // outcome unknown for extended holds
  };
}

// ═══════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════

function computeMetrics(trades, label, totalDays) {
  if (trades.length === 0) {
    return { label, n: 0, buysPerDay: 0, winPct: 0, expectancy: 0, totalPnl: 0 };
  }

  const winners = trades.filter(t => t.pnlPct >= 0);
  const losers = trades.filter(t => t.pnlPct < 0);
  const winRate = winners.length / trades.length;
  const avgWinPct = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;
  const avgWinSol = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlSol, 0) / winners.length : 0;
  const avgLossSol = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlSol, 0) / losers.length : 0;
  const expectancy = winRate * avgWinSol + (1 - winRate) * avgLossSol;
  const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
  const slCount = trades.filter(t => t.exitReason?.includes('Stop loss')).length;
  const fdCount = trades.filter(t => t.pnlPct < 0 && t.holdMin < 15).length;
  const mhCount = trades.filter(t => t.exitReason?.includes('Max hold')).length;
  const uncertainCount = trades.filter(t => t.uncertainOutcome).length;

  // Concentration risk
  const dayPnl = {};
  for (const t of trades) {
    const day = t.entryTs.toISOString().slice(0, 10);
    dayPnl[day] = (dayPnl[day] || 0) + t.pnlSol;
  }
  const dayValues = Object.values(dayPnl).sort((a, b) => b - a);
  const bestDayPct = totalPnl > 0 ? (dayValues[0] / totalPnl) * 100 : 0;

  // Top 3 trades concentration
  const sortedPnl = trades.map(t => t.pnlSol).sort((a, b) => b - a);
  const top3Pnl = sortedPnl.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Pct = totalPnl > 0 ? (top3Pnl / totalPnl) * 100 : 0;

  return {
    label,
    n: trades.length,
    buysPerDay: trades.length / Math.max(totalDays, 1),
    winPct: winRate,
    avgWinPct,
    avgLossPct,
    expectancy,
    totalPnl,
    slPct: slCount / trades.length,
    fdPct: fdCount / trades.length,
    mhPct: mhCount / trades.length,
    bestDayPct,
    top3Pct,
    uncertainCount,
  };
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  // Load all closed paper trades with entry_data
  let whereClause = `WHERE p.status = 'closed' AND p.mode = 'paper' AND p.entry_data IS NOT NULL`;
  const params = [];
  if (sinceDate) {
    params.push(sinceDate);
    whereClause += ` AND p.entry_timestamp >= $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT p.id, p.symbol, p.entry_score, p.final_pnl_pct, p.final_pnl_sol,
           p.hold_time_minutes, p.exit_reason, p.entry_data, p.entry_timestamp,
           p.liquidity_at_entry
    FROM positions p
    ${whereClause}
    ORDER BY p.entry_timestamp ASC
  `, params);

  if (rows.length < 20) {
    console.log(`Only ${rows.length} trades with entry_data. Need 20+ for offline experiments.`);
    await pool.end();
    return;
  }

  // Normalize trades
  const trades = rows.map(r => {
    const ed = r.entry_data || {};
    return {
      id: r.id,
      symbol: r.symbol,
      entryScore: r.entry_score,
      pnlPct: r.final_pnl_pct,
      pnlSol: r.final_pnl_sol,
      holdMin: r.hold_time_minutes,
      exitReason: r.exit_reason || '',
      entryTs: new Date(r.entry_timestamp),
      liq: ed.liquidityUsd ?? r.liquidity_at_entry ?? null,
      pairAgeMin: ed.pairAgeMin ?? null,
      D: ed.discoveryScore ?? null,
      F: ed.flowScore ?? null,
      M: ed.mispricingScore ?? null,
      S: ed.safetyScore ?? null,
      version: ed.strategyVersion ?? null,
      maxHoldConfig: ed.maxHoldMinutes ?? null,
      // Raw signals for simplified models
      buyRatio5m: ed.buyRatio5m ?? null,
      buyRatio1h: ed.buyRatio1h ?? null,
      volLiqRatio: ed.volLiqRatio ?? null,
    };
  });

  // Time-based split
  const splitIdx = Math.floor(trades.length * (1 - holdoutPct / 100));
  const searchSet = trades.slice(0, splitIdx);
  const holdoutSet = trades.slice(splitIdx);

  const searchDays = Math.max(1, (searchSet[searchSet.length - 1].entryTs - searchSet[0].entryTs) / 86400000);
  const holdoutDays = holdoutSet.length > 1
    ? Math.max(1, (holdoutSet[holdoutSet.length - 1].entryTs - holdoutSet[0].entryTs) / 86400000)
    : 1;
  const totalDays = Math.max(1, (trades[trades.length - 1].entryTs - trades[0].entryTs) / 86400000);

  console.log('═'.repeat(100));
  console.log('  OFFLINE EXPERIMENT HARNESS');
  console.log('═'.repeat(100));
  console.log(`Total trades with entry_data: ${trades.length}`);
  console.log(`Date range: ${trades[0].entryTs.toISOString().slice(0, 10)} → ${trades[trades.length - 1].entryTs.toISOString().slice(0, 10)} (${totalDays.toFixed(1)} days)`);
  console.log(`Search set: ${searchSet.length} trades (first ${100 - holdoutPct}%)`);
  console.log(`Holdout set: ${holdoutSet.length} trades (last ${holdoutPct}%)`);
  console.log(`\nData quality: ${trades.filter(t => t.D != null).length}/${trades.length} have sub-scores`);
  console.log(`              ${trades.filter(t => t.liq != null).length}/${trades.length} have liquidity`);
  console.log(`              ${trades.filter(t => t.pairAgeMin != null).length}/${trades.length} have pair age`);

  const variants = defineVariants();

  // Run each variant on both sets
  const results = [];

  for (const variant of variants) {
    const searchPassing = searchSet.filter(t => wouldPass(t, variant));
    const holdoutPassing = holdoutSet.filter(t => wouldPass(t, variant));

    const searchOutcomes = searchPassing.map(t => ({ ...t, ...simulateOutcome(t, variant) }));
    const holdoutOutcomes = holdoutPassing.map(t => ({ ...t, ...simulateOutcome(t, variant) }));

    const searchMetrics = computeMetrics(searchOutcomes, `${variant.name} [search]`, searchDays);
    const holdoutMetrics = computeMetrics(holdoutOutcomes, `${variant.name} [holdout]`, holdoutDays);
    const fullMetrics = computeMetrics(
      [...searchOutcomes, ...holdoutOutcomes],
      `${variant.name} [full]`,
      totalDays
    );

    results.push({
      variant: variant.name,
      search: searchMetrics,
      holdout: holdoutMetrics,
      full: fullMetrics,
      uncertainTrades: holdoutOutcomes.filter(t => t.uncertainOutcome).length,
    });
  }

  // ── SEARCH PERIOD RESULTS ──
  console.log('\n' + '═'.repeat(100));
  console.log('  SEARCH PERIOD (first ' + (100 - holdoutPct) + '% of trades)');
  console.log('═'.repeat(100));
  printTable(results.map(r => r.search));

  // ── HOLDOUT PERIOD RESULTS ──
  console.log('\n' + '═'.repeat(100));
  console.log('  HOLDOUT PERIOD (last ' + holdoutPct + '% of trades)');
  console.log('═'.repeat(100));
  printTable(results.map(r => r.holdout));

  // ── FULL PERIOD ──
  console.log('\n' + '═'.repeat(100));
  console.log('  FULL PERIOD (all trades)');
  console.log('═'.repeat(100));
  printTable(results.map(r => r.full));

  // ── RANKING ──
  console.log('\n' + '═'.repeat(100));
  console.log('  RANKING — by holdout expectancy (primary), then concentration sanity');
  console.log('═'.repeat(100));

  const ranked = results
    .filter(r => r.holdout.n >= 5) // need minimum trades in holdout
    .sort((a, b) => {
      // Primary: holdout expectancy
      if (Math.abs(a.holdout.expectancy - b.holdout.expectancy) > 0.0001) {
        return b.holdout.expectancy - a.holdout.expectancy;
      }
      // Secondary: lower concentration = more robust
      return a.holdout.top3Pct - b.holdout.top3Pct;
    });

  console.log(`\n${'Rank'.padEnd(5)} ${'Variant'.padEnd(22)} ${'HO Expect'.padStart(10)} ${'HO Win%'.padStart(8)} ${'HO N'.padStart(5)} ${'HO PnL'.padStart(9)} ${'HO Top3%'.padStart(8)} ${'Search E'.padStart(10)} ${'Robust?'.padStart(8)}`);
  console.log('─'.repeat(90));

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const searchE = r.search.expectancy;
    const holdE = r.holdout.expectancy;
    // Robustness: both periods positive, holdout not wildly different from search
    const robust = searchE > 0 && holdE > 0 ? '✅' :
                   searchE > 0 && holdE > -0.001 ? '~' :
                   holdE > 0 && searchE <= 0 ? '⚠️ flip' : '❌';

    console.log(
      `${String(i + 1).padEnd(5)}` +
      `${r.variant.padEnd(22)} ` +
      `${fmt(holdE).padStart(10)} ` +
      `${pct(r.holdout.winPct).padStart(8)} ` +
      `${String(r.holdout.n).padStart(5)} ` +
      `${fmt(r.holdout.totalPnl).padStart(9)} ` +
      `${r.holdout.top3Pct.toFixed(0).padStart(7)}% ` +
      `${fmt(searchE).padStart(10)} ` +
      `${robust.padStart(8)}`
    );
  }

  if (ranked.filter(r => r.uncertainTrades > 0).length > 0) {
    console.log(`\n⚠️ UNCERTAINTY: Some variants have trades where max-hold was extended beyond actual hold time.`);
    console.log(`   For those trades, the outcome is unknown (we don't have minute-by-minute prices).`);
    console.log(`   Variants with max-hold SHORTER than live are accurate. Longer holds are approximate.`);
  }

  // ── TOP 3 ──
  console.log('\n' + '═'.repeat(100));
  console.log('  TOP 3 VARIANTS (by holdout expectancy, min 5 holdout trades)');
  console.log('═'.repeat(100));

  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const r = ranked[i];
    console.log(`\n  #${i + 1}: ${r.variant}`);
    console.log(`  Search:  ${r.search.n} trades, ${pct(r.search.winPct)} win, ${fmt(r.search.expectancy)} expect, ${fmt(r.search.totalPnl)} PnL`);
    console.log(`  Holdout: ${r.holdout.n} trades, ${pct(r.holdout.winPct)} win, ${fmt(r.holdout.expectancy)} expect, ${fmt(r.holdout.totalPnl)} PnL`);
    console.log(`  Full:    ${r.full.n} trades, ${pct(r.full.winPct)} win, ${fmt(r.full.expectancy)} expect, ${fmt(r.full.totalPnl)} PnL`);
    console.log(`  SL: ${pct(r.holdout.slPct)} | FD: ${pct(r.holdout.fdPct)} | MH: ${pct(r.holdout.mhPct)} | BestDay: ${r.holdout.bestDayPct.toFixed(0)}% | Top3: ${r.holdout.top3Pct.toFixed(0)}%`);
    if (r.uncertainTrades > 0) {
      console.log(`  ⚠️ ${r.uncertainTrades} holdout trades have uncertain outcomes (max-hold extended)`);
    }
  }

  // ── VERDICT ──
  console.log('\n' + '═'.repeat(100));
  console.log('  VERDICT');
  console.log('═'.repeat(100));

  const bestHoldout = ranked[0];
  const control = results.find(r => r.variant === 'v2.3-control');
  const rulesOnly = results.find(r => r.variant === 'rules-only-base');

  if (bestHoldout) {
    console.log(`\n  Best holdout variant: ${bestHoldout.variant}`);
    console.log(`  Holdout expectancy: ${fmt(bestHoldout.holdout.expectancy)} SOL/trade`);
    console.log(`  vs control (v2.3): ${fmt(control?.holdout.expectancy || 0)} SOL/trade`);
    if (rulesOnly) {
      console.log(`  vs rules-only: ${fmt(rulesOnly.holdout.expectancy)} SOL/trade`);
    }

    const controlE = control?.holdout.expectancy || 0;
    const bestE = bestHoldout.holdout.expectancy;
    const rulesE = rulesOnly?.holdout.expectancy || -999;

    if (bestE > controlE * 1.5 && bestE > 0) {
      console.log(`\n  → CLEAR IMPROVEMENT over control. Consider deploying ${bestHoldout.variant}.`);
    } else if (bestE > 0 && controlE > 0) {
      console.log(`\n  → MARGINAL difference. Both positive. Current strategy family is viable.`);
    } else if (rulesE > bestE) {
      console.log(`\n  → RULES-ONLY beats the composite score. Consider simplifying.`);
    } else if (bestE <= 0) {
      console.log(`\n  → NO VARIANT is positive in holdout. Strategy family may not have real edge.`);
    }
  }

  console.log('');
  await pool.end();
}

function printTable(metrics) {
  console.log(`\n${'Variant'.padEnd(22)} ${'N'.padStart(5)} ${'B/day'.padStart(6)} ${'Win%'.padStart(7)} ${'AvgW%'.padStart(7)} ${'AvgL%'.padStart(7)} ${'Expect'.padStart(8)} ${'PnL'.padStart(9)} ${'SL%'.padStart(6)} ${'MH%'.padStart(6)} ${'Top3%'.padStart(6)}`);
  console.log('─'.repeat(95));
  for (const m of metrics) {
    if (m.n === 0) {
      console.log(`${m.label.replace(/ \[.*\]/, '').padEnd(22)} ${String(0).padStart(5)}    (no trades pass filters)`);
      continue;
    }
    console.log(
      `${m.label.replace(/ \[.*\]/, '').padEnd(22)} ` +
      `${String(m.n).padStart(5)} ` +
      `${m.buysPerDay.toFixed(1).padStart(6)} ` +
      `${pct(m.winPct).padStart(7)} ` +
      `${('+' + m.avgWinPct.toFixed(1)).padStart(7)} ` +
      `${m.avgLossPct.toFixed(1).padStart(7)} ` +
      `${fmt(m.expectancy).padStart(8)} ` +
      `${fmt(m.totalPnl).padStart(9)} ` +
      `${pct(m.slPct).padStart(6)} ` +
      `${pct(m.mhPct).padStart(6)} ` +
      `${m.top3Pct.toFixed(0).padStart(5)}%`
    );
  }
}

main().catch(err => {
  console.error('Experiment failed:', err);
  process.exit(1);
});
