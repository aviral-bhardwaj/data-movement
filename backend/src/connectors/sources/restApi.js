const axios = require('axios');
const { BaseSource, record, state, inferJsonSchema, mergeJsonSchemas } = require('../base');

// Generic REST API source with pagination and incremental support.
class RestApiSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-rest-api';
    this.displayName = 'REST API';
    this.description = 'Generic REST API source: auth, pagination, incremental cursors, nested record paths.';
    this.icon = '🌐';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['baseUrl'],
        properties: {
          baseUrl: { type: 'string', title: 'Base URL (e.g. https://api.example.com)' },
          authType: { type: 'string', enum: ['none', 'bearer', 'api_key', 'basic'], default: 'none' },
          token: { type: 'string', title: 'Token / API key', airbyte_secret: true },
          apiKeyHeader: { type: 'string', default: 'X-API-Key', title: 'API key header name' },
          username: { type: 'string', title: 'Basic auth user' },
          requestPath: { type: 'string', default: '/', title: 'Request path' },
          method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
          requestBody: { type: 'string', title: 'JSON body (POST)' },
          headers: { type: 'string', title: 'Extra headers (JSON object)' },
          recordsPath: { type: 'string', default: '', title: 'Path to records array (e.g. data.items)' },
          paginationType: { type: 'string', enum: ['none', 'offset', 'page', 'cursor', 'link'], default: 'none' },
          pageSize: { type: 'integer', default: 100 },
          offsetParam: { type: 'string', default: 'offset' },
          limitParam: { type: 'string', default: 'limit' },
          pageParam: { type: 'string', default: 'page' },
          cursorParam: { type: 'string', default: 'cursor' },
          nextCursorPath: { type: 'string', default: 'next_cursor', title: 'JSON path holding next cursor' },
          nextUrlPath: { type: 'string', default: 'next', title: 'JSON path holding next page URL' },
          incrementalParam: { type: 'string', title: 'Query param fed with cursor state (e.g. updated_since)' },
          cursorField: { type: 'string', title: 'Record field used as cursor' },
          maxPages: { type: 'integer', default: 10000 },
        },
      },
    };
  }

  async check(cfg) {
    try {
      const res = await this._request(cfg, {});
      return { status: 'SUCCEEDED', message: `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  async discover(cfg) {
    const res = await this._request(cfg, {});
    const recs = this._extract(res.data, cfg.recordsPath);
    let schema = { type: 'object', properties: {} };
    for (const r of recs.slice(0, 100)) schema = mergeJsonSchemas(schema, inferJsonSchema(r));
    return {
      streams: [{
        name: cfg.streamName || 'records', namespace: 'rest', jsonSchema: schema,
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: cfg.primaryKey ? [cfg.primaryKey] : [],
        availableCursorFields: cfg.cursorField ? [cfg.cursorField] : [],
        defaultCursorField: cfg.cursorField,
      }],
    };
  }

  _headers(cfg) {
    const h = {};
    if (cfg.headers) { try { Object.assign(h, JSON.parse(cfg.headers)); } catch (_) {} }
    if (cfg.authType === 'bearer' && cfg.token) h.Authorization = `Bearer ${cfg.token}`;
    if (cfg.authType === 'api_key' && cfg.token) h[cfg.apiKeyHeader || 'X-API-Key'] = cfg.token;
    if (cfg.authType === 'basic' && cfg.username) {
      h.Authorization = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.token || ''}`).toString('base64');
    }
    return h;
  }

  async _request(cfg, params, url) {
    return axios({
      method: cfg.method || 'GET',
      url: url || `${cfg.baseUrl}${cfg.requestPath || '/'}`,
      headers: this._headers(cfg),
      params,
      data: cfg.method === 'POST' && cfg.requestBody ? JSON.parse(cfg.requestBody) : undefined,
      timeout: 60000,
      validateStatus: (s) => s < 500,
    });
  }

  _extract(data, path) {
    if (!path) return Array.isArray(data) ? data : (data ? [data] : []);
    let cur = data;
    for (const part of path.split('.')) {
      if (cur === undefined || cur === null) return [];
      cur = cur[part];
    }
    return Array.isArray(cur) ? cur : (cur ? [cur] : []);
  }

  async *read(cfg, catalog, state, ctx) {
    const stream = catalog.streams[0];
    const st = state?.[stream?.name || 'records'] || {};
    let params = {};
    if (stream?.syncMode === 'incremental' && cfg.incrementalParam && st.cursor !== undefined) {
      params[cfg.incrementalParam] = st.cursor;
    }
    let maxCursor = st.cursor;
    let page = 0, offset = 0, nextCursor = null, nextUrl = null;

    for (;;) {
      page++;
      const p = { ...params };
      switch (cfg.paginationType) {
        case 'offset': p[cfg.offsetParam || 'offset'] = offset; p[cfg.limitParam || 'limit'] = cfg.pageSize || 100; break;
        case 'page': p[cfg.pageParam || 'page'] = page; p[cfg.limitParam || 'limit'] = cfg.pageSize || 100; break;
        case 'cursor': if (nextCursor) p[cfg.cursorParam || 'cursor'] = nextCursor; break;
        default: break;
      }
      const res = await this._request(cfg, p, nextUrl);
      if (res.status >= 400) {
        yield { type: 'LOG', level: 'error', message: `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}` };
        throw new Error(`source returned HTTP ${res.status}`);
      }
      const recs = this._extract(res.data, cfg.recordsPath);
      for (const r of recs) {
        const cf = stream?.cursorField || cfg.cursorField;
        if (cf && r[cf] !== undefined) {
          if (maxCursor === undefined || r[cf] > maxCursor) maxCursor = r[cf];
        }
        yield record(stream?.name || 'records', r, { namespace: 'rest' });
      }
      offset += recs.length;
      if (!recs.length || page >= (cfg.maxPages || 10000)) break;
      switch (cfg.paginationType) {
        case 'none': page = cfg.maxPages || 10000; break;
        case 'offset': case 'page': if (recs.length < (cfg.pageSize || 100)) page = cfg.maxPages || 10000; break;
        case 'cursor': {
          const nc = this._extract(res.data, cfg.nextCursorPath || 'next_cursor');
          nextCursor = Array.isArray(nc) ? nc[0] : nc;
          if (!nextCursor) page = cfg.maxPages || 10000;
          break;
        }
        case 'link': {
          const nu = this._extract(res.data, cfg.nextUrlPath || 'next');
          nextUrl = Array.isArray(nu) ? nu[0] : nu;
          if (!nextUrl) page = cfg.maxPages || 10000;
          break;
        }
      }
    }
    if (stream?.syncMode === 'incremental') {
      yield state(stream.name, { cursor: maxCursor });
    }
  }
}

module.exports = new RestApiSource();
