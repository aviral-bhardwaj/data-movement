const axios = require('axios');
const { BaseSource, record, state, log } = require('../base');

// Elasticsearch source — reads indices via the scroll API over plain HTTP,
// so no client dependency is required.
class ElasticsearchSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-elasticsearch';
    this.displayName = 'Elasticsearch';
    this.description = 'Sync documents from Elasticsearch indices via scroll queries.';
    this.icon = '🔎';
    this.category = 'Databases';
    this.catalogSlug = 'elasticsearch';
    this.catalogName = 'Self Hosted Elasticsearch';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host'],
        properties: {
          host: { type: 'string', default: 'http://localhost:9200' },
          username: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          apiKey: { type: 'string', airbyte_secret: true },
        },
      },
    };
  }

  _client(cfg) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `ApiKey ${cfg.apiKey}`;
    else if (cfg.username) headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
    return axios.create({ baseURL: cfg.host.replace(/\/+$/, ''), headers, timeout: 60000, validateStatus: (s) => s < 500 });
  }

  async check(cfg) {
    try {
      const res = await this._client(cfg).get('/');
      return res.status < 300
        ? { status: 'SUCCEEDED', message: `cluster: ${res.data?.cluster_name || 'ok'}` }
        : { status: 'FAILED', message: `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async discover(cfg) {
    const c = this._client(cfg);
    const res = await c.get('/_cat/indices?format=json&h=index,docs.count,health,status');
    const streams = (res.data || [])
      .filter((i) => !i.index.startsWith('.'))
      .map((i) => ({
        name: i.index, namespace: 'elasticsearch',
        jsonSchema: { type: 'object', properties: {} },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: ['_id'], availableCursorFields: [],
      }));
    // merge field mappings
    for (const s of streams.slice(0, 200)) {
      try {
        const m = await c.get(`/${encodeURIComponent(s.name)}/_mapping`);
        const props = m.data?.[s.name]?.mappings?.properties || {};
        for (const [k, v] of Object.entries(props)) {
          s.jsonSchema.properties[k] = esToJson(v.type);
          if (['date', 'long', 'integer', 'short', 'byte', 'double', 'float'].includes(v.type)) {
            s.availableCursorFields.push(k);
          }
        }
      } catch (_) {}
    }
    return { streams };
  }

  async *read(cfg, catalog, state, _ctx) {
    const c = this._client(cfg);
    for (const stream of catalog.streams) {
      const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
      const st = state?.[stream.name] || {};
      const query = { size: 1000, sort: [{ _doc: 'asc' }] };
      if (hasCursor) {
        query.sort = [{ [stream.cursorField]: 'asc' }, { _doc: 'asc' }];
        if (st.cursor !== undefined && st.cursor !== null) {
          query.query = { range: { [stream.cursorField]: { gt: st.cursor } } };
        }
      }
      let res = await c.post(`/${encodeURIComponent(stream.name)}/_search?scroll=5m`, query);
      if (res.status >= 400) {
        yield log('error', `elasticsearch HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        continue;
      }
      let maxCursor = st.cursor;
      for (;;) {
        const hits = res.data?.hits?.hits || [];
        if (!hits.length) break;
        for (const h of hits) {
          const doc = { _id: h._id, ...(h._source || {}) };
          const cv = hasCursor ? doc[stream.cursorField] : undefined;
          if (cv !== undefined && cv !== null && (maxCursor === undefined || compareCursor(cv, maxCursor) > 0)) maxCursor = cv;
          yield record(stream.name, doc);
        }
        res = await c.post('/_search/scroll', { scroll: '5m', scroll_id: res.data._scroll_id });
        if (res.status >= 400) break;
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

function esToJson(t) {
  if (['long', 'integer', 'short', 'byte'].includes(t)) return { type: 'integer' };
  if (['double', 'float', 'half_float', 'scaled_float'].includes(t)) return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'date' || t === 'date_nanos') return { type: 'string', format: 'date-time' };
  if (t === 'object' || t === 'nested' || t === 'flattened') return { type: 'object' };
  return { type: 'string' };
}

module.exports = new ElasticsearchSource();
