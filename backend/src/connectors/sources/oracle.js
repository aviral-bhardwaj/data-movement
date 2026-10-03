const { BaseSource, record, state, log } = require('../base');

// Oracle source — lazily loads the `oracledb` driver (requires Oracle client libs
// or thin mode, available in oracledb >= 6).
let orMod = null;
function driver() {
  if (!orMod) {
    try { orMod = require('oracledb'); }
    catch { throw new Error('Oracle connector requires the "oracledb" package: npm i oracledb'); }
  }
  return orMod;
}

class OracleSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-oracle';
    this.displayName = 'Oracle';
    this.description = 'Sync tables from Oracle Database via full refresh or cursor-based incremental.';
    this.icon = '🔶';
    this.category = 'Databases';
    this.catalogSlug = 'oracle';
    this.catalogName = 'Oracle';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'user'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 1521 },
          serviceName: { type: 'string', title: 'Service name (or SID)' },
          user: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          schema: { type: 'string', title: 'Schema (defaults to user schema)' },
        },
      },
    };
  }

  _conn(cfg) {
    const oracledb = driver();
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    const connStr = cfg.serviceName
      ? `${cfg.host}:${cfg.port || 1521}/${cfg.serviceName}`
      : cfg.connectString || `${cfg.host}:${cfg.port || 1521}/XE`;
    return oracledb.getConnection({
      user: cfg.user, password: cfg.password, connectString: connStr,
    });
  }

  async check(cfg) {
    let c;
    try {
      c = await this._conn(cfg);
      await c.execute('SELECT 1 FROM DUAL');
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (c) await c.close().catch(() => {}); }
  }

  async discover(cfg) {
    const c = await this._conn(cfg);
    try {
      const schema = (cfg.schema || cfg.user || '').toUpperCase();
      const cols = await c.execute(
        `SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS
         WHERE OWNER = :s ORDER BY TABLE_NAME, COLUMN_ID`, [schema]);
      const pks = await c.execute(
        `SELECT C.TABLE_NAME, CC.COLUMN_NAME FROM ALL_CONSTRAINTS C
         JOIN ALL_CONS_COLUMNS CC ON C.CONSTRAINT_NAME = CC.CONSTRAINT_NAME AND C.OWNER = CC.OWNER
         WHERE C.OWNER = :s AND C.CONSTRAINT_TYPE = 'P'`, [schema]);
      const streams = new Map();
      for (const col of cols.rows) {
        if (!streams.has(col.TABLE_NAME)) {
          streams.set(col.TABLE_NAME, {
            name: col.TABLE_NAME, namespace: col.OWNER,
            jsonSchema: { type: 'object', properties: {} },
            supportedSyncModes: this.supportedSyncModes,
            sourceDefinedPrimaryKey: [], availableCursorFields: [],
          });
        }
        const s = streams.get(col.TABLE_NAME);
        s.jsonSchema.properties[col.COLUMN_NAME] = oracleToJson(col.DATA_TYPE);
        if (/DATE|TIMESTAMP|NUMBER|INTEGER|FLOAT/.test(col.DATA_TYPE)) {
          s.availableCursorFields.push(col.COLUMN_NAME);
        }
      }
      for (const pk of pks.rows) streams.get(pk.TABLE_NAME)?.sourceDefinedPrimaryKey.push(pk.COLUMN_NAME);
      return { streams: [...streams.values()] };
    } finally { await c.close().catch(() => {}); }
  }

  async *read(cfg, catalog, state, _ctx) {
    const c = await this._conn(cfg);
    try {
      const schema = (cfg.schema || cfg.user || '').toUpperCase();
      for (const stream of catalog.streams) {
        const table = `"${schema}"."${stream.name}"`;
        const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
        const st = state?.[stream.name] || {};
        let sql = `SELECT * FROM ${table}`;
        const binds = {};
        if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
          sql += ` WHERE "${stream.cursorField}" > :cursor ORDER BY "${stream.cursorField}"`;
          binds.cursor = st.cursor;
        }
        let maxCursor = st.cursor;
        const rs = await c.execute(sql, binds, { resultSet: true, fetchArraySize: 1000 });
        const colIdx = hasCursor ? rs.metaData.findIndex((m) => m.name === stream.cursorField) : -1;
        for (;;) {
          const rows = await rs.resultSet.getRows(1000);
          if (!rows.length) break;
          for (const row of rows) {
            if (colIdx >= 0) {
              const cv = row[stream.cursorField];
              const cvS = cv instanceof Date ? cv.toISOString() : cv;
              if (cvS !== undefined && cvS !== null && (maxCursor === undefined || compareCursor(cvS, maxCursor) > 0)) maxCursor = cvS;
            }
            yield record(stream.name, row);
          }
        }
        await rs.resultSet.close().catch(() => {});
        if (stream.syncMode === 'incremental' && stream.cursorField) {
          yield state(stream.name, { cursor: maxCursor });
        }
        yield log('info', `finished stream ${stream.name}`);
      }
    } finally { await c.close().catch(() => {}); }
  }
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const na = Date.parse(a), nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function oracleToJson(t) {
  if (/^(NUMBER|INTEGER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE)/.test(t)) {
    return /\(38,0\)|INTEGER/.test(t) ? { type: 'integer' } : { type: 'number' };
  }
  if (t === 'DATE') return { type: 'string', format: 'date-time' };
  if (/TIMESTAMP/.test(t)) return { type: 'string', format: 'date-time' };
  if (/CLOB|NCLOB|BLOB|RAW|LONG/.test(t)) return { type: 'string' };
  return { type: 'string' };
}

module.exports = new OracleSource();
module.exports.OracleSource = OracleSource;
