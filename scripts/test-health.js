require('dotenv').config();
const health = require('../src/health');
const telegram = require('../src/telegram');
const logger = require('../src/logger');

async function main() {
  console.log('Running health checks...\n');

  // Init telegram for the test
  telegram.init();

  const result = await health.runAll();

  for (const [name, check] of Object.entries(result.checks)) {
    const icon = check.ok ? '✅' : '❌';
    console.log(`${icon} ${name}${check.error ? ': ' + check.error : ''}${check.note ? ' (' + check.note + ')' : ''}`);
  }

  console.log(`\nOverall: ${result.healthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);

  telegram.shutdown();
  const db = require('../src/db');
  await db.shutdown();
  process.exit(result.healthy ? 0 : 1);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
