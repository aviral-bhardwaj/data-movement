const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const logger = require('./logger');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`
    );
    logger.info('schema migrated');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      logger.error('migration failed', { err: e.message });
      process.exit(1);
    });
}

module.exports = migrate;
