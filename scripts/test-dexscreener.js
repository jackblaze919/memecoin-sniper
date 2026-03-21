require('dotenv').config();
const dexscreener = require('../src/apis/dexscreener');

async function main() {
  console.log('Testing DexScreener API...\n');

  try {
    console.log('1. Latest token profiles...');
    const profiles = await dexscreener.getLatestTokenProfiles();
    console.log(`   Found ${profiles.length} Solana token profiles`);
    if (profiles.length > 0) {
      console.log(`   First: ${profiles[0].address}`);
    }

    console.log('\n2. Search for SOL...');
    const results = await dexscreener.search('SOL');
    console.log(`   Found ${results.length} pairs`);
    if (results.length > 0) {
      const first = results[0];
      console.log(`   Top: ${first.symbol} | $${first.priceUsd} | Liq: $${first.liquidityUsd}`);
    }

    console.log('\n✅ DexScreener API working');
  } catch (err) {
    console.error('❌ DexScreener test failed:', err.message);
    process.exit(1);
  }
}

main();
