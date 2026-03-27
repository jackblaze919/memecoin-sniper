#!/usr/bin/env node
/**
 * Score-Validation Analysis — Does the score actually predict outcomes?
 *
 * Usage:
 *   node scripts/analyze-scores.js
 *   node scripts/analyze-scores.js --days 7    # last 7 days only
 *   node scripts/analyze-scores.js --since 2026-03-25
 *
 * Reads closed paper trades from the database, joins with token scoring
 * data, and produces a comprehensive model-diagnosis report.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── CLI args ──
const args = process.argv.slice(2);
let sinceDate = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(args[i + 1]));
    sinceDate = d.toISOString();
  }
  if (args[i] === '--since' && args[i + 1]) {
    sinceDate = new Date(args[i + 1]).toISOString();
  }
}

// ── Flow-deterioration deploy timestamp (cc8bf9f pushed ~2026-03-27 00:00 UTC) ──
const FLOW_DETERIORATION_DEPLOY = new Date('2026-03-27T05:00:00Z');

// ── Helpers ──
const pct = (n) => (n * 100).toFixed(1) + '%';
const fmt = (n, d = 2) => n != null ? n.toFixed(d) : 'N/A';
const bar = (label, w = 60) => {
  const line = '─'.repeat(w);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
};

function bucket(score) {
  if (score == null) return 'unknown';
  if (score >= 80) return '80+';
  if (score >= 75) return '75-79';
  if (score >= 70) return '70-74';
  if (score >= 65) return '65-69';
  return '<65';
}

function ageBucket(ageMin) {
  if (ageMin == null) return 'unknown';
  if (ageMin <= 15) return '0-15m';
  if (ageMin <= 30) return '15-30m';
  if (ageMin <= 60) return '30-60m';
  return '60m+';
}

function liqBucket(liq) {
  if (liq == null) return 'unknown';
  if (liq < 25000) return '<$25k';
  if (liq < 50000) return '$25-50k';
  if (liq < 100000) return '$50-100k';
  return '$100k+';
}

function exitCategory(reason) {
  if (!reason) return 'unknown';
  if (reason.includes('Stop loss')) return 'stop_loss';
  if (reason.includes('Max hold')) return 'max_hold';
  if (reason.includes('Liquidity')) return 'liq_drop';
  if (reason.includes('final exit') || reason.includes('sell')) return 'target';
  if (reason.includes('Stale')) return 'stale';
  return 'other';
}

// Rank-based AUC approximation (Mann-Whitney U statistic)
// Interpretation: 0.5 = random, >0.5 = score ranks winners higher, <0.5 = anti-predictive
function computeAUC(winners, losers) {
  if (winners.length === 0 || losers.length === 0) return null;
  let u = 0;
  for (const w of winners) {
    for (const l of losers) {
      if (w > l) u += 1;
      else if (w === l) u += 0.5;
    }
  }
  return u / (winners.length * losers.length);
}

// Pearson correlation for two arrays
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
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

// ── Main ──
async function main() {
  // Fetch closed paper trades, LEFT JOIN to tokens for sub-scores on old trades
  let whereClause = `WHERE p.status = 'closed' AND p.mode = 'paper'`;
  const params = [];
  if (sinceDate) {
    params.push(sinceDate);
    whereClause += ` AND p.entry_timestamp >= $${params.length}`;
  }

  const { rows: trades } = await pool.query(`
    SELECT
      p.id,
      p.token_address,
      p.symbol,
      p.entry_score,
      p.entry_price,
      p.exit_price,
      p.entry_timestamp,
      p.exit_timestamp,
      p.final_pnl_sol,
      p.final_pnl_pct,
      p.hold_time_minutes,
      p.exit_reason,
      p.liquidity_at_entry,
      p.holder_count_at_entry,
      p.entry_data,
      t.discovery_score AS t_discovery,
      t.flow_score AS t_flow,
      t.mispricing_score AS t_mispricing,
      t.safety_score AS t_safety,
      t.data AS t_data
    FROM positions p
    LEFT JOIN tokens t ON p.token_address = t.address
    ${whereClause}
    ORDER BY p.entry_timestamp ASC
  `, params);

  if (trades.length === 0) {
    console.log('No closed paper trades found.');
    await pool.end();
    return;
  }

  // Normalize: prefer entry_data (point-in-time) over tokens table (latest score)
  const rows = trades.map((t) => {
    const ed = t.entry_data || {};
    return {
      id: t.id,
      symbol: t.symbol,
      entryScore: t.entry_score,
      D: ed.discoveryScore ?? t.t_discovery ?? null,
      F: ed.flowScore ?? t.t_flow ?? null,
      M: ed.mispricingScore ?? t.t_mispricing ?? null,
      S: ed.safetyScore ?? t.t_safety ?? null,
      pnlPct: t.final_pnl_pct,
      pnlSol: t.final_pnl_sol,
      holdMin: t.hold_time_minutes,
      exitReason: t.exit_reason,
      exitCat: exitCategory(t.exit_reason),
      liqAtEntry: t.liquidity_at_entry,
      holderCount: t.holder_count_at_entry,
      entryTs: new Date(t.entry_timestamp),
      pairAgeMin: ed.pairAgeMin ?? null,
      hasBirdeye: ed.hasBirdeye ?? null,
      marketCapUsd: ed.marketCapUsd ?? null,
      hasSubScores: ed.discoveryScore != null || t.t_discovery != null,
      hasEntryData: t.entry_data != null,
      // Flow deterioration metric
      flowDeterioration: (ed.txnsBuys1h != null && ed.txnsSells1h != null &&
        ed.txnsBuys5m != null && ed.txnsSells5m != null)
        ? (() => {
            const total1h = ed.txnsBuys1h + ed.txnsSells1h;
            const total5m = ed.txnsBuys5m + ed.txnsSells5m;
            if (total1h > 10 && total5m > 3) {
              return (ed.txnsBuys1h / total1h) - (ed.txnsBuys5m / total5m);
            }
            return null;
          })()
        : null,
    };
  });

  const winners = rows.filter((r) => r.pnlPct >= 0);
  const losers = rows.filter((r) => r.pnlPct < 0);

  // ══════════════════════════════════════════════════════
  // A. BASIC SAMPLE SUMMARY
  // ══════════════════════════════════════════════════════
  bar('A. BASIC SAMPLE SUMMARY');
  const avgWin = winners.length > 0 ? winners.reduce((s, r) => s + r.pnlPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, r) => s + r.pnlPct, 0) / losers.length : 0;
  const avgWinSol = winners.length > 0 ? winners.reduce((s, r) => s + r.pnlSol, 0) / winners.length : 0;
  const avgLossSol = losers.length > 0 ? losers.reduce((s, r) => s + r.pnlSol, 0) / losers.length : 0;
  const winRate = winners.length / rows.length;
  const expectancy = winRate * avgWinSol + (1 - winRate) * avgLossSol;
  const totalPnl = rows.reduce((s, r) => s + r.pnlSol, 0);

  console.log(`Closed paper trades:  ${rows.length}`);
  console.log(`Date range:           ${rows[0].entryTs.toISOString().slice(0, 10)} → ${rows[rows.length - 1].entryTs.toISOString().slice(0, 10)}`);
  console.log(`Winners:              ${winners.length} (${pct(winRate)})`);
  console.log(`Losers:               ${losers.length}`);
  console.log(`Avg winner:           ${fmt(avgWin, 1)}% (${fmt(avgWinSol, 4)} SOL)`);
  console.log(`Avg loser:            ${fmt(avgLoss, 1)}% (${fmt(avgLossSol, 4)} SOL)`);
  console.log(`Expectancy per trade: ${fmt(expectancy, 4)} SOL`);
  console.log(`Total PnL:            ${fmt(totalPnl, 4)} SOL`);
  console.log(`Trades with sub-scores: ${rows.filter(r => r.hasSubScores).length}/${rows.length}`);
  console.log(`Trades with entry_data: ${rows.filter(r => r.hasEntryData).length}/${rows.length}`);

  // Exit reason breakdown
  const exitCounts = {};
  for (const r of rows) exitCounts[r.exitCat] = (exitCounts[r.exitCat] || 0) + 1;
  console.log(`\nExit reasons:`);
  for (const [k, v] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(15)} ${v} (${pct(v / rows.length)})`);
  }

  // ══════════════════════════════════════════════════════
  // B. SCORE-BUCKET QUALITY
  // ══════════════════════════════════════════════════════
  bar('B. SCORE-BUCKET QUALITY');

  const buckets = {};
  for (const r of rows) {
    const b = bucket(r.entryScore);
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(r);
  }

  const bucketOrder = ['<65', '65-69', '70-74', '75-79', '80+', 'unknown'];
  console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'AvgHold'.padStart(8)} ${'StopLoss%'.padStart(10)}`);
  console.log('─'.repeat(52));
  for (const b of bucketOrder) {
    const group = buckets[b] || [];
    if (group.length === 0) continue;
    const w = group.filter(r => r.pnlPct >= 0);
    const avgPnl = group.reduce((s, r) => s + r.pnlPct, 0) / group.length;
    const avgH = group.reduce((s, r) => s + (r.holdMin || 0), 0) / group.length;
    const slRate = group.filter(r => r.exitCat === 'stop_loss').length / group.length;
    console.log(`${b.padEnd(10)} ${String(group.length).padStart(5)} ${pct(w.length / group.length).padStart(7)} ${fmt(avgPnl, 1).padStart(9)} ${fmt(avgH, 0).padStart(7)}m ${pct(slRate).padStart(10)}`);
  }

  // ══════════════════════════════════════════════════════
  // C. COMPONENT SEPARATION (Winners vs Losers)
  // ══════════════════════════════════════════════════════
  bar('C. COMPONENT SEPARATION — Winners vs Losers');

  const withScores = rows.filter(r => r.hasSubScores);
  const wScored = withScores.filter(r => r.pnlPct >= 0);
  const lScored = withScores.filter(r => r.pnlPct < 0);

  if (withScores.length < 5) {
    console.log(`Only ${withScores.length} trades have sub-scores. Need at least 5 for analysis.`);
    console.log(`Sub-scores will populate as new trades enter with entry_data.`);
  } else {
    const mean = (arr, key) => arr.length > 0 ? arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length : null;

    console.log(`${'Component'.padEnd(12)} ${'Winners'.padStart(9)} ${'Losers'.padStart(9)} ${'Delta'.padStart(9)} ${'Signal?'.padStart(9)}`);
    console.log('─'.repeat(50));
    for (const comp of [
      { key: 'D', label: 'Discovery' },
      { key: 'F', label: 'Flow' },
      { key: 'M', label: 'Mispricing' },
      { key: 'S', label: 'Safety' },
      { key: 'entryScore', label: 'Total' },
    ]) {
      const mW = mean(wScored, comp.key);
      const mL = mean(lScored, comp.key);
      const delta = mW != null && mL != null ? mW - mL : null;
      const signal = delta == null ? '?' : delta > 3 ? 'YES ▲' : delta < -3 ? 'ANTI ▼' : 'weak';
      console.log(`${comp.label.padEnd(12)} ${fmt(mW, 1).padStart(9)} ${fmt(mL, 1).padStart(9)} ${delta != null ? (delta > 0 ? '+' : '') + fmt(delta, 1) : 'N/A'.padStart(9)} ${signal.padStart(9)}`);
    }

    // AUC for each component
    console.log(`\nAUC (rank-based, 0.5 = random, >0.5 = predictive, <0.5 = anti-predictive):`);
    for (const comp of ['D', 'F', 'M', 'S', 'entryScore']) {
      const wVals = wScored.map(r => r[comp]).filter(v => v != null);
      const lVals = lScored.map(r => r[comp]).filter(v => v != null);
      const auc = computeAUC(wVals, lVals);
      const label = comp === 'entryScore' ? 'Total' : comp;
      const interp = auc == null ? 'insufficient data'
        : auc > 0.65 ? 'GOOD signal'
        : auc > 0.55 ? 'weak signal'
        : auc > 0.45 ? 'no signal (random)'
        : 'ANTI-predictive';
      console.log(`  ${label.padEnd(12)} AUC = ${auc != null ? fmt(auc, 3) : 'N/A'.padStart(5)}  (${interp})`);
    }
  }

  // ══════════════════════════════════════════════════════
  // D. CORRELATION / REDUNDANCY
  // ══════════════════════════════════════════════════════
  bar('D. CORRELATION MATRIX (D / F / M / S / Total)');

  if (withScores.length < 10) {
    console.log(`Only ${withScores.length} trades with sub-scores. Need 10+ for correlation analysis.`);
  } else {
    const components = ['D', 'F', 'M', 'S', 'entryScore'];
    const labels = ['D', 'F', 'M', 'S', 'Tot'];
    console.log(`${''.padEnd(6)} ${labels.map(l => l.padStart(6)).join(' ')}`);
    for (let i = 0; i < components.length; i++) {
      const vals_i = withScores.map(r => r[components[i]]).filter(v => v != null);
      const row = [labels[i].padEnd(6)];
      for (let j = 0; j < components.length; j++) {
        if (j < i) {
          row.push(''.padStart(6));
        } else {
          const vals_j = withScores.map(r => r[components[j]]).filter(v => v != null);
          // Align arrays (only rows where both have values)
          const pairs = withScores
            .map(r => [r[components[i]], r[components[j]]])
            .filter(([a, b]) => a != null && b != null);
          const corr = correlation(pairs.map(p => p[0]), pairs.map(p => p[1]));
          const flag = corr != null && Math.abs(corr) > 0.7 && i !== j ? ' !' : '';
          row.push((corr != null ? fmt(corr, 2) + flag : 'N/A').padStart(6));
        }
      }
      console.log(row.join(' '));
    }
    console.log(`\n  ! = collinear (|r| > 0.7) — components may be redundant`);
  }

  // ══════════════════════════════════════════════════════
  // E. THRESHOLD SWEEP
  // ══════════════════════════════════════════════════════
  bar('E. THRESHOLD SWEEP');

  const thresholds = [65, 68, 70, 72, 75];
  console.log(`${'Thresh'.padEnd(8)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'Expect SOL'.padStart(11)} ${'TotPnL SOL'.padStart(11)}`);
  console.log('─'.repeat(55));
  for (const th of thresholds) {
    const group = rows.filter(r => r.entryScore >= th);
    if (group.length === 0) {
      console.log(`${String(th).padEnd(8)} ${String(0).padStart(5)}    (no trades)`);
      continue;
    }
    const w = group.filter(r => r.pnlPct >= 0);
    const l = group.filter(r => r.pnlPct < 0);
    const wr = w.length / group.length;
    const avgP = group.reduce((s, r) => s + r.pnlPct, 0) / group.length;
    const awSol = w.length > 0 ? w.reduce((s, r) => s + r.pnlSol, 0) / w.length : 0;
    const alSol = l.length > 0 ? l.reduce((s, r) => s + r.pnlSol, 0) / l.length : 0;
    const exp = wr * awSol + (1 - wr) * alSol;
    const tot = group.reduce((s, r) => s + r.pnlSol, 0);
    console.log(`${String(th).padEnd(8)} ${String(group.length).padStart(5)} ${pct(wr).padStart(7)} ${fmt(avgP, 1).padStart(9)} ${fmt(exp, 4).padStart(11)} ${fmt(tot, 4).padStart(11)}`);
  }

  // ══════════════════════════════════════════════════════
  // F. FLOW-DETERIORATION PATCH EVALUATION
  // ══════════════════════════════════════════════════════
  bar('F. FLOW-DETERIORATION PATCH EVALUATION');

  const before = rows.filter(r => r.entryTs < FLOW_DETERIORATION_DEPLOY);
  const after = rows.filter(r => r.entryTs >= FLOW_DETERIORATION_DEPLOY);

  const cohortStats = (group, label) => {
    if (group.length === 0) {
      console.log(`  ${label}: 0 trades (no data)`);
      return;
    }
    const w = group.filter(r => r.pnlPct >= 0);
    const l = group.filter(r => r.pnlPct < 0);
    const wr = w.length / group.length;
    const avgL = l.length > 0 ? l.reduce((s, r) => s + r.pnlPct, 0) / l.length : 0;
    const fastDeaths = group.filter(r => r.pnlPct < 0 && (r.holdMin || 999) < 15).length;
    const slRate = group.filter(r => r.exitCat === 'stop_loss').length / group.length;
    const exp = wr * (w.length > 0 ? w.reduce((s, r) => s + r.pnlSol, 0) / w.length : 0)
      + (1 - wr) * (l.length > 0 ? l.reduce((s, r) => s + r.pnlSol, 0) / l.length : 0);
    console.log(`  ${label}:`);
    console.log(`    Trades:          ${group.length}`);
    console.log(`    Win rate:        ${pct(wr)}`);
    console.log(`    Avg loser:       ${fmt(avgL, 1)}%`);
    console.log(`    Fast deaths:     ${fastDeaths} (${pct(fastDeaths / group.length)} of trades < 15m losing exit)`);
    console.log(`    Stop-loss rate:  ${pct(slRate)}`);
    console.log(`    Expectancy:      ${fmt(exp, 4)} SOL/trade`);
  };

  console.log(`  Deploy timestamp: ${FLOW_DETERIORATION_DEPLOY.toISOString()}`);
  cohortStats(before, 'BEFORE flow-deterioration');
  cohortStats(after, 'AFTER flow-deterioration');

  if (after.length < 10) {
    console.log(`\n  ⚠ Post-patch sample is too small (${after.length} trades). Need 10+ to draw conclusions.`);
  }

  // ══════════════════════════════════════════════════════
  // G. FRESHNESS / TIMING CHECKS
  // ══════════════════════════════════════════════════════
  bar('G. FRESHNESS & TIMING');

  // By pair age at entry
  const withAge = rows.filter(r => r.pairAgeMin != null);
  if (withAge.length < 5) {
    console.log(`  Pair age data available for ${withAge.length} trades (need entry_data column).`);
    console.log(`  This section will populate as new trades enter with entry_data.`);
  } else {
    console.log(`  Pair age at entry (${withAge.length} trades with data):`);
    const ageBuckets = {};
    for (const r of withAge) {
      const b = ageBucket(r.pairAgeMin);
      if (!ageBuckets[b]) ageBuckets[b] = [];
      ageBuckets[b].push(r);
    }
    console.log(`  ${'Age'.padEnd(10)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of ['0-15m', '15-30m', '30-60m', '60m+']) {
      const g = ageBuckets[b] || [];
      if (g.length === 0) continue;
      const w = g.filter(r => r.pnlPct >= 0);
      const avg = g.reduce((s, r) => s + r.pnlPct, 0) / g.length;
      const sl = g.filter(r => r.exitCat === 'stop_loss').length / g.length;
      console.log(`  ${b.padEnd(10)} ${String(g.length).padStart(5)} ${pct(w.length / g.length).padStart(7)} ${fmt(avg, 1).padStart(9)} ${pct(sl).padStart(7)}`);
    }
  }

  // By liquidity at entry
  const withLiq = rows.filter(r => r.liqAtEntry != null);
  if (withLiq.length >= 5) {
    console.log(`\n  Liquidity at entry (${withLiq.length} trades with data):`);
    const liqBuckets = {};
    for (const r of withLiq) {
      const b = liqBucket(r.liqAtEntry);
      if (!liqBuckets[b]) liqBuckets[b] = [];
      liqBuckets[b].push(r);
    }
    console.log(`  ${'Liquidity'.padEnd(12)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'AvgPnL%'.padStart(9)} ${'SL%'.padStart(7)}`);
    for (const b of ['<$25k', '$25-50k', '$50-100k', '$100k+']) {
      const g = liqBuckets[b] || [];
      if (g.length === 0) continue;
      const w = g.filter(r => r.pnlPct >= 0);
      const avg = g.reduce((s, r) => s + r.pnlPct, 0) / g.length;
      const sl = g.filter(r => r.exitCat === 'stop_loss').length / g.length;
      console.log(`  ${b.padEnd(12)} ${String(g.length).padStart(5)} ${pct(w.length / g.length).padStart(7)} ${fmt(avg, 1).padStart(9)} ${pct(sl).padStart(7)}`);
    }
  }

  // ══════════════════════════════════════════════════════
  // H. FINAL VERDICT
  // ══════════════════════════════════════════════════════
  bar('H. FINAL VERDICT');

  // Compute AUC for total score if we have enough data
  const allWinScores = winners.map(r => r.entryScore).filter(v => v != null);
  const allLoseScores = losers.map(r => r.entryScore).filter(v => v != null);
  const totalAuc = computeAUC(allWinScores, allLoseScores);

  console.log(`1. Does total score separate winners from losers?`);
  if (totalAuc == null) {
    console.log(`   Cannot compute — insufficient data.`);
  } else if (totalAuc > 0.60) {
    console.log(`   YES — AUC ${fmt(totalAuc, 3)} shows meaningful separation.`);
  } else if (totalAuc > 0.52) {
    console.log(`   WEAK — AUC ${fmt(totalAuc, 3)} shows marginal separation. Not reliable.`);
  } else if (totalAuc > 0.48) {
    console.log(`   NO — AUC ${fmt(totalAuc, 3)} is essentially random. Score has no predictive power.`);
  } else {
    console.log(`   ANTI-PREDICTIVE — AUC ${fmt(totalAuc, 3)} means higher scores predict WORSE outcomes.`);
  }

  if (withScores.length >= 5) {
    // Find strongest component
    const compAucs = {};
    for (const comp of ['D', 'F', 'M', 'S']) {
      const wV = wScored.map(r => r[comp]).filter(v => v != null);
      const lV = lScored.map(r => r[comp]).filter(v => v != null);
      compAucs[comp] = computeAUC(wV, lV);
    }
    const sorted = Object.entries(compAucs).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);

    console.log(`\n2. Strongest component: ${sorted.length > 0 ? sorted[0][0] + ' (AUC ' + fmt(sorted[0][1], 3) + ')' : 'unknown'}`);
    console.log(`3. Weakest component:   ${sorted.length > 0 ? sorted[sorted.length - 1][0] + ' (AUC ' + fmt(sorted[sorted.length - 1][1], 3) + ')' : 'unknown'}`);

    if (sorted.length > 0 && sorted[sorted.length - 1][1] < 0.45) {
      console.log(`   ⚠ ${sorted[sorted.length - 1][0]} appears ANTI-PREDICTIVE — consider reducing its weight or reworking it.`);
    }
  } else {
    console.log(`\n2-3. Component analysis requires sub-scores (entry_data). Will populate with new trades.`);
  }

  // Threshold assessment
  const t70 = rows.filter(r => r.entryScore >= 70);
  const t72 = rows.filter(r => r.entryScore >= 72);
  const exp70 = t70.length > 0 ? (() => {
    const w = t70.filter(r => r.pnlPct >= 0);
    const l = t70.filter(r => r.pnlPct < 0);
    const wr = w.length / t70.length;
    return wr * (w.length > 0 ? w.reduce((s, r) => s + r.pnlSol, 0) / w.length : 0)
      + (1 - wr) * (l.length > 0 ? l.reduce((s, r) => s + r.pnlSol, 0) / l.length : 0);
  })() : null;
  const exp72 = t72.length > 0 ? (() => {
    const w = t72.filter(r => r.pnlPct >= 0);
    const l = t72.filter(r => r.pnlPct < 0);
    const wr = w.length / t72.length;
    return wr * (w.length > 0 ? w.reduce((s, r) => s + r.pnlSol, 0) / w.length : 0)
      + (1 - wr) * (l.length > 0 ? l.reduce((s, r) => s + r.pnlSol, 0) / l.length : 0);
  })() : null;

  console.log(`\n4. Is threshold 70 supported?`);
  if (exp70 != null && exp72 != null) {
    if (exp72 > exp70 && exp72 > 0) {
      console.log(`   NO — threshold 72 has better expectancy (${fmt(exp72, 4)} vs ${fmt(exp70, 4)} SOL). Consider raising.`);
    } else if (exp70 > 0) {
      console.log(`   YES — threshold 70 has positive expectancy (${fmt(exp70, 4)} SOL).`);
    } else {
      console.log(`   INCONCLUSIVE — both 70 and 72 have negative expectancy. Problem is deeper than threshold.`);
    }
  } else {
    console.log(`   Insufficient data for threshold comparison.`);
  }

  console.log(`\n5. Flow-deterioration patch evidence?`);
  if (after.length < 10) {
    console.log(`   TOO EARLY — only ${after.length} post-patch trades. Need 10+ to evaluate.`);
  } else {
    const beforeFD = before.filter(r => r.pnlPct < 0 && (r.holdMin || 999) < 15).length;
    const afterFD = after.filter(r => r.pnlPct < 0 && (r.holdMin || 999) < 15).length;
    const bRate = before.length > 0 ? beforeFD / before.length : 0;
    const aRate = after.length > 0 ? afterFD / after.length : 0;
    if (aRate < bRate * 0.7) {
      console.log(`   YES — fast-death rate dropped from ${pct(bRate)} to ${pct(aRate)}.`);
    } else if (aRate < bRate) {
      console.log(`   MARGINAL — fast-death rate slightly lower (${pct(bRate)} → ${pct(aRate)}).`);
    } else {
      console.log(`   NO EVIDENCE — fast-death rate unchanged or worse (${pct(bRate)} → ${pct(aRate)}).`);
    }
  }

  console.log(`\n6. Single highest-value next experiment:`);
  if (totalAuc != null && totalAuc < 0.52) {
    console.log(`   The total score has no predictive power. Before tuning thresholds or components,`);
    console.log(`   run a feature-importance analysis on raw DexScreener metrics vs. PnL outcome.`);
    console.log(`   The current component weights (D:25/F:30/M:25/S:20) may be fundamentally wrong.`);
  } else if (withScores.length >= 10) {
    const weakest = Object.entries(compAucs || {}).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
    if (weakest.length > 0 && weakest[0][1] < 0.45) {
      console.log(`   Rework the ${weakest[0][0]} component — it's anti-predictive (AUC ${fmt(weakest[0][1], 3)}).`);
      console.log(`   Either reduce its weight to 0.10 or redesign its internal signals.`);
    } else {
      console.log(`   Collect more trades with entry_data for sub-score analysis.`);
      console.log(`   Current component AUCs are inconclusive — need 30+ trades with entry_data.`);
    }
  } else {
    console.log(`   Collect trades with the new entry_data column, then re-run this analysis.`);
    console.log(`   Target: 30+ trades with sub-scores for reliable AUC computation.`);
  }

  console.log('');
  await pool.end();
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
