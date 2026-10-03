const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('../core/config');
const logger = require('../core/logger');
const { errorHandler } = require('../core/errors');
const migrate = require('../core/migrate');
const { syncConnectorDefs } = require('../seed/connectorDefs');

const authRoutes = require('../routes/auth.routes');
const catalogRoutes = require('../routes/catalog.routes');
const connectionRoutes = require('../routes/connections.routes');
const opsRoutes = require('../routes/ops.routes');
const webhookRoutes = require('../routes/webhook.routes');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.use('/api/auth', authRoutes);
app.use('/api', opsRoutes);            // /api/health (public), /api/webhooks, /api/syncs /api/logs /api/metrics (auth)
app.use('/api/connections', connectionRoutes);
app.use('/api', catalogRoutes);        // /api/connectors /api/sources /api/destinations
app.use('/webhooks', webhookRoutes);   // public webhook ingest: POST /webhooks/:token

// serve built frontend if present
const distDir = path.resolve(__dirname, '../../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use(errorHandler);

async function main() {
  await migrate();
  await syncConnectorDefs();
  app.listen(config.apiPort, () => {
    logger.info(`DataMove API listening on :${config.apiPort}`, { port: config.apiPort });
  });
}

main().catch((e) => {
  logger.error('api failed to start', { err: e.message, stack: e.stack });
  process.exit(1);
});
