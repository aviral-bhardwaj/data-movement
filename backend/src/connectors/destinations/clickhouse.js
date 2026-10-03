const axios = require('axios');
const { BaseDestination } = require('../base');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

// ClickHouse destination — HTTP interface (8123), JSONEachRow inserts,
// ReplacingMergeTree for upsert-like behavior.
class ClickhouseDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-clickhouse';
    this.displayName = 'ClickHouse';
    this.description = 'Load data into ClickHouse over HTTP with auto table creation.';
    this.icon = '⚡';
    this.category = 'Warehouse';
    this.catalogSlug = 'clickhouse-cloud';
    this.badge = 'Partner-Built';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host'],
        properties: {
          host: { type: 'string', default: 'http://localhost:8123' },
          database: { type: 'string', default: 'datamove' },
          user: { type: 'string', default: 'default' },
          password: { type: 'string', airbyte_secret: true },
        },
      },
    };
  }

  _client(cfg) {
    return axios.create({
      baseURL: (cfg.host || 'http://localhost:8123').replace(/\/+$/, ''),
      auth: cfg.user || cfg.password ? { username: cfg.user || 'default', password: cfg.password || '' } : undefined,
      timeout: 120000,
      validateStatus: (s) => s < 500,
    });
  }

  async check(cfg) {
    try {
      const res = await this._client(cfg).post('/', 'SELECT 1');
      return res.status === 200 ? { status: 'SUCCEEDED' } : { status: 'FAILED', message: `HTTP ${res.status}: ${res.data}` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  _typeOf(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? 'Int64' : 'Float64';
    if (typeof v === 'boolean') return 'Bool';
    if (v !== null && typeof v === 'object') return 'String';   // JSON serialized
    if (v instanceof Date) return 'DateTime64(3)';
    return 'String';
  }

  async _query(c, sql) {
    const res = await c.post('/', sql);
    if (res.status >= 400) throw new Error(`ClickHouse ${res.status}: ${String(res.data).slice(0, 300)}`);
    return res;
  }

  async write(cfg, catalog, messageStream, ctx) {
    const c = this._client(cfg);
    const stats = { streams: {}, bytes: 0 };
    const db = cfg.database || 'datamove';
    await this._query(c, `CREATE DATABASE IF NOT EXISTS \`${db}\``);

    const tables = new Map();
    const getTable = async (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, qualified: `\`${db}\`.\`${table}\``,
          pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(),
          truncated: false,
          syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        const cols = Object.keys(t.schemaProps).map((n) => `\`${sanitizeName(n)}\` String`);
        const orderBy = t.pk.length ? `(${t.pk.map((p) => `\`${p}\``).join(',')})` : 'tuple()';
        await this._query(c, `CREATE TABLE IF NOT EXISTS ${t.qualified} (
          ${cols.join(',')}${cols.length ? ',' : ''}
          _dm_synced_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = ${t.pk.length ? `ReplacingMergeTree(_dm_synced_at) ORDER BY ${orderBy}` : 'MergeTree ORDER BY tuple()'}`);
        for (const n of Object.keys(t.schemaProps)) t.columns.set(sanitizeName(n), 'String');
        tables.set(streamName, t);
      }
      return tables.get(streamName);
    };

    const buffer = new Map();
    const flush = async (streamName) => {
      const rows = buffer.get(streamName);
      if (!rows?.length) return;
      buffer.set(streamName, []);
      const t = await getTable(streamName);
      const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
      const isDelete = rows[0]._cdc?.op === 'd';
      if (!isDelete && t.syncMode === 'full_refresh' && !t.truncated) {
        await this._query(c, `TRUNCATE TABLE ${t.qualified}`).catch(() => {});
        t.truncated = true;
      }
      const cols = [...t.columns.keys()];
      const lines = rows.map(({ data }) => {
        const out = {};
        for (const cname of cols) {
          const v = data[cname];
          out[cname] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
        }
        if (isDelete) out._dm_deleted = 1;
        return JSON.stringify(out);
      });
      try {
        // ClickHouse has no deletes on MergeTree; deletes land as a flagged row
        await this._query(c, `INSERT INTO ${t.qualified} (${cols.map((x) => `\`${x}\``).join(',')}) FORMAT JSONEachRow\n${lines.join('\n')}`);
        st.written += rows.length;
        stats.bytes += rows.reduce((a, r) => a + JSON.stringify(r.data).length, 0);
      } catch (e) {
        st.failed += rows.length;
        ctx.logger?.('error', `clickhouse insert failed on ${streamName}: ${e.message}`);
        if (st.failed > (ctx.maxRecordErrors || 1000)) throw e;
      }
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const key of [...buffer.keys()]) await flush(key);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const t = await getTable(msg.stream);
        for (const key of Object.keys(msg.data)) {
          if (!t.columns.has(key)) {
            await this._query(c, `ALTER TABLE ${t.qualified} ADD COLUMN IF NOT EXISTS \`${key}\` ${this._typeOf(msg.data[key])}`).catch(() => {});
            t.columns.set(key, this._typeOf(msg.data[key]));
          }
        }
        const buf = buffer.get(msg.stream) || [];
        if (buf.length && buf[0]._cdc?.op !== msg.cdc?.op) await flush(msg.stream);
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffer.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) await flush(msg.stream);
      }
      for (const key of [...buffer.keys()]) await flush(key);
    } finally { /* stateless HTTP */ }
    return stats;
  }
}

module.exports = new ClickhouseDestination();
