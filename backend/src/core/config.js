const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/datamove',
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  },
  apiPort: parseInt(process.env.API_PORT || '8080', 10),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:8080',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  worker: {
    id: process.env.WORKER_ID || `worker-${process.pid}`,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '1000', 10),
    maxRecordErrors: parseInt(process.env.MAX_RECORD_ERRORS || '1000', 10),
  },
  schedulerTickSeconds: parseInt(process.env.SCHEDULER_TICK_SECONDS || '15', 10),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  smtpUrl: process.env.SMTP_URL || '',
  // Relative paths anchor at the repo root so services run identically from any cwd.
  dataDir: path.isAbsolute(process.env.DATA_DIR || '')
    ? process.env.DATA_DIR
    : path.resolve(__dirname, '../../../', process.env.DATA_DIR || 'data'),
};

module.exports = config;
