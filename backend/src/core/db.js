const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 15,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => logger.error('pg pool error', { err: err.message }));

async function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

module.exports = { pool, query, tx, one, many };
