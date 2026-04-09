#!/usr/bin/env node
/**
 * Raw Feature Importance — Which DexScreener metrics actually predict wins?
 *
 * This bypasses the scoring model entirely and tests raw market metrics
 * against trade outcomes. The goal is to find what ACTUALLY predicts
 * winners vs losers, independent of the current (anti-predictive) score.
 *
 * Usage:
 *   node scripts/feature-importance.js
 *   node scripts/feature-importance.js --days 14
 *   node scripts/feature-importance.js --since 2026-04-04   # post-age-filter only
 *   node scripts/feature-importance.js --min-age-filter      # only trades with 60m+ age filter
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// CLI args
const args = process.argv.slice(2);
let sinceDate = null;
let minAgeFilter = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(args[i + 1]));
    sinceDate = d.toISOString();
  }
  if (args[i] === '--since' && args[i + 1]) sinceDate = new Date(args[i + 1]).toISOString();
  if (args[i] === '--min-age-filter') minAgeFilter = true;
}

if (args.includes('--help')) {
  console.log(`Usage: node scripts/feature-importance.js [options]
  --days N             Last N days only
  --since YYYY-MM-DD   Since date
  --min-age-filter     Only trades where minTokenAgeMinutes >= 60
  --help               Show this help`);
  process.exit(0);
}

// Helpers
const fmt = (n, d = 3) => n != null ? n.toFixed(d) : 'N/A';
const pct = (n) => (n * 100).toFixed(1) + '%';
const bar = (label, w = 70) => {
  const line = '═'.repeat(w);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
};

// AUC (Mann-Whitney U)
function computeAUC(winners, losers) {
  if (winners.length < 2 || losers.length < 2) return null;
  let u = 0;
  for (const w of winners) {
    for (const l of losers) {
      if (w > l) u += 1;
      else if (w === l) u += 0.5;
    }
  }
  return u / (winners.length * losers.length);
}

// Pearson correlation
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

// Bucket analysis helper
function analyzeBuckets(rows, featureFn, bucketFn, bucketOrder) {
  const buckets = {};
  for (const r of rows) {
    const val = featureFn(r);
    if (val == null) continue;
    const b = bucketFn(val);
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(r);
  }
  const results = [];
  for (const b of bucketOrder) {
    const g = buckets[b] || [];
    if (g.length < 3) continue;
    const w = g.filter(r => r.pnlPct >= 0);
    const avgPnl = g.reduce((s, r) => s + r.pnlPct, 0) / g.length;
    const slRate = g.filter(r => r.exitCat === 'stop_loss').length / g.length;
    results.push({ bucket: b, n: g.length, winRate: w.length / g.length, avgPnl, slRate });
  }
  return results;
}

function exitCategory(reason) {
  if (!reason) return 'unknown';
  if (reason.includes('Stop loss')) return 'stop_loss';
  if (reason.includes('Max hold')) return 'max_hold';
  if (reason.includes('Liquidity')) return 'liq_drop';
  if (reason.includes('final exit') || reason.includes('sell')) return 'target';
  return 'other';
}

async function main() {
  let whereClause = `WHERE p.status = 'closed' AND p.mode = 'paper' AND p.entry_data IS NOT NULL`;
  const params = [];
  if (sinceDate) {
    params.push(sinceDate);
    whereClause += ` AND p.entry_timestamp >= $${params.length}`;
  }

  const { rows: trades } = await pool.query(`
    SELECT p.id, p.symbol, p.entry_score, p.final_pnl_pct, p.final_pnl_sol,
           p.hold_time_minutes, p.exit_reason, p.entry_data, p.entry_timestamp,
           p.liquidity_at_entry
    FROM positions p
    ${whereClause}
    ORDER BY p.entry_timestamp ASC
  `, params);

  if (trades.length < 10) {
    console.log(`Only ${trades.length} trades with entry_data. Need at least 10 for feature analysis.`);
    await pool.end();
    return;
  }

  let rows = trades.map(t => {
    const ed = t.entry_data || {};
    return {
      id: t.id,
      symbol: t.symbol,
      entryScore: t.entry_score,
      pnlPct: t.final_pnl_pct,
      pnlSol: t.final_pnl_sol,
      holdMin: t.hold_time_minutes,
      exitReason: t.exit_reason,
      exitCat: exitCategory(t.exit_reason),
      entryTs: new Date(t.entry_timestamp),
      // Raw features from entry_data
      pairAgeMin: ed.pairAgeMin,
      liquidityUsd: ed.liquidityUsd ?? t.liquidity_at_entry,
      marketCapUsd: ed.marketCapUsd,
      volume1h: ed.volume1h,
      volume5m: ed.volume5m,
      volume24h: ed.volume24h,
      txnsBuys1h: ed.txnsBuys1h,
      txnsSells1h: ed.txnsSells1h,
      txnsBuys5m: ed.txnsBuys5m,
      txnsSells5m: ed.txnsSells5m,
      priceChangeH1: ed.priceChangeH1,
      priceChangeM5: ed.priceChangeM5,
      priceImpactPct: ed.priceImpactPct,
      hasBirdeye: ed.hasBirdeye,
      // Derived
      flowDetValue: ed.flowDetValue,
      buyRatio1h: ed.buyRatio1h,
      buyRatio5m: ed.buyRatio5m,
      volLiqRatio: ed.volLiqRatio,
      mcapLiqRatio: ed.mcapLiqRatio,
      // Sub-scores
      D: ed.discoveryScore,
      F: ed.flowScore,
      M: ed.mispricingScore,
      S: ed.safetyScore,
      minAgeConfig: ed.minTokenAgeMinutes,
    };
  });

  if (minAgeFilter) {
    const before = rows.length;
    rows = rows.filter(r => r.minAgeConfig != null && r.minAgeConfig >= 60);
    console.log(`--min-age-filter: ${before} → ${rows.length} trades\n`);
    if (rows.length < 10) {
      console.log('Not enough post-age-filter trades yet. Keep collecting.');
      await pool.end();
      return;
    }
  }

  const winners = rows.filter(r => r.pnlPct >= 0);
  const losers = rows.filter(r => r.pnlPct < 0);

  bar(`RAW FEATURE IMPORTANCE — ${rows.length} trades (${winners.length}W / ${losers.length}L)`);
  console.log(`Date range: ${rows[0].entryTs.toISOString().slice(0, 10)} → ${rows[rows.length - 1].entryTs.toISOString().slice(0, 10)}`);

  // ── 1. AUC for every raw feature ──
  bar('1. AUC — Which raw features separate winners from losers?');
  console.log('   AUC > 0.55 = useful signal, AUC < 0.45 = anti-signal, ~0.50 = noise\n');

  const features = [
    { key: 'pairAgeMin', label: 'Pair Age (min)' },
    { key: 'liquidityUsd', label: 'Liquidity ($)' },
    { key: 'marketCapUsd', label: 'Market Cap ($)' },
    { key: 'volume1h', label: 'Volume 1h ($)' },
    { key: 'volume5m', label: 'Volume 5m ($)' },
    { key: 'volume24h', label: 'Volume 24h ($)' },
    { key: 'txnsBuys1h', label: 'Buys 1h (#)' },
    { key: 'txnsSells1h', label: 'Sells 1h (#)' },
    { key: 'txnsBuys5m', label: 'Buys 5m (#)' },
    { key: 'txnsSells5m', label: 'Sells 5m (#)' },
    { key: 'buyRatio1h', label: 'Buy Ratio 1h' },
    { key: 'buyRatio5m', label: 'Buy Ratio 5m' },
    { key: 'priceChangeH1', label: 'Price Chg 1h (%)' },
    { key: 'priceChangeM5', label: 'Price Chg 5m (%)' },
    { key: 'volLiqRatio', label: 'Vol/Liq Ratio' },
    { key: 'mcapLiqRatio', label: 'MCap/Liq Ratio' },
    { key: 'flowDetValue', label: 'Flow Deterioration' },
    { key: 'priceImpactPct', label: 'Price Impact (%)' },
    { key: 'entryScore', label: 'Total Score' },
    { key: 'D', label: 'Discovery Score' },
    { key: 'F', label: 'Flow Score' },
    { key: 'M', label: 'Mispricing Score' },
    { key: 'S', label: 'Safety Score' },
  ];

  const aucResults = [];
  console.log(`${'Feature'.padEnd(22)} ${'AUC'.padStart(7)} ${'Corr→PnL'.padStart(10)} ${'N'.padStart(5)}  Signal`);
  console.log('─'.repeat(60));

  for (const f of features) {
    const wVals = winners.map(r => r[f.key]).filter(v => v != null);
    const lVals = losers.map(r => r[f.key]).filter(v => v != null);
    const auc = computeAUC(wVals, lVals);

    const allVals = rows.map(r => r[f.key]).filter(v => v != null);
    const allPnl = rows.filter(r => r[f.key] != null).map(r => r.pnlPct);
    const corr = correlation(allVals, allPnl);

    const n = wVals.length + lVals.length;
    let signal = '—';
    if (auc != null) {
      if (auc > 0.60) signal = '✅ STRONG';
      else if (auc > 0.55) signal = '📈 useful';
      else if (auc < 0.40) signal = '🔴 ANTI-STRONG';
      else if (auc < 0.45) signal = '⚠️ anti';
      else signal = '— noise';
    }

    aucResults.push({ ...f, auc, corr, n, signal });
    console.log(`${f.label.padEnd(22)} ${auc != null ? fmt(auc) : 'N/A'.padStart(7)} ${corr != null ? (corr >= 0 ? '+' : '') + fmt(corr) : 'N/A'.padStart(10)} ${String(n).padStart(5)}  ${signal}`);
  }

  // ── 2. Sorted by predictive power ──
  bar('2. RANKED BY PREDICTIVE POWER');
  const sorted = aucResults
    .filter(r => r.auc != null && r.n >= 10)
    .sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5));

  console.log('   (sorted by distance from 0.50 — strongest signals first)\n');
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const dir = r.auc > 0.5 ? 'higher=better' : 'higher=worse';
    console.log(`${String(i + 1).padStart(3)}. ${r.label.padEnd(22)} AUC=${fmt(r.auc)}  (${dir})  ${r.signal}`);
  }

  // ── 3. Bucket analysis for top features ──
  bar('3. BUCKET ANALYSIS — Top Features');

  // Pair age buckets
  const ageBuckets = analyzeBuckets(rows,
    r => r.pairAgeMin,
    v => v <= 30 ? '0-30m' : v <= 60 ? '30-60m' : v <= 120 ? '60-120m' : v <= 240 ? '2-4h' : '4h+',
    ['0-30m', '30-60m', '60-120m', '2-4h', '4h+']
  );
  if (ageBuckets.length > 0) {
    console.log(`\n  Pair Age:`);
    console.log(`  ${'Bucket'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of ageBuckets) {
      console.log(`  ${b.bucket.padEnd(12)} ${String(b.n).padStart(5)} ${pct(b.winRate).padStart(7)} ${fmt(b.avgPnl, 1).padStart(9)} ${pct(b.slRate).padStart(7)}`);
    }
  }

  // Buy ratio 1h buckets
  const brBuckets = analyzeBuckets(rows,
    r => r.buyRatio1h,
    v => v < 0.40 ? '<40%' : v < 0.50 ? '40-50%' : v < 0.60 ? '50-60%' : v < 0.70 ? '60-70%' : '70%+',
    ['<40%', '40-50%', '50-60%', '60-70%', '70%+']
  );
  if (brBuckets.length > 0) {
    console.log(`\n  Buy Ratio 1h:`);
    console.log(`  ${'Bucket'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of brBuckets) {
      console.log(`  ${b.bucket.padEnd(12)} ${String(b.n).padStart(5)} ${pct(b.winRate).padStart(7)} ${fmt(b.avgPnl, 1).padStart(9)} ${pct(b.slRate).padStart(7)}`);
    }
  }

  // Volume/Liquidity ratio buckets
  const vlBuckets = analyzeBuckets(rows,
    r => r.volLiqRatio,
    v => v < 0.1 ? '<0.1' : v < 0.3 ? '0.1-0.3' : v < 0.5 ? '0.3-0.5' : v < 1.0 ? '0.5-1.0' : '1.0+',
    ['<0.1', '0.1-0.3', '0.3-0.5', '0.5-1.0', '1.0+']
  );
  if (vlBuckets.length > 0) {
    console.log(`\n  Vol/Liq Ratio:`);
    console.log(`  ${'Bucket'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of vlBuckets) {
      console.log(`  ${b.bucket.padEnd(12)} ${String(b.n).padStart(5)} ${pct(b.winRate).padStart(7)} ${fmt(b.avgPnl, 1).padStart(9)} ${pct(b.slRate).padStart(7)}`);
    }
  }

  // Liquidity buckets
  const liqBuckets = analyzeBuckets(rows,
    r => r.liquidityUsd,
    v => v < 25000 ? '<$25k' : v < 50000 ? '$25-50k' : v < 100000 ? '$50-100k' : v < 250000 ? '$100-250k' : '$250k+',
    ['<$25k', '$25-50k', '$50-100k', '$100-250k', '$250k+']
  );
  if (liqBuckets.length > 0) {
    console.log(`\n  Liquidity at Entry:`);
    console.log(`  ${'Bucket'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of liqBuckets) {
      console.log(`  ${b.bucket.padEnd(12)} ${String(b.n).padStart(5)} ${pct(b.winRate).padStart(7)} ${fmt(b.avgPnl, 1).padStart(9)} ${pct(b.slRate).padStart(7)}`);
    }
  }

  // Price change 5m buckets
  const pc5Buckets = analyzeBuckets(rows,
    r => r.priceChangeM5,
    v => v < -5 ? '<-5%' : v < 0 ? '-5 to 0%' : v < 5 ? '0-5%' : v < 15 ? '5-15%' : '15%+',
    ['<-5%', '-5 to 0%', '0-5%', '5-15%', '15%+']
  );
  if (pc5Buckets.length > 0) {
    console.log(`\n  Price Change 5m:`);
    console.log(`  ${'Bucket'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of pc5Buckets) {
      console.log(`  ${b.bucket.padEnd(12)} ${String(b.n).padStart(5)} ${pct(b.winRate).padStart(7)} ${fmt(b.avgPnl, 1).padStart(9)} ${pct(b.slRate).padStart(7)}`);
    }
  }

  // ── 4. Recommendations ──
  bar('4. RECOMMENDATIONS');

  const strongPositive = sorted.filter(r => r.auc > 0.58);
  const strongNegative = sorted.filter(r => r.auc < 0.42);

  if (strongPositive.length > 0) {
    console.log(`\n  Strong positive signals (higher = better outcomes):`);
    for (const r of strongPositive) {
      console.log(`    ${r.label}: AUC ${fmt(r.auc)} — INCREASE weight or add as filter`);
    }
  }

  if (strongNegative.length > 0) {
    console.log(`\n  Anti-predictive signals (higher = WORSE outcomes):`);
    for (const r of strongNegative) {
      console.log(`    ${r.label}: AUC ${fmt(r.auc)} — REDUCE weight, invert, or remove`);
    }
  }

  if (strongPositive.length === 0 && strongNegative.length === 0) {
    console.log(`\n  No features show strong signal (AUC > 0.58 or < 0.42).`);
    console.log(`  The current feature set may lack resolution for this market.`);
    console.log(`  Consider: on-chain metrics, wallet clustering, or different timeframes.`);
  }

  console.log('');
  await pool.end();
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
