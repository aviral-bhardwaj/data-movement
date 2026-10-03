const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { BaseDestination } = require('../base');
const { sqliteType } = require('../../engine/typemap');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');
const config = require('../../core/config');

const IDENT = (s) => `"${String(s).replace(/"/g, '""')}"`;

class SqliteDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-sqlite';
    this.displayName = 'SQLite';
    this.description = 'Load data into a local SQLite database file — great for testing and embedded analytics.';
    this.icon = '🗄️';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', title: 'DB file path', default: './data/warehouse.sqlite' },
        },
      },
    };
  }

  _open(cfg) {
    const file = path.isAbsolute(cfg.file) ? cfg.file : path.join(config.dataDir, cfg.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return new Database(file);
  }

  async check(cfg) {
    try {
      const db = this._open(cfg);
      db.prepare('SELECT 1').get();
      db.close();
      return { status: 'SUCCEEDED' };
    } catch (e) { return { status: 'FAILED', message: e.message }; }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const db = this._open(cfg);
    const stats = { streams: {}, bytes: 0 };
    const tables = new Map();

    const getTable = (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(), truncated: false, syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        const cols = Object.entries(t.schemaProps).map(([n, p]) => {
          const col = sanitizeName(n);
          t.columns.set(col, sqliteType(p));
          return `${IDENT(col)} ${sqliteType(p)}`;
        });
        const pk = t.pk.length ? `, PRIMARY KEY (${t.pk.map(IDENT).join(',')})` : '';
        db.exec(`CREATE TABLE IF NOT EXISTS ${IDENT(table)} (
          ${cols.length ? cols.join(',') + ',' : ''}
          _dm_synced_at TEXT DEFAULT (datetime('now'))
          ${pk})`);
        tables.set(streamName, t);
      }
      return tables.get(streamName);
    };

    const insertBatch = db.transaction((t, rows, st) => {
      const cols = [...t.columns.keys()];
      const verb = t.pk.length ? 'INSERT OR REPLACE' : 'INSERT';
      const stmt = db.prepare(
        `${verb} INTO ${IDENT(t.table)} (${cols.map(IDENT).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) {
        try {
          stmt.run(cols.map((col) => {
            const v = r[col];
            return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v === undefined ? null : v);
          }));
          st.written++;
        } catch (e) {
          st.failed++;
          ctx.logger?.('warn', `record rejected: ${e.message}`);
        }
      }
    });

    const buffer = new Map();
    const flush = (streamName) => {
      const rows = buffer.get(streamName);
      if (!rows?.length) return;
      buffer.set(streamName, []);
      const t = getTable(streamName);
      const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
      const op = rows[0]._cdc?.op;
      if (op === 'd' && t.pk.length) {
        const stmt = db.prepare(`DELETE FROM ${IDENT(t.table)} WHERE ${t.pk.map((p) => `${IDENT(p)}=?`).join(' AND ')}`);
        for (const r of rows) { stmt.run(t.pk.map((p) => r.data[p])); st.written++; }
        return;
      }
      if (t.syncMode === 'full_refresh' && !t.truncated) {
        db.exec(`DELETE FROM ${IDENT(t.table)}`);
        t.truncated = true;
      }
      insertBatch(t, rows.map((r) => r.data), st);
      stats.bytes += rows.reduce((a, r) => a + JSON.stringify(r.data).length, 0);
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const k of [...buffer.keys()]) flush(k);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const t = getTable(msg.stream);
        for (const key of Object.keys(msg.data)) {
          if (!t.columns.has(key)) {
            const v = msg.data[key];
            const type = typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : 'TEXT';
            db.exec(`ALTER TABLE ${IDENT(t.table)} ADD COLUMN ${IDENT(key)} ${type}`);
            t.columns.set(key, type);
          }
        }
        const buf = buffer.get(msg.stream) || [];
        const prevOp = buf[0]?._cdc?.op, op = msg.cdc?.op;
        if (buf.length && prevOp !== op) flush(msg.stream);
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffer.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) flush(msg.stream);
      }
      for (const k of [...buffer.keys()]) flush(k);
    } finally { db.close(); }
    return stats;
  }
}

module.exports = new SqliteDestination();
