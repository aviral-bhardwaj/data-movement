const path = require('path');
const { BaseSource, record, state, log } = require('../base');
const config = require('../../core/config');

// SQLite source — reads tables from a .sqlite/.db file.
class SqliteSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-sqlite';
    this.displayName = 'SQLite';
    this.description = 'Sync tables from a SQLite database file.';
    this.icon = '📦';
    this.category = 'Databases';
    this.catalogSlug = null;
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', title: 'Database file path', help: 'Relative to data dir, or absolute' },
        },
      },
    };
  }

  _db(cfg) {
    const Database = require('better-sqlite3');
    const p = path.isAbsolute(cfg.path) ? cfg.path : path.join(config.dataDir, cfg.path);
    return new Database(p, { readonly: true, fileMustExist: true });
  }

  async check(cfg) {
    let db;
    try {
      db = this._db(cfg);
      db.prepare('SELECT 1').get();
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (db) db.close(); }
  }

  async discover(cfg) {
    const db = this._db(cfg);
    try {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      ).all();
      const streams = tables.map(({ name }) => {
        const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all();
        return {
          name, namespace: 'sqlite',
          jsonSchema: {
            type: 'object',
            properties: Object.fromEntries(cols.map((c) => [c.name, sqliteToJson(c.type)])),
          },
          supportedSyncModes: this.supportedSyncModes,
          sourceDefinedPrimaryKey: cols.filter((c) => c.pk).map((c) => c.name),
          availableCursorFields: cols
            .filter((c) => /INT|REAL|DATE|TIME|NUM/i.test(c.type || ''))
            .map((c) => c.name),
        };
      });
      return { streams };
    } finally { db.close(); }
  }

  async *read(cfg, catalog, state, _ctx) {
    const db = this._db(cfg);
    try {
      for (const stream of catalog.streams) {
        const table = `"${stream.name.replace(/"/g, '""')}"`;
        const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
        const st = state?.[stream.name] || {};
        let sql = `SELECT * FROM ${table}`;
        const params = [];
        if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
          sql += ` WHERE "${stream.cursorField}" > ? ORDER BY "${stream.cursorField}"`;
          params.push(st.cursor);
        } else if (stream.cursorField) {
          sql += ` ORDER BY "${stream.cursorField}"`;
        }
        let maxCursor = st.cursor;
        for (const row of db.prepare(sql).iterate(...params)) {
          if (hasCursor) {
            const cv = row[stream.cursorField];
            if (cv !== undefined && cv !== null && (maxCursor === undefined || compareCursor(cv, maxCursor) > 0)) maxCursor = cv;
          }
          yield record(stream.name, row);
        }
        if (stream.syncMode === 'incremental' && stream.cursorField) {
          yield state(stream.name, { cursor: maxCursor });
        }
        yield log('info', `finished stream ${stream.name}`);
      }
    } finally { db.close(); }
  }
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const na = Date.parse(a), nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function sqliteToJson(t) {
  const u = String(t || '').toUpperCase();
  if (/INT/.test(u)) return { type: 'integer' };
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(u)) return { type: 'number' };
  if (/BOOL/.test(u)) return { type: 'boolean' };
  if (/BLOB/.test(u)) return { type: 'string', format: 'binary' };
  if (/DATE|TIME/.test(u)) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

module.exports = new SqliteSource();
