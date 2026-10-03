const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// BigQuery destination — uses @google-cloud/bigquery when installed
// (`npm i @google-cloud/bigquery` in backend/). Streams rows via insertAll.
class BigQueryDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-bigquery';
    this.displayName = 'BigQuery';
    this.description = 'Stream rows into Google BigQuery tables with auto schema. Requires @google-cloud/bigquery.';
    this.icon = '📊';
    this.category = 'Warehouse';
    this.catalogSlug = 'bigquery';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['projectId', 'datasetId'],
        properties: {
          projectId: { type: 'string' },
          datasetId: { type: 'string', default: 'datamove' },
          credentialsJson: { type: 'string', title: 'Service account JSON (or use GOOGLE_APPLICATION_CREDENTIALS)', airbyte_secret: true },
          location: { type: 'string', default: 'US' },
        },
      },
    };
  }

  _client(cfg) {
    let BigQuery;
    try { ({ BigQuery } = require('@google-cloud/bigquery')); }
    catch { throw new Error('@google-cloud/bigquery not installed: run `npm i @google-cloud/bigquery` in backend/'); }
    const opts = { projectId: cfg.projectId };
    if (cfg.credentialsJson) opts.credentials = JSON.parse(cfg.credentialsJson);
    return new BigQuery(opts);
  }

  async check(cfg) {
    try {
      const bq = this._client(cfg);
      await bq.dataset(cfg.datasetId || 'datamove').exists();
      return { status: 'SUCCEEDED' };
    } catch (e) { return { status: 'FAILED', message: e.message }; }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const bq = this._client(cfg);
    const stats = { streams: {}, bytes: 0 };
    const [dataset] = await bq.dataset(cfg.datasetId || 'datamove').get({ autoCreate: true });
    const buffers = new Map();

    for await (const msg of messageStream) {
      if (msg.type === 'STATE') { if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state); continue; }
      if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
      if (msg.type !== 'RECORD') continue;
      const buf = buffers.get(msg.stream) || [];
      buf.push({ ...msg.data, _dm_synced_at: new Date().toISOString() });
      buffers.set(msg.stream, buf);
      stats.bytes += JSON.stringify(msg.data).length;
    }

    for (const [stream, rows] of buffers) {
      const sc = catalog.streams.find((s) => s.name === stream) || {};
      const st = (stats.streams[stream] ||= { written: 0, failed: 0 });
      const tableId = sanitizeName(sc.destinationName || stream);
      const [table] = await dataset.table(tableId).get({ autoCreate: true }).catch(async () => {
        await dataset.createTable(tableId, { schema: { fields: [{ name: '_dm_synced_at', type: 'TIMESTAMP' }] } });
        return dataset.table(tableId).get();
      });
      if (sc.syncMode === 'full_refresh') {
        await bq.query(`TRUNCATE TABLE \`${cfg.projectId}.${cfg.datasetId || 'datamove'}.${tableId}\``).catch(() => {});
      }
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        try {
          await table.insert(chunk, { ignoreUnknownValues: true });
          st.written += chunk.length;
        } catch (e) {
          st.failed += chunk.length;
          ctx.logger?.('error', `bigquery insert failed: ${e.message}`);
        }
      }
    }
    return stats;
  }
}

module.exports = new BigQueryDestination();
