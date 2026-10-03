// DataMove Connector Protocol — modelled on the Airbyte protocol.
//
// Every connector exposes:
//   spec()      -> { connectionSpecification: <json-schema>, supportedSyncModes?, ... }
//   check(cfg)  -> { status: 'SUCCEEDED'|'FAILED', message? }
//
// Sources additionally expose:
//   discover(cfg) -> { streams: [{ name, namespace, jsonSchema, supportedSyncModes, defaultCursorField, sourceDefinedPrimaryKey }] }
//   read(cfg, catalog, state) -> async generator of protocol messages
//
// Destinations additionally expose:
//   write(cfg, catalog, messageStream, ctx) -> consumes messages, returns stats
//
// Message types:
//   { type:'RECORD', stream, namespace, data, emittedAt, cdc? }
//   { type:'STATE',  stream, state }
//   { type:'LOG',    level, message }

class BaseConnector {
  constructor() {
    this.name = 'base';
    this.type = 'source';
    this.version = '1.0.0';
    this.displayName = 'Base';
    this.description = '';
    this.icon = '🔌';
    this.supportedSyncModes = [];
  }

  spec() {
    throw new Error('spec() not implemented');
  }

  async check(_config) {
    throw new Error('check() not implemented');
  }
}

class BaseSource extends BaseConnector {
  constructor() {
    super();
    this.type = 'source';
  }

  async discover(_config) {
    throw new Error('discover() not implemented');
  }

  // catalog: { streams: [{ name, namespace, syncMode, cursorField, primaryKey }] }
  // state:   { [streamName]: { cursor, ... } }
  async *read(_config, _catalog, _state) {
    throw new Error('read() not implemented');
  }
}

class BaseDestination extends BaseConnector {
  constructor() {
    super();
    this.type = 'destination';
  }

  // messageStream: async iterator of protocol messages (RECORD/STATE/LOG)
  // ctx: { batchSize, onState(state), onStats(stats), logger }
  async write(_config, _catalog, _messageStream, _ctx) {
    throw new Error('write() not implemented');
  }
}

// ---- helpers shared by connectors ----

function record(stream, data, extra = {}) {
  return { type: 'RECORD', stream, data, emittedAt: Date.now(), ...extra };
}

function state(stream, st) {
  return { type: 'STATE', stream, state: st };
}

function log(level, message) {
  return { type: 'LOG', level, message };
}

// Infer a JSON schema from a sample record.
function inferJsonSchema(obj) {
  const properties = {};
  for (const [k, v] of Object.entries(obj || {})) {
    properties[k] = inferType(v);
  }
  return { type: 'object', properties };
}

function inferType(v) {
  if (v === null || v === undefined) return { type: ['null', 'string'] };
  if (v instanceof Date) return { type: 'string', format: 'date-time' };
  if (Buffer.isBuffer(v)) return { type: 'string', format: 'binary' };
  switch (typeof v) {
    case 'number': return Number.isInteger(v) ? { type: 'integer' } : { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'string': return { type: 'string' };
    case 'object':
      if (Array.isArray(v)) return { type: 'array' };
      return { type: 'object' };
    default: return { type: 'string' };
  }
}

// Merge inferred types so schema evolves additively across sampled rows.
function mergeJsonSchemas(a, b) {
  const out = { type: 'object', properties: { ...(a?.properties || {}) } };
  for (const [k, t] of Object.entries(b?.properties || {})) {
    if (!out.properties[k]) {
      out.properties[k] = t;
    } else {
      const existing = out.properties[k];
      const types = new Set([].concat(existing.type || []).concat(t.type || []));
      out.properties[k] = { ...existing, ...t, type: types.size === 1 ? [...types][0] : [...types] };
    }
  }
  return out;
}

module.exports = {
  BaseConnector, BaseSource, BaseDestination,
  record, state, log, inferJsonSchema, mergeJsonSchemas,
};
