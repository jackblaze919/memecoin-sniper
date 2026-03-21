const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected pool error');
    });
  }
  return pool;
}

async function query(text, params) {
  const start = Date.now();
  try {
    const result = await getPool().query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn({ duration, query: text.substring(0, 80) }, 'Slow query');
    }
    return result;
  } catch (err) {
    logger.error({ err, query: text.substring(0, 80) }, 'Query error');
    throw err;
  }
}

async function testConnection() {
  const result = await query('SELECT NOW()');
  return result.rows[0];
}

async function shutdown() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, testConnection, shutdown, getPool };
