const axios = require('axios');
const { BaseSource, record, state, log } = require('../base');

// ClickHouse source — uses the HTTP interface (port 8123) with JSONEachRow,
// so no client package is required.
class ClickhouseSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-clickhouse';
    this.displayName = 'ClickHouse';
    this.description = 'Sync tables from ClickHouse via the HTTP interface.';
    this.icon = '⚡';
    this.category = 'Databases';
    this.catalogSlug = 'clickhouse';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host'],
        properties: {
          host: { type: 'string', default: 'http://localhost:8123' },
          database: { type: 'string', default: 'default' },
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
      params: { database: cfg.database || 'default' },
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

  async discover(cfg) {
    const c = this._client(cfg);
    const res = await c.post('/', `
      SELECT table, name, type FROM system.columns
      WHERE database = currentDatabase() ORDER BY table, position
      FORMAT JSONEachRow`);
    const streams = new Map();
    for (const line of String(res.data).split('\n').filter(Boolean)) {
      const col = JSON.parse(line);
      if (!streams.has(col.table)) {
        streams.set(col.table, {
          name: col.table, namespace: 'clickhouse',
          jsonSchema: { type: 'object', properties: {} },
          supportedSyncModes: this.supportedSyncModes,
          sourceDefinedPrimaryKey: [], availableCursorFields: [],
        });
      }
      const s = streams.get(col.table);
      s.jsonSchema.properties[col.name] = chToJson(col.type);
      if (/Date|Int|UInt|Float|Decimal/.test(col.type)) s.availableCursorFields.push(col.name);
    }
    return { streams: [...streams.values()] };
  }

  async *read(cfg, catalog, state, _ctx) {
    const c = this._client(cfg);
    for (const stream of catalog.streams) {
      const table = `\`${stream.name.replace(/`/g, '')}\``;
      const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
      const st = state?.[stream.name] || {};
      let sql = `SELECT * FROM ${table}`;
      if (hasCursor && st.cursor !== undefined && st.cursor !== null) {
        sql += ` WHERE \`${stream.cursorField}\` > ${Number.isFinite(Number(st.cursor)) ? Number(st.cursor) : `'${st.cursor}'`} ORDER BY \`${stream.cursorField}\``;
      }
      sql += ' FORMAT JSONEachRow';
      const res = await c.post('/', sql, { responseType: 'text', maxContentLength: Infinity, maxBodyLength: Infinity });
      if (res.status >= 400) {
        yield log('error', `clickhouse HTTP ${res.status}: ${String(res.data).slice(0, 300)}`);
        continue;
      }
      let maxCursor = st.cursor;
      for (const line of String(res.data).split('\n').filter(Boolean)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
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
  }
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const na = Date.parse(a), nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function chToJson(t) {
  if (/^(U?Int|Decimal)/.test(t)) return { type: 'integer' };
  if (/^Float|^Decimal/.test(t)) return { type: 'number' };
  if (t === 'Bool' || /^Nullable\(Bool/.test(t)) return { type: 'boolean' };
  if (/^Date$|^Date32/.test(t)) return { type: 'string', format: 'date' };
  if (/DateTime/.test(t)) return { type: 'string', format: 'date-time' };
  if (/Array|Tuple|Map|Nested/.test(t)) return { type: 'array' };
  if (/JSON|Object/.test(t)) return { type: 'object' };
  return { type: 'string' };
}

module.exports = new ClickhouseSource();
