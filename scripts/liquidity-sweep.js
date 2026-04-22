#!/usr/bin/env node
/**
 * Raw Liquidity Threshold Sweep — Which min-liquidity cutoff maximizes expectancy?
 *
 * Runs against existing post-240m closed trades with entry_data snapshots.
 * Tests $50k, $75k, $100k thresholds on the SAME dataset (no new trades needed).
 *
 * Usage:
 *   DATABASE_URL=<url> node scripts/liquidity-sweep.js
 *   DATABASE_URL=<url> node scripts/liquidity-sweep.js --since 2026-04-09
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const args = process.argv.slice(2);
let sinceDate = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) sinceDate = new Date(args[i + 1]).toISOString();
}

const fmt = (n, d = 4) => n != null ? n.toFixed(d) : 'N/A';
const pct = (n) => (n * 100).toFixed(1) + '%';

async function main() {
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
    console.log(`Only ${rows.length} trades. Need 20+ for threshold sweep.`);
    await pool.end();
    return;
  }

  // Normalize — use entry_data.liquidityUsd if available, fall back to liquidity_at_entry
  const trades = rows.map(r => {
    const ed = r.entry_data || {};
    return {
      id: r.id,
      symbol: r.symbol,
      pnlPct: r.final_pnl_pct,
      pnlSol: r.final_pnl_sol,
      holdMin: r.hold_time_minutes,
      exitReason: r.exit_reason || '',
      liq: ed.liquidityUsd ?? r.liquidity_at_entry ?? null,
      entryTs: new Date(r.entry_timestamp),
    };
  }).filter(t => t.liq != null);

  console.log(`Total trades with liquidity data: ${trades.length}`);
  const dateRange = `${trades[0].entryTs.toISOString().slice(0, 10)} → ${trades[trades.length - 1].entryTs.toISOString().slice(0, 10)}`;
  const totalDays = Math.max(1, (trades[trades.length - 1].entryTs - trades[0].entryTs) / 86400000);
  console.log(`Date range: ${dateRange} (${totalDays.toFixed(1)} days)\n`);

  const thresholds = [25000, 50000, 75000, 100000, 125000];

  console.log('═'.repeat(100));
  console.log('  LIQUIDITY THRESHOLD SWEEP');
  console.log('═'.repeat(100));
  console.log(`${'Threshold'.padEnd(12)} ${'N'.padStart(5)} ${'Buys/day'.padStart(9)} ${'Win%'.padStart(7)} ${'AvgWin%'.padStart(9)} ${'AvgLoss%'.padStart(9)} ${'SL%'.padStart(7)} ${'Expect SOL'.padStart(11)} ${'TotPnL SOL'.padStart(11)} ${'MaxDay%PnL'.padStart(10)}`);
  console.log('─'.repeat(100));

  for (const th of thresholds) {
    const group = trades.filter(t => t.liq >= th);
    if (group.length < 3) {
      console.log(`$${(th / 1000).toFixed(0)}k`.padEnd(12) + `${String(group.length).padStart(5)}    (too few trades)`);
      continue;
    }

    const winners = group.filter(t => t.pnlPct >= 0);
    const losers = group.filter(t => t.pnlPct < 0);
    const winRate = winners.length / group.length;
    const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;
    const avgWinSol = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlSol, 0) / winners.length : 0;
    const avgLossSol = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlSol, 0) / losers.length : 0;
    const expectancy = winRate * avgWinSol + (1 - winRate) * avgLossSol;
    const totalPnl = group.reduce((s, t) => s + t.pnlSol, 0);
    const slCount = group.filter(t => t.exitReason.includes('Stop loss')).length;
    const slRate = slCount / group.length;
    const buysPerDay = group.length / totalDays;

    // Concentration check: largest single day as % of total PnL
    const dayPnl = {};
    for (const t of group) {
      const day = t.entryTs.toISOString().slice(0, 10);
      dayPnl[day] = (dayPnl[day] || 0) + t.pnlSol;
    }
    const maxDayPnl = Math.max(...Object.values(dayPnl));
    const maxDayPct = totalPnl > 0 ? (maxDayPnl / totalPnl) * 100 : 0;

    console.log(
      `$${(th / 1000).toFixed(0)}k`.padEnd(12) +
      `${String(group.length).padStart(5)} ` +
      `${buysPerDay.toFixed(1).padStart(9)} ` +
      `${pct(winRate).padStart(7)} ` +
      `${('+' + avgWin.toFixed(1) + '%').padStart(9)} ` +
      `${(avgLoss.toFixed(1) + '%').padStart(9)} ` +
      `${pct(slRate).padStart(7)} ` +
      `${fmt(expectancy).padStart(11)} ` +
      `${fmt(totalPnl).padStart(11)} ` +
      `${maxDayPct.toFixed(0).padStart(9)}%`
    );
  }

  // Detailed breakdown for the key thresholds
  console.log('\n' + '═'.repeat(80));
  console.log('  DETAILED COMPARISON: $75k vs $100k');
  console.log('═'.repeat(80));

  for (const th of [75000, 100000]) {
    const group = trades.filter(t => t.liq >= th);
    if (group.length < 5) continue;

    const winners = group.filter(t => t.pnlPct >= 0);
    const losers = group.filter(t => t.pnlPct < 0);

    // Exit reason breakdown
    const exitCats = {};
    for (const t of group) {
      let cat = 'other';
      if (t.exitReason.includes('Stop loss')) cat = 'stop_loss';
      else if (t.exitReason.includes('Max hold')) cat = 'max_hold';
      else if (t.exitReason.includes('Liquidity')) cat = 'liq_drop';
      else if (t.exitReason.includes('sell') || t.exitReason.includes('final')) cat = 'target';
      exitCats[cat] = (exitCats[cat] || 0) + 1;
    }

    // Day-by-day PnL
    const dayPnl = {};
    const dayCount = {};
    for (const t of group) {
      const day = t.entryTs.toISOString().slice(0, 10);
      dayPnl[day] = (dayPnl[day] || 0) + t.pnlSol;
      dayCount[day] = (dayCount[day] || 0) + 1;
    }
    const positiveDays = Object.values(dayPnl).filter(v => v > 0).length;
    const negativeDays = Object.values(dayPnl).filter(v => v <= 0).length;

    console.log(`\n  ≥$${(th / 1000).toFixed(0)}k: ${group.length} trades`);
    console.log(`  Win/Loss: ${winners.length}W / ${losers.length}L`);
    console.log(`  Exits: ${Object.entries(exitCats).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    console.log(`  Positive days: ${positiveDays} / ${positiveDays + negativeDays}`);
    console.log(`  Avg hold: ${(group.reduce((s, t) => s + (t.holdMin || 0), 0) / group.length).toFixed(0)} min`);
  }

  // The $50k-$100k gap — what are we cutting?
  console.log('\n' + '═'.repeat(80));
  console.log('  WHAT GETS CUT: trades between $50k-$100k liquidity');
  console.log('═'.repeat(80));

  const cutGroup = trades.filter(t => t.liq >= 50000 && t.liq < 100000);
  if (cutGroup.length > 0) {
    const w = cutGroup.filter(t => t.pnlPct >= 0);
    const totalCutPnl = cutGroup.reduce((s, t) => s + t.pnlSol, 0);
    const sl = cutGroup.filter(t => t.exitReason.includes('Stop loss')).length;
    console.log(`  Trades: ${cutGroup.length}`);
    console.log(`  Win rate: ${pct(w.length / cutGroup.length)}`);
    console.log(`  Total PnL: ${fmt(totalCutPnl)} SOL`);
    console.log(`  Stop-loss rate: ${pct(sl / cutGroup.length)}`);
    console.log(`  Verdict: ${totalCutPnl > 0 ? 'CUTTING THESE LOSES MONEY' : 'Cutting these saves money'}`);
  }

  const cutGroup2 = trades.filter(t => t.liq >= 25000 && t.liq < 50000);
  if (cutGroup2.length > 0) {
    const w = cutGroup2.filter(t => t.pnlPct >= 0);
    const totalCutPnl = cutGroup2.reduce((s, t) => s + t.pnlSol, 0);
    console.log(`\n  $25k-$50k bucket: ${cutGroup2.length} trades, ${pct(w.length / cutGroup2.length)} win, ${fmt(totalCutPnl)} SOL total PnL`);
  }

  console.log('');
  await pool.end();
}

main().catch(err => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
