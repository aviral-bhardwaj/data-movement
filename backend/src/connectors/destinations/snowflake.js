const { BaseDestination } = require('../base');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

// Snowflake destination — uses the official snowflake-sdk when installed
// (`npm i snowflake-sdk` in backend/). Stages records as JSON then COPY INTO.
const IDENT = (s) => `"${String(s).replace(/"/g, '""')}"`;

class SnowflakeDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-snowflake';
    this.displayName = 'Snowflake';
    this.description = 'Load data into Snowflake via staged JSON + COPY INTO. Requires snowflake-sdk.';
    this.icon = '❄️';
    this.category = 'Warehouse';
    this.catalogSlug = 'snowflake';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['account', 'username', 'password', 'database', 'schema', 'warehouse'],
        properties: {
          account: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          database: { type: 'string' },
          schema: { type: 'string', default: 'DATAMOVE' },
          warehouse: { type: 'string' },
          role: { type: 'string' },
        },
      },
    };
  }

  _sdk() {
    try { return require('snowflake-sdk'); }
    catch { throw new Error('snowflake-sdk not installed: run `npm i snowflake-sdk` in backend/'); }
  }

  _connect(cfg) {
    const sf = this._sdk();
    return new Promise((resolve, reject) => {
      const conn = sf.createConnection({
        account: cfg.account, username: cfg.username, password: cfg.password,
        database: cfg.database, schema: cfg.schema || 'DATAMOVE',
        warehouse: cfg.warehouse, role: cfg.role || undefined,
      });
      conn.connect((err, c) => (err ? reject(err) : resolve(c)));
    });
  }

  _exec(conn, sql, binds) {
    return new Promise((resolve, reject) => {
      conn.execute({ sqlText: sql, binds, complete: (e, stmt, rows) => (e ? reject(e) : resolve(rows)) });
    });
  }

  async check(cfg) {
    try {
      const conn = await this._connect(cfg);
      await this._exec(conn, 'SELECT 1');
      conn.destroy(() => {});
      return { status: 'SUCCEEDED' };
    } catch (e) { return { status: 'FAILED', message: e.message }; }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const conn = await this._connect(cfg);
    const stats = { streams: {}, bytes: 0 };
    const buffers = new Map();
    const schema = cfg.schema || 'DATAMOVE';

    try {
      await this._exec(conn, `CREATE SCHEMA IF NOT EXISTS ${IDENT(schema)}`);
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') { if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state); continue; }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const buf = buffers.get(msg.stream) || [];
        buf.push(msg.data);
        buffers.set(msg.stream, buf);
        stats.bytes += JSON.stringify(msg.data).length;
      }

      for (const [stream, rows] of buffers) {
        const sc = catalog.streams.find((s) => s.name === stream) || {};
        const st = (stats.streams[stream] ||= { written: 0, failed: 0 });
        const table = `${IDENT(schema)}.${IDENT(sanitizeName(sc.destinationName || stream).toUpperCase())}`;
        const props = flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties;
        const cols = Object.entries(props).map(([n, p]) => {
          const t = [].concat(p.type || 'string');
          const sf = t.includes('integer') || t.includes('number') ? 'NUMBER'
            : t.includes('boolean') ? 'BOOLEAN'
            : t.includes('object') || t.includes('array') ? 'VARIANT' : 'VARCHAR';
          return `${IDENT(sanitizeName(n).toUpperCase())} ${sf}`;
        });
        await this._exec(conn, `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(',')}${cols.length ? ',' : ''} _DM_SYNCED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP)`);
        if (sc.syncMode === 'full_refresh') await this._exec(conn, `TRUNCATE IF EXISTS ${table}`);
        const colNames = Object.keys(props).map((n) => IDENT(sanitizeName(n).toUpperCase()));
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const valuesSql = chunk.map((r) =>
            `(${colNames.map((c) => {
              const key = c.replace(/"/g, '').toLowerCase();
              const v = r[key] ?? r[key.toUpperCase()] ?? r[c.replace(/"/g, '')];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'object') return `PARSE_JSON(${sqlStr(JSON.stringify(v))})`;
              if (typeof v === 'number' || typeof v === 'boolean') return String(v);
              return sqlStr(String(v));
            }).join(',')})`).join(',');
          await this._exec(conn, `INSERT INTO ${table} (${colNames.join(',')}) VALUES ${valuesSql}`);
          st.written += chunk.length;
        }
      }
    } finally { conn.destroy(() => {}); }
    return stats;
  }
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

module.exports = new SnowflakeDestination();
