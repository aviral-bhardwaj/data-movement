const mysql = require('mysql2/promise');
const { BaseSource, record, state, log } = require('../base');

class MysqlSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-mysql';
    this.displayName = 'MySQL';
    this.description = 'Sync tables from MySQL via full refresh or cursor-based incremental.';
    this.icon = '🐬';
    this.category = 'Databases';
    this.catalogSlug = 'mysql';
    this.catalogName = 'MySQL';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
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
      user: cfg.user, password: cfg.password,
      ssl: cfg.ssl ? {} : undefined,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
  }

  async check(cfg) {
    let c;
    try {
      c = await this._conn(cfg);
      await c.query('SELECT 1');
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (c) await c.end().catch(() => {}); }
  }

  async discover(cfg) {
    const c = await this._conn(cfg);
    try {
      const [cols] = await c.query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [cfg.database]);
      const [pks] = await c.query(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, [cfg.database]);
      const streams = new Map();
      for (const col of cols) {
        if (!streams.has(col.TABLE_NAME)) {
          streams.set(col.TABLE_NAME, {
            name: col.TABLE_NAME, namespace: col.TABLE_SCHEMA,
            jsonSchema: { type: 'object', properties: {} },
            supportedSyncModes: this.supportedSyncModes,
            sourceDefinedPrimaryKey: [], availableCursorFields: [],
          });
        }
        const s = streams.get(col.TABLE_NAME);
        s.jsonSchema.properties[col.COLUMN_NAME] = mysqlToJson(col.DATA_TYPE);
        if (['timestamp', 'datetime', 'date', 'bigint', 'int', 'decimal', 'numeric'].includes(col.DATA_TYPE)) {
          s.availableCursorFields.push(col.COLUMN_NAME);
        }
      }
      for (const pk of pks) streams.get(pk.TABLE_NAME)?.sourceDefinedPrimaryKey.push(pk.COLUMN_NAME);
      return { streams: [...streams.values()] };
    } finally { await c.end(); }
  }

  async *read(cfg, catalog, state, _ctx) {
    const c = await this._conn(cfg);
    try {
      for (const stream of catalog.streams) {
        const table = `\`${stream.name}\``;
        const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
        const cursorSel = hasCursor ? `, CAST(\`${stream.cursorField}\` AS CHAR) AS _dm_cursor` : '';
        let sql = `SELECT *${cursorSel} FROM ${table}`;
        const params = [];
        const st = state?.[stream.name] || {};
        if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
          sql += ` WHERE \`${stream.cursorField}\` > ? ORDER BY \`${stream.cursorField}\``;
          params.push(st.cursor);
        } else if (stream.cursorField) {
          sql += ` ORDER BY \`${stream.cursorField}\``;
        }
        let maxCursor = st.cursor;
        const query = c.query(sql, params);
        const rs = query.stream({ highWaterMark: 1000, objectMode: true });
        for await (const row of rs) {
          if (hasCursor && row._dm_cursor !== undefined && row._dm_cursor !== null) {
            if (maxCursor === undefined || maxCursor === null || compareCursor(row._dm_cursor, maxCursor) > 0) maxCursor = row._dm_cursor;
          }
          delete row._dm_cursor;
          yield record(stream.name, row);
        }
        if (stream.syncMode === 'incremental' && stream.cursorField) {
          yield state(stream.name, { cursor: maxCursor });
        }
        yield log('info', `finished stream ${stream.name}`);
      }
    } finally { await c.end(); }
  }
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const norm = (s) => String(s).replace('T', ' ').replace(/Z$/, '+00');
  const x = norm(a), y = norm(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function mysqlToJson(t) {
  if (['int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'year'].includes(t)) return { type: 'integer' };
  if (['decimal', 'numeric', 'float', 'double'].includes(t)) return { type: 'number' };
  if (t === 'json') return { type: 'object' };
  if (t === 'date') return { type: 'string', format: 'date' };
  if (['datetime', 'timestamp'].includes(t)) return { type: 'string', format: 'date-time' };
  if (['blob', 'binary', 'varbinary'].includes(t)) return { type: 'string', format: 'binary' };
  return { type: 'string' };
}

module.exports = new MysqlSource();
module.exports.MysqlSource = MysqlSource;
