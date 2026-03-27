#!/usr/bin/env node
/**
 * Verify that new paper trades are storing complete entry_data snapshots.
 *
 * Usage:
 *   node scripts/verify-entry-data.js          # check last 5 trades
 *   node scripts/verify-entry-data.js --count 10
 *
 * Checks for: sub-scores (D/F/M/S), pairAgeMin, volume metrics,
 * version metadata (strategyVersion, rankerVersion, gitCommit, etc.)
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const count = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--count') || '5');

const REQUIRED_FIELDS = [
  'discoveryScore', 'flowScore', 'mispricingScore', 'safetyScore',
  'pairAgeMin', 'volume1h', 'volume5m', 'txnsBuys1h', 'txnsSells1h',
  'txnsBuys5m', 'txnsSells5m', 'hasBirdeye',
  'strategyVersion', 'rankerVersion', 'gitCommit',
  'flowDeteriorationEnabled', 'buyThreshold', 'entryTimestampIso',
];

async function main() {
  const { rows } = await pool.query(`
    SELECT id, symbol, entry_score, entry_timestamp, entry_data
    FROM positions
    WHERE mode = 'paper'
    ORDER BY entry_timestamp DESC
    LIMIT $1
  `, [count]);

  if (rows.length === 0) {
    console.log('No paper trades found.');
    await pool.end();
    return;
  }

  console.log(`Checking last ${rows.length} paper trades for entry_data completeness:\n`);

  let allGood = true;
  for (const row of rows) {
    const ts = new Date(row.entry_timestamp).toISOString().slice(0, 19);
    const hasData = row.entry_data != null;
    const ed = row.entry_data || {};

    console.log(`#${row.id} ${(row.symbol || '?').padEnd(15)} Score: ${row.entry_score?.toFixed(1) || 'N/A'}  ${ts}`);

    if (!hasData) {
      console.log(`  ❌ entry_data is NULL (pre-patch trade)`);
      allGood = false;
      continue;
    }

    const missing = REQUIRED_FIELDS.filter(f => ed[f] == null);
    const present = REQUIRED_FIELDS.filter(f => ed[f] != null);

    if (missing.length === 0) {
      console.log(`  ✅ All ${REQUIRED_FIELDS.length} fields present`);
      console.log(`     D:${ed.discoveryScore?.toFixed(0)} F:${ed.flowScore?.toFixed(0)} M:${ed.mispricingScore?.toFixed(0)} S:${ed.safetyScore?.toFixed(0)}`);
      console.log(`     v${ed.strategyVersion} / ranker ${ed.rankerVersion} / ${ed.gitCommit}`);
      console.log(`     flowDet: ${ed.flowDeteriorationEnabled} | threshold: ${ed.buyThreshold} | birdeye: ${ed.hasBirdeye}`);
      console.log(`     pairAge: ${ed.pairAgeMin?.toFixed(0)}m | vol1h: $${ed.volume1h?.toFixed(0)} | vol5m: $${ed.volume5m?.toFixed(0)}`);
    } else {
      console.log(`  ⚠ ${present.length}/${REQUIRED_FIELDS.length} fields present, missing: ${missing.join(', ')}`);
      allGood = false;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (allGood) {
    console.log(`✅ All ${rows.length} trades have complete entry_data. Pipeline is working.`);
  } else {
    console.log(`⚠ Some trades missing entry_data. Trades before the patch will have NULL — this is expected.`);
    console.log(`  Only trades after commit 3b951c4 (2026-03-27) will have full entry_data.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Verify failed:', err.message);
  process.exit(1);
});
