const axios = require('axios');
const { BaseDestination } = require('../base');
const { sanitizeName } = require('../../engine/normalize');

// Elasticsearch destination — bulk-indexes records over HTTP.
class ElasticsearchDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-elasticsearch';
    this.displayName = 'Elasticsearch';
    this.description = 'Index records into Elasticsearch indices via the bulk API.';
    this.icon = '🔎';
    this.category = 'Database';
    this.catalogSlug = 'elasticsearch';
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
          indexPrefix: { type: 'string', default: 'datamove' },
        },
      },
    };
  }

  _client(cfg) {
    const headers = { 'Content-Type': 'application/x-ndjson' };
    if (cfg.apiKey) headers.Authorization = `ApiKey ${cfg.apiKey}`;
    else if (cfg.username) headers.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
    return axios.create({ baseURL: cfg.host.replace(/\/+$/, ''), headers, timeout: 120000, validateStatus: (s) => s < 500 });
  }

  _index(cfg, stream) {
    return `${(cfg.indexPrefix || 'datamove').toLowerCase()}-${sanitizeName(stream).toLowerCase()}`;
  }

  async check(cfg) {
    try {
      const res = await this._client(cfg).get('/');
      return res.status < 300 ? { status: 'SUCCEEDED' } : { status: 'FAILED', message: `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const c = this._client(cfg);
    const stats = { streams: {}, bytes: 0 };
    const buffers = new Map(); // index -> lines[]

    const flush = async (index, streamName) => {
      const lines = buffers.get(index);
      if (!lines?.length) return;
      buffers.set(index, []);
      const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
      const res = await c.post('/_bulk', lines.join('\n') + '\n');
      if (res.status >= 400) {
        st.failed += lines.length / 2;
        ctx.logger?.('error', `bulk failed: HTTP ${res.status}`);
        return;
      }
      for (const item of res.data?.items || []) {
        const op = item.index || item.create || item.delete || {};
        if (op.status >= 400) { st.failed++; ctx.logger?.('warn', `doc rejected: ${JSON.stringify(op.error).slice(0, 200)}`); }
        else st.written++;
      }
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const idx of [...buffers.keys()]) await flush(idx, msg.stream);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const index = this._index(cfg, msg.stream);
        const sc = catalog.streams.find((s) => s.name === msg.stream) || {};
        const pk = (sc.primaryKey || []).map(sanitizeName);
        const lines = buffers.get(index) || [];
        if (msg.cdc?.op === 'd') {
          const id = pk.map((p) => msg.data[p]).join(':');
          if (id) lines.push(JSON.stringify({ delete: { _index: index, _id: id } }));
        } else {
          const id = pk.length ? pk.map((p) => msg.data[p]).join(':') : undefined;
          lines.push(JSON.stringify({ index: { _index: index, ...(id ? { _id: id } : {}) } }));
          lines.push(JSON.stringify(msg.data));
        }
        buffers.set(index, lines);
        stats.bytes += JSON.stringify(msg.data).length;
        if (lines.length >= (ctx.batchSize || 1000) * 2) await flush(index, msg.stream);
      }
      for (const idx of [...buffers.keys()]) await flush(idx, '_final');
    } finally { /* stateless */ }
    return stats;
  }
}

module.exports = new ElasticsearchDestination();
