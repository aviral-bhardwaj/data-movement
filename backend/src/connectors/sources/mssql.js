const { BaseSource, record, state, log } = require('../base');

// Microsoft SQL Server source — lazily loads the `mssql` driver (tedious).
let sqlMod = null;
function driver() {
  if (!sqlMod) {
    try { sqlMod = require('mssql'); }
    catch { throw new Error('SQL Server connector requires the "mssql" package: npm i mssql'); }
  }
  return sqlMod;
}

class MssqlSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-sqlserver';
    this.displayName = 'SQL Server';
    this.description = 'Sync tables from Microsoft SQL Server via full refresh or cursor-based incremental.';
    this.icon = '🗄️';
    this.category = 'Databases';
    this.catalogSlug = 'sql-server';
    this.catalogName = 'SQL Server';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'database', 'user'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 1433 },
          database: { type: 'string' },
          user: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          schema: { type: 'string', default: 'dbo' },
          encrypt: { type: 'boolean', default: true },
          trustServerCertificate: { type: 'boolean', default: false },
        },
      },
    };
  }

  _poolConfig(cfg) {
    return {
      server: cfg.host, port: cfg.port || 1433, database: cfg.database,
      user: cfg.user, password: cfg.password,
      options: {
        encrypt: cfg.encrypt !== false,
        trustServerCertificate: !!cfg.trustServerCertificate,
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    };
  }

  async _connect(cfg) {
    const sql = driver();
    const pool = new sql.ConnectionPool(this._poolConfig(cfg));
    await pool.connect();
    return { sql, pool };
  }

  async check(cfg) {
    let pool;
    try {
      ({ pool } = await this._connect(cfg));
      await pool.request().query('SELECT 1');
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (pool) await pool.close().catch(() => {}); }
  }

  async discover(cfg) {
    const { sql, pool } = await this._connect(cfg);
    try {
      const schema = cfg.schema || 'dbo';
      const cols = await pool.request().input('schema', sql.NVarChar, schema).query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema ORDER BY TABLE_NAME, ORDINAL_POSITION`);
      const pks = await pool.request().input('schema', sql.NVarChar, schema).query(
        `SELECT KU.TABLE_NAME, KU.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KU
           ON TC.CONSTRAINT_NAME = KU.CONSTRAINT_NAME AND TC.TABLE_NAME = KU.TABLE_NAME
         WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY' AND KU.TABLE_SCHEMA = @schema`);
      const streams = new Map();
      for (const col of cols.recordset) {
        if (!streams.has(col.TABLE_NAME)) {
          streams.set(col.TABLE_NAME, {
            name: col.TABLE_NAME, namespace: col.TABLE_SCHEMA,
            jsonSchema: { type: 'object', properties: {} },
            supportedSyncModes: this.supportedSyncModes,
            sourceDefinedPrimaryKey: [], availableCursorFields: [],
          });
        }
        const s = streams.get(col.TABLE_NAME);
        s.jsonSchema.properties[col.COLUMN_NAME] = mssqlToJson(col.DATA_TYPE);
        if (['datetime', 'datetime2', 'smalldatetime', 'date', 'int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real'].includes(col.DATA_TYPE)) {
          s.availableCursorFields.push(col.COLUMN_NAME);
        }
      }
      for (const pk of pks.recordset) streams.get(pk.TABLE_NAME)?.sourceDefinedPrimaryKey.push(pk.COLUMN_NAME);
      return { streams: [...streams.values()] };
    } finally { await pool.close().catch(() => {}); }
  }

  async *read(cfg, catalog, state, _ctx) {
    const { pool } = await this._connect(cfg);
    try {
      const schema = cfg.schema || 'dbo';
      for (const stream of catalog.streams) {
        const table = `[${schema}].[${stream.name}]`;
        const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
        const cursorSel = hasCursor ? `, CONVERT(NVARCHAR(33), [${stream.cursorField}], 127) AS _dm_cursor` : '';
        let sql = `SELECT *${cursorSel} FROM ${table}`;
        const st = state?.[stream.name] || {};
        if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
          sql += ` WHERE [${stream.cursorField}] > @dm_cursor ORDER BY [${stream.cursorField}]`;
        } else if (stream.cursorField) {
          sql += ` ORDER BY [${stream.cursorField}]`;
        }
        const req = pool.request();
        req.stream = true;
        if (st.cursor !== undefined && hasCursor) req.input('dm_cursor', st.cursor);
        let maxCursor = st.cursor;
        req.query(sql);
        let rowError = null;
        req.on('error', (e) => { rowError = e; });
        for await (const row of req) {
          if (row._dm_cursor !== undefined && row._dm_cursor !== null) {
            if (maxCursor === undefined || compareCursor(row._dm_cursor, maxCursor) > 0) maxCursor = row._dm_cursor;
          }
          delete row._dm_cursor;
          yield record(stream.name, row);
        }
        if (rowError) throw rowError;
        if (stream.syncMode === 'incremental' && stream.cursorField) {
          yield state(stream.name, { cursor: maxCursor });
        }
        yield log('info', `finished stream ${stream.name}`);
      }
    } finally { await pool.close().catch(() => {}); }
  }
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const na = Date.parse(a), nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function mssqlToJson(t) {
  if (['int', 'bigint', 'smallint', 'tinyint'].includes(t)) return { type: 'integer' };
  if (['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'].includes(t)) return { type: 'number' };
  if (['bit'].includes(t)) return { type: 'boolean' };
  if (['date'].includes(t)) return { type: 'string', format: 'date' };
  if (['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(t)) return { type: 'string', format: 'date-time' };
  if (['binary', 'varbinary', 'image', 'timestamp', 'rowversion'].includes(t)) return { type: 'string', format: 'binary' };
  if (t === 'uniqueidentifier') return { type: 'string', format: 'uuid' };
  return { type: 'string' };
}

module.exports = new MssqlSource();
module.exports.MssqlSource = MssqlSource;
