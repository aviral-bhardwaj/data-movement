const mysql = require('mysql2/promise');
const { BaseDestination } = require('../base');
const { mysqlType } = require('../../engine/typemap');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

const IDENT = (s) => `\`${String(s).replace(/`/g, '``')}\``;

class MysqlDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-mysql';
    this.displayName = 'MySQL';
    this.description = 'Load data into MySQL with schema creation and PK upserts.';
    this.icon = '🐬';
    this.category = 'Database';
    this.catalogSlug = 'mysql';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'database', 'user'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 3306 },
          database: { type: 'string' },
          user: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          ssl: { type: 'boolean', default: false },
        },
      },
    };
  }

  _conn(cfg) {
    return mysql.createConnection({
      host: cfg.host, port: cfg.port || 3306, database: cfg.database,
      user: cfg.user, password: cfg.password, ssl: cfg.ssl ? {} : undefined,
    });
  }

  async check(cfg) {
    let c;
    try { c = await this._conn(cfg); await c.query('SELECT 1'); return { status: 'SUCCEEDED' }; }
    catch (e) { return { status: 'FAILED', message: e.message }; }
    finally { if (c) await c.end().catch(() => {}); }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const c = await this._conn(cfg);
    const stats = { streams: {}, bytes: 0 };
    const tables = new Map();

    const getTable = async (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, qualified: IDENT(table),
          pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(), truncated: false, syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        const cols = Object.entries(t.schemaProps).map(([n, p]) => {
          const col = sanitizeName(n);
          t.columns.set(col, mysqlType(p));
          return `${IDENT(col)} ${mysqlType(p)}`;
        });
        const pkClause = t.pk.length ? `, PRIMARY KEY (${t.pk.map((p) => `${IDENT(p)}(64)`).join(',')})` : '';
        await c.query(`CREATE TABLE IF NOT EXISTS ${t.qualified} (
          ${cols.length ? cols.join(',') + ',' : ''}
          _dm_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ${pkClause}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
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
      const op = rows[0]._cdc?.op;
      if (op === 'd' && t.pk.length) {
        for (const r of rows) {
          try {
            const where = t.pk.map((p) => `${IDENT(p)}=?`).join(' AND ');
            await c.query(`DELETE FROM ${t.qualified} WHERE ${where}`, t.pk.map((p) => r.data[p]));
            st.written++;
          } catch (e) { st.failed++; }
        }
        return;
      }
      if (t.syncMode === 'full_refresh' && !t.truncated) {
        await c.query(`TRUNCATE ${t.qualified}`);
        t.truncated = true;
      }
      const cols = [...t.columns.keys()];
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      const update = t.pk.length
        ? ` ON DUPLICATE KEY UPDATE ${cols.filter((x) => !t.pk.includes(x)).map((x) => `${IDENT(x)}=VALUES(${IDENT(x)})`).join(',')}`
        : '';
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const vals = chunk.flatMap((r) => cols.map((col) => {
          const v = r.data[col];
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v === undefined ? null : v);
        }));
        try {
          await c.query(
            `INSERT INTO ${t.qualified} (${cols.map(IDENT).join(',')}) VALUES ${chunk.map(() => placeholders).join(',')}${update}`,
            vals);
          st.written += chunk.length;
        } catch (e) {
          for (const r of chunk) {
            try {
              await c.query(
                `INSERT INTO ${t.qualified} (${cols.map(IDENT).join(',')}) VALUES ${placeholders}${update}`,
                cols.map((col) => {
                  const v = r.data[col];
                  return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v === undefined ? null : v);
                }));
              st.written++;
            } catch (e2) { st.failed++; ctx.logger?.('warn', `record rejected: ${e2.message}`); }
          }
        }
      }
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const k of [...buffer.keys()]) await flush(k);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const t = await getTable(msg.stream);
        for (const key of Object.keys(msg.data)) {
          if (!t.columns.has(key)) {
            const v = msg.data[key];
            const type = typeof v === 'number' ? (Number.isInteger(v) ? 'BIGINT' : 'DOUBLE')
              : typeof v === 'boolean' ? 'BOOLEAN'
              : (v !== null && typeof v === 'object') ? 'JSON' : 'TEXT';
            await c.query(`ALTER TABLE ${t.qualified} ADD COLUMN ${IDENT(key)} ${type}`).catch(() => {});
            t.columns.set(key, type);
          }
        }
        const buf = buffer.get(msg.stream) || [];
        const prevOp = buf[0]?._cdc?.op, op = msg.cdc?.op;
        if (buf.length && prevOp !== op) await flush(msg.stream);
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffer.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) await flush(msg.stream);
      }
      for (const k of [...buffer.keys()]) await flush(k);
    } finally { await c.end(); }
    return stats;
  }
}

module.exports = new MysqlDestination();
module.exports.MysqlDestination = MysqlDestination;
