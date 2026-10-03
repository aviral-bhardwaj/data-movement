const axios = require('axios');
const { BaseSource, record, state, log, inferJsonSchema, mergeJsonSchemas } = require('../../base');

// Spec-driven REST source. A plain-JS "spec" describes a SaaS API — auth style,
// base URL (with {config} interpolation), resources/endpoints, pagination and
// cursor fields — and this engine turns it into a full DataMove source with
// check / discover / read supporting full-refresh + incremental sync.
//
// spec = {
//   name, displayName, description, catalogSlug, category, badge, icon
//   baseUrl: 'https://{subdomain}.example.com/api/v2'   // {field} -> config value
//   auth: { type: 'bearer'|'basic'|'api_key'|'token_header'|'query'|'oauth2_token'|'oauth2_cc', ... }
//   config: [ { key, title, secret, required, default, help } ]   // connection spec fields
//   headers: { 'X-Foo': 'bar' } | { 'X-Foo': '{field}' }
//   check: { path, method, params }                     // defaults to first resource page
//   rateLimit: { minIntervalMs, retryAfter }            // simple throttle + 429 retry
//   resources: [ {
//     name, path, method:'GET'|'POST', body, params,
//     recordsPath: 'results', recordPath (single obj), primaryKey: 'id' | ['a','b'],
//     cursorField, incrementalParam, filterClientSide,
//     pagination: { type:'none'|'offset'|'page'|'cursor'|'link'|'date_window',
//                   limitParam, pageSize, offsetParam, pageParam,
//                   cursorParam, cursorPath, nextUrlPath, linkHeader },
//     child: { pathFromParent: (parent, resource) => string }     // nested resources
//   } ]
// }

const INTERPOLATE = /\{([a-zA-Z0-9_]+)\}/g;
function interp(str, cfg, extra = {}) {
  if (typeof str !== 'string') return str;
  return str.replace(INTERPOLATE, (_, k) => encodeURIComponent(extra[k] ?? cfg[k] ?? `{${k}}`));
}

