const db = require('../core/db');
const migrate = require('../core/migrate');
const { syncConnectorDefs } = require('./connectorDefs');
const { bcrypt } = require('../core/auth');
const logger = require('../core/logger');

// Seeds the admin user and connector catalog. Idempotent.
async function seed() {
  await migrate();
  await syncConnectorDefs();

  const admin = await db.one(`SELECT id FROM users WHERE email='admin@datamove.local'`);
  if (!admin) {
    const hash = await bcrypt.hash('admin123', 10);
    await db.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ('admin@datamove.local','Admin',$1,'admin')`,
      [hash]
    );
    logger.info('seeded admin user: admin@datamove.local / admin123');
  }
}

if (require.main === module) {
  seed()
    .then(async () => { logger.info('seed complete'); await db.pool.end(); process.exit(0); })
    .catch((e) => { logger.error('seed failed', { err: e.message }); process.exit(1); });
}

module.exports = seed;
