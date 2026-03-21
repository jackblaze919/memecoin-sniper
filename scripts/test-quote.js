require('dotenv').config();
const jupiter = require('../src/apis/jupiter');

async function main() {
  console.log('Testing Jupiter quote (SOL -> USDC, 0.001 SOL)...\n');

  try {
    const quote = await jupiter.testQuote();
    console.log('Quote received:');
    console.log(`  Input: ${quote.inAmount} lamports (SOL)`);
    console.log(`  Output: ${quote.outAmount} (USDC atomic units)`);
    console.log(`  Price impact: ${quote.priceImpactPct}%`);
    console.log(`  Route steps: ${quote.routePlan.length}`);
    console.log('\n✅ Jupiter quote working');
  } catch (err) {
    console.error('❌ Jupiter quote failed:', err.message);
    process.exit(1);
  }
}

main();