function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function asArray(data, path) {
  const v = path ? getPath(data, path) : data;
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const na = Date.parse(a), nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SpecdSource extends BaseSource {
  constructor(spec) {
    super();
    Object.assign(this, {
      name: spec.name,
      displayName: spec.displayName,
      description: spec.description || '',
      icon: spec.icon || '🔌',
      category: spec.category || 'Applications',
      catalogSlug: spec.catalogSlug || null,
      catalogName: spec.catalogName || null,
      badge: spec.badge || null,
      supportedSyncModes: ['full_refresh', 'incremental'],
    });
    this.specDef = spec;
  }

  spec() {
    const properties = {};
    const required = [];
    for (const f of [...(this.specDef.config || []), ...(this.specDef.extraConfig || [])]) {
      properties[f.key] = {
        type: f.type || 'string',
        title: f.title || f.key,
        default: f.default,
        enum: f.enum,
        description: f.help,
        airbyte_secret: !!f.secret,
      };
      if (f.required) required.push(f.key);
    }
    return { connectionSpecification: { type: 'object', required, properties } };
  }

  _baseUrl(cfg) { return interp(this.specDef.baseUrl, cfg).replace(/\/+$/, ''); }

  async _authHeaders(cfg) {
    const a = this.specDef.auth || {};
    const tok = cfg.accessToken || cfg.token || cfg.apiKey || '';
    switch (a.type) {
      case 'bearer': case 'oauth2_token':
        return tok ? { Authorization: `Bearer ${tok}` } : {};
      case 'basic': {
        const u = interp(a.username || '{username}', cfg);
        const p = interp(a.password !== undefined ? a.password : '{password}', cfg);
        return { Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') };
      }
      case 'api_key':
        return { [a.header || 'X-API-Key']: tok };
      case 'token_header':
        return { [a.header]: tok };
      case 'raw_header':
        return { [a.header || 'Authorization']: interp(a.value || '{apiKey}', cfg) };
      case 'oauth2_cc': {
        // client-credentials: fetch an access token and cache it on the instance
        if (this._ccToken && this._ccExp > Date.now() + 30000) {
          return { Authorization: `Bearer ${this._ccToken}` };
        }
        const url = interp(a.tokenUrl, cfg);
        const payload = {
          grant_type: 'client_credentials',
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          ...(a.extraParams || {}),
        };
        const res = a.json
          ? await axios.post(url, payload, { timeout: 30000 })
          : await axios.post(url, new URLSearchParams(payload), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
        this._ccToken = a.tokenPath ? getPath(res.data, a.tokenPath) : res.data.access_token;
        this._ccExp = Date.now() + (res.data.expires_in || 3600) * 1000;
        return { Authorization: `Bearer ${this._ccToken}` };
      }
      case 'query': default:
        return {};
    }
  }

  _authParams(cfg) {
    const a = this.specDef.auth || {};
    if (a.type === 'query') return { [a.param || 'api_key']: cfg.apiKey || cfg.token };
    if (a.params) { // e.g. trello key+token in query
      const out = {};
      for (const [k, v] of Object.entries(a.params)) out[k] = interp(v, cfg);
      return out;
    }
    return {};
  }

  async _request(cfg, { path, url, method = 'GET', params = {}, body }) {
    const headers = { Accept: 'application/json' };
    for (const [k, v] of Object.entries(this.specDef.headers || {})) headers[k] = interp(v, cfg);
    Object.assign(headers, await this._authHeaders(cfg));
    const req = {
      method,
      // resolve next-page links the way a browser would: absolute URLs pass
      // through, "/path" resolves against the API origin, "path" against base.
      url: url
        ? new URL(url, this._baseUrl(cfg) + '/').href
        : this._baseUrl(cfg) + interp(path || '/', cfg),
      headers, params: { ...this._authParams(cfg), ...params },
      data: body, timeout: 60000,
      validateStatus: () => true,
    };
    const minMs = this.specDef.rateLimit?.minIntervalMs;
    if (minMs) {
      const wait = (this._lastReq || 0) + minMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this._lastReq = Date.now();
    let res = await axios(req);
    // retry on 429 honoring Retry-After (bounded)
    for (let i = 0; res.status === 429 && i < 3; i++) {
      const ra = parseFloat(res.headers['retry-after'] || '2');
      await sleep(Math.min(ra, 60) * 1000);
      res = await axios(req);
    }
    return res;
  }

  async check(cfg) {
    const s = this.specDef;
    try {
      if (s.check?.tokenCheck) await this._authHeaders(cfg);
      const path = s.check?.path || (s.resources[0] && s.resources[0].path);
      const method = s.check?.method || 'GET';
      const res = await this._request(cfg, { path, method, params: s.check?.params || { limit: 1 } });
      if (res.status >= 200 && res.status < 300) {
        return { status: 'SUCCEEDED', message: `HTTP ${res.status}` };
      }
      return { status: 'FAILED', message: `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}` };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    }
  }

  _resources(cfg) {
    const s = this.specDef;
    const base = typeof s.resources === 'function' ? s.resources(cfg) : s.resources;
    return [...(base || []), ...(s.extraResources || [])];
  }

  _applyMap(r, recs) {
    // a map may return null to drop a row (e.g. sheet header lines)
    return r.map ? recs.map((x, i) => r.map(x, i)).filter((x) => x !== null && x !== undefined) : recs;
  }

  async discover(cfg) {
    const streams = [];
    const seen = new Set();
    for (const r of this._resources(cfg)) {
      if (r.child) continue; // nested resources surface under their own name but aren't sampled alone
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      const s = {
        name: r.name, namespace: this.specDef.name.replace(/^source-/, ''),
        jsonSchema: { type: 'object', properties: {} },
        supportedSyncModes: r.cursorField ? this.supportedSyncModes : ['full_refresh'],
        sourceDefinedPrimaryKey: r.primaryKey ? [].concat(r.primaryKey) : [],
        availableCursorFields: r.cursorField ? [r.cursorField] : [],
        defaultCursorField: r.cursorField,
      };
      try {
        const res = await this._request(cfg, {
          path: r.path, method: r.method || 'GET',
          params: { ...(r.params || {}), ...(r.pagination?.limitParam ? { [r.pagination.limitParam]: 25 } : {}) },
          body: r.body ? JSON.parse(interp(JSON.stringify(r.body), cfg)) : undefined,
        });
        if (res.status < 300) {
          for (const rec of this._applyMap(r, asArray(res.data, r.recordsPath)).slice(0, 100)) {
            s.jsonSchema = mergeJsonSchemas(s.jsonSchema, inferJsonSchema(rec));
          }
        }
      } catch (_) { /* discovery sampling is best-effort */ }
      streams.push(s);
    }
    // nested resources register without sampling
    for (const r of this._resources(cfg)) {
      if (r.child) {
        streams.push({
          name: r.name, namespace: this.specDef.name.replace(/^source-/, ''),
          jsonSchema: { type: 'object', properties: {} },
          supportedSyncModes: ['full_refresh'],
          sourceDefinedPrimaryKey: r.primaryKey ? [].concat(r.primaryKey) : [],
        });
      }
    }
    return { streams };
  }

  async *read(cfg, catalog, state, ctx) {
    const s = this.specDef;
    const resources = this._resources(cfg);
    for (const stream of catalog.streams) {
      const r = resources.find((x) => x.name === stream.name) || resources.find((x) => x.name === stream.name.split('/').pop());
      if (!r) { yield log('warn', `no resource spec for stream ${stream.name}`); continue; }
      yield* this._readResource(cfg, r, stream, state, ctx);
    }
  }

  async *_readResource(cfg, r, stream, st0, ctx) {
    const st = st0?.[stream.name] || {};
    const incremental = stream.syncMode === 'incremental' && (stream.cursorField || r.cursorField);
    const cursorField = stream.cursorField || r.cursorField;
    let maxCursor = st.cursor;

    for await (const rec of this._recordsResolved(cfg, r, incremental ? st.cursor : undefined)) {
      const cv = cursorField ? getPath(rec, cursorField) : undefined;
      if (incremental && st.cursor !== undefined && cv !== undefined && compareCursor(cv, st.cursor) <= 0) continue;
      if (cv !== undefined && (maxCursor === undefined || compareCursor(cv, maxCursor) > 0)) maxCursor = cv;
      yield record(stream.name, rec);
    }
    if (incremental) yield state(stream.name, { cursor: maxCursor });
    yield log('info', `finished stream ${stream.name}`);
  }

  // Resolve the concrete request paths for a resource. Top-level resources have
  // one path; child resources expand once per record of their parent — and this
  // recurses, so N-level nesting works (ad -> squad -> campaign -> account).
  async *_paths(cfg, r) {
    if (!r.child) { yield r.path; return; }
    const resources = this._resources(cfg);
    const parentSpec = resources.find((p) => p.name === r.child.parent);
    if (!parentSpec) return;
    for await (const parent of this._recordsResolved(cfg, parentSpec, undefined)) {
      yield typeof r.child.path === 'function'
        ? r.child.path(parent, cfg)
        : interp(r.child.path, cfg, { parentId: parent[r.child.parentKey || 'id'], parent });
    }
  }

  // raw records for a resource, expanding child paths across parents
  async *_recordsResolved(cfg, r, cursor) {
    for await (const path of this._paths(cfg, r)) {
      yield* this._records(cfg, { ...r, path }, cursor);
    }
  }

  // async generator of raw records for a concrete path (handles pagination)
  async *_records(cfg, r, cursor) {
    const pg = r.pagination || { type: 'none' };
    let page = 0, offset = 0, nextCursor = null, nextUrl = null;
    for (;;) {
      page++;
      const bodyCtx = { page, offset, cursor: nextCursor, stateCursor: cursor };
      const params = typeof r.params === 'function'
        ? r.params(cfg, bodyCtx)
        : Object.fromEntries(
            Object.entries(r.params || {}).map(([k, v]) => [k, typeof v === 'string' ? interp(v, cfg) : v])
          );
      let body;
      if (typeof r.body === 'function') body = r.body(cfg, bodyCtx);
      else if (r.body) body = JSON.parse(interp(JSON.stringify(r.body), cfg, bodyCtx));
      if (cursor !== undefined && r.incrementalParam) {
        if (pg.place === 'body' && body) body[r.incrementalParam] = cursor;
        else params[r.incrementalParam] = cursor;
      }
      switch (pg.type) {
        case 'offset':
          if (pg.place === 'body' && body) { body[pg.offsetParam || 'offset'] = offset; if (pg.limitParam) body[pg.limitParam] = pg.pageSize || 100; }
          else { params[pg.offsetParam || 'offset'] = offset; if (pg.limitParam) params[pg.limitParam] = pg.pageSize || 100; }
          break;
        case 'page':
          if (pg.place === 'body' && body) { body[pg.pageParam || 'page'] = pg.startAt || page; if (pg.limitParam) body[pg.limitParam] = pg.pageSize || 100; }
          else { params[pg.pageParam || 'page'] = pg.startAt || page; if (pg.limitParam) params[pg.limitParam] = pg.pageSize || 100; }
          break;
        case 'cursor':
          if (nextCursor) {
            if (pg.place === 'body' && body) body[pg.cursorParam || 'cursor'] = nextCursor;
            else params[pg.cursorParam || 'cursor'] = nextCursor;
          }
          if (pg.limitParam) { if (pg.place === 'body' && body) body[pg.limitParam] = pg.pageSize || 100; else params[pg.limitParam] = pg.pageSize || 100; }
          break;
        default: break;
      }
      // some APIs page by calling a different "continue" endpoint (e.g. Dropbox)
      const reqPath = page > 1 && pg.continuePath ? pg.continuePath : r.path;
      const res = await this._request(cfg, { path: reqPath, url: nextUrl, method: r.method || 'GET', params, body });
      if (res.status >= 400) {
        throw new Error(`${this.name}:${r.name} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      }
      const recs = this._applyMap(r, asArray(res.data, r.recordsPath));
      for (const x of recs) yield x;
      offset += recs.length;
      if (!recs.length || page >= 10000) return;
      switch (pg.type) {
        case 'offset': {
          const total = pg.totalPath ? getPath(res.data, pg.totalPath) : undefined;
          if (total === false || total === null) return;                    // e.g. PagerDuty "more": false
          if (typeof total === 'number' && offset >= total) return;
          if (total === undefined && recs.length < (pg.pageSize || 100)) return;
          break;
        }
        case 'page':
          if (recs.length < (pg.pageSize || 100)) return;
          break;
        case 'cursor': {
          nextCursor = getPath(res.data, pg.cursorPath || 'next_cursor');
          if (Array.isArray(nextCursor)) nextCursor = nextCursor[0];
          if (!nextCursor) return;
          break;
        }
        case 'link': {
          const v = getPath(res.data, pg.nextUrlPath || 'next');
          nextUrl = Array.isArray(v) ? v[0] : v;
          if (!nextUrl && pg.linkHeader) {
            const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.link || '');
            nextUrl = m && m[1];
          }
          if (!nextUrl) return;
          break;
        }
        default:
          return;
      }
    }
  }
}

module.exports = { SpecdSource };
