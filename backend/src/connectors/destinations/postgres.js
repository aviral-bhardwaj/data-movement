const { Client } = require('pg');
const { BaseDestination } = require('../base');
const { pgType } = require('../../engine/typemap');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

const IDENT = (s) => `"${String(s).replace(/"/g, '""')}"`;

class PostgresDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-postgres';
    this.displayName = 'PostgreSQL';
    this.description = 'Load data into PostgreSQL with schema creation, PK upserts, schema evolution and CDC apply.';
    this.icon = '🐘';
    this.category = 'Database';
    this.catalogSlug = 'postgresql';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'database', 'user'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 5432 },
          database: { type: 'string' },
          user: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          schema: { type: 'string', default: 'datamove' },
          ssl: { type: 'boolean', default: false },
        },
      },
    };
  }

  _client(cfg) {
    return new Client({
      host: cfg.host, port: cfg.port || 5432, database: cfg.database,
      user: cfg.user, password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    });
  }

  async check(cfg) {
    const c = this._client(cfg);
    try {
      await c.connect();
      await c.query('SELECT 1');
      return { status: 'SUCCEEDED' };
    } catch (e) { return { status: 'FAILED', message: e.message }; }
    finally { await c.end().catch(() => {}); }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const c = this._client(cfg);
    await c.connect();
    const stats = { streams: {}, bytes: 0 };
    const schema = cfg.schema || 'datamove';
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${IDENT(schema)}`);

    // per-stream state
    const tables = new Map();
    const getTable = async (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, qualified: `${IDENT(schema)}.${IDENT(table)}`,
          pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(), // name -> type
          truncated: false,
          syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        await this._ensureTable(c, t);
        tables.set(streamName, t);
      }
      return tables.get(streamName);
    };

    const buffer = new Map(); // streamName -> rows[]
    const flush = async (streamName) => {
      const rows = buffer.get(streamName);
      if (!rows?.length) return;
      buffer.set(streamName, []);
      const t = await getTable(streamName);
      const op = rows[0]._cdc?.op;
      const dataRows = rows.map((r) => r.data);
      if (op === 'd') {
        await this._delete(c, t, dataRows, stats, streamName, ctx);
      } else {
        if (t.syncMode === 'full_refresh' && !t.truncated) {
          await c.query(`TRUNCATE ${t.qualified}`);
          t.truncated = true;
        }
        await this._insert(c, t, dataRows, stats, streamName, ctx);
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
        await this._evolve(c, t, msg.data);
        // deletes can't batch with inserts
        const buf = buffer.get(msg.stream) || [];
        const prevOp = buf[0]?._cdc?.op;
        const op = msg.cdc?.op;
        if (buf.length && prevOp !== op) await flush(msg.stream);
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffer.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) await flush(msg.stream);
      }
      for (const key of [...buffer.keys()]) await flush(key);
    } finally {
      await c.end().catch(() => {});
    }
    return stats;
  }

  async _ensureTable(c, t) {
    const cols = [];
    for (const [name, prop] of Object.entries(t.schemaProps)) {
      const col = sanitizeName(name);
      t.columns.set(col, pgType(prop));
      cols.push(`${IDENT(col)} ${pgType(prop)}`);
    }
    const pkClause = t.pk.length ? `, PRIMARY KEY (${t.pk.map(IDENT).join(', ')})` : '';
    await c.query(`CREATE TABLE IF NOT EXISTS ${t.qualified} (
      ${cols.length ? cols.join(',\n') + ',' : ''}
      _dm_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      ${pkClause}
    )`);
    if (t.pk.length) {
      const { rows } = await c.query(
        `SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE con.contype='p' AND rel.relname=$1 AND n.nspname=$2`,
        [t.table, t.qualified.match(/"([^"]+)"/)[1]]
      );
      if (!rows.length) {
        await c.query(`ALTER TABLE ${t.qualified} ADD PRIMARY KEY (${t.pk.map(IDENT).join(', ')})`)
          .catch(() => {}); // may already exist with different cols
      }
    }
  }

  async _evolve(c, t, data) {
    for (const key of Object.keys(data)) {
      if (!t.columns.has(key)) {
        const v = data[key];
        const type = typeof v === 'number' ? (Number.isInteger(v) ? 'BIGINT' : 'DOUBLE PRECISION')
          : typeof v === 'boolean' ? 'BOOLEAN'
          : (v !== null && typeof v === 'object') ? 'JSONB' : 'TEXT';
        await c.query(`ALTER TABLE ${t.qualified} ADD COLUMN IF NOT EXISTS ${IDENT(key)} ${type}`);
        t.columns.set(key, type);
      }
    }
  }

  _val(v, colType) {
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
    if (v instanceof Date) return v.toISOString();
    return v;
  }

  async _insert(c, t, rows, stats, streamName, ctx) {
    const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
    const cols = [...t.columns.keys()];
    const colSql = cols.map(IDENT).join(',');
    const conflict = t.pk.length
      ? ` ON CONFLICT (${t.pk.map(IDENT).join(',')}) DO UPDATE SET ${cols.filter((x) => !t.pk.includes(x)).map((x) => `${IDENT(x)}=EXCLUDED.${IDENT(x)}`).join(',') || `${IDENT(cols[0])}=EXCLUDED.${IDENT(cols[0])}`}`
      : '';
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = [];
      const tuples = chunk.map((row, r) => {
        const ph = cols.map((col, ci) => {
          values.push(this._val(row[col], t.columns.get(col)));
          return `$${r * cols.length + ci + 1}`;
        });
        return `(${ph.join(',')})`;
      });
      try {
        await c.query(`INSERT INTO ${t.qualified} (${colSql}) VALUES ${tuples.join(',')}${conflict}`, values);
        st.written += chunk.length;
        stats.bytes += chunk.reduce((a, r) => a + JSON.stringify(r).length, 0);
      } catch (e) {
        // isolate bad rows
        for (const row of chunk) {
          const vals = cols.map((col) => this._val(row[col], t.columns.get(col)));
          try {
            await c.query(
              `INSERT INTO ${t.qualified} (${colSql}) VALUES (${cols.map((_, ci) => `$${ci + 1}`).join(',')})${conflict}`,
              vals
            );
            st.written++;
          } catch (e2) {
            st.failed++;
            ctx.logger?.('warn', `record rejected on ${streamName}: ${e2.message}`);
            if (st.failed > (ctx.maxRecordErrors || 1000)) throw e2;
          }
        }
      }
    }
  }

  async _delete(c, t, rows, stats, streamName, ctx) {
    const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
    if (!t.pk.length) return;
    for (const row of rows) {
      const where = t.pk.map((p, i) => `${IDENT(p)}=$${i + 1}`).join(' AND ');
      const vals = t.pk.map((p) => row[p]);
      try {
        await c.query(`DELETE FROM ${t.qualified} WHERE ${where}`, vals);
        st.written++;
      } catch (e) {
        st.failed++;
        ctx.logger?.('warn', `cdc delete failed: ${e.message}`);
      }
    }
  }
}

module.exports = new PostgresDestination();
module.exports.PostgresDestination = PostgresDestination;
