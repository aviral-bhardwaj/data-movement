const { BaseSource, record, log } = require('../base');

// Redis source — scans keys, groups them by key-prefix pattern, and emits
// hash/JSON/string values as records. Full refresh only (Redis has no ordering).
class RedisSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-redis';
    this.displayName = 'Redis';
    this.description = 'Export key groups (hashes, JSON docs, strings) from Redis.';
    this.icon = '🟥';
    this.category = 'Databases';
    this.catalogSlug = null;
    this.supportedSyncModes = ['full_refresh'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host'],
        properties: {
          host: { type: 'string', default: 'localhost' },
          port: { type: 'integer', default: 6379 },
          password: { type: 'string', airbyte_secret: true },
          db: { type: 'integer', default: 0 },
          pattern: { type: 'string', default: '*', title: 'SCAN match pattern' },
          prefixGroups: { type: 'boolean', default: true, title: 'Group keys by "prefix:*" into streams' },
          tls: { type: 'boolean', default: false },
        },
      },
    };
  }

  _client(cfg) {
    const Redis = require('ioredis');
    return new Redis({
      host: cfg.host || 'localhost', port: cfg.port || 6379,
      password: cfg.password || undefined, db: cfg.db || 0,
      tls: cfg.tls ? {} : undefined,
      lazyConnect: true, maxRetriesPerRequest: 2,
    });
  }

  _streamFor(key, cfg) {
    if (cfg.prefixGroups === false) return 'keys';
    const i = key.indexOf(':');
    return i > 0 ? key.slice(0, i) : 'root';
  }

  async check(cfg) {
    const r = this._client(cfg);
    try {
      await r.connect();
      const pong = await r.ping();
      return { status: 'SUCCEEDED', message: pong };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { r.disconnect(); }
  }

  async discover(cfg) {
    const r = this._client(cfg);
    try {
      await r.connect();
      const groups = new Map();
      let cursor = '0';
      let scanned = 0;
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', cfg.pattern || '*', 'COUNT', 1000);
        cursor = next;
        for (const k of keys) {
          groups.set(this._streamFor(k, cfg), (groups.get(this._streamFor(k, cfg)) || 0) + 1);
        }
        scanned += keys.length;
      } while (cursor !== '0' && scanned < 100000);
      return {
        streams: [...groups.entries()].map(([name, count]) => ({
          name, namespace: 'redis', jsonSchema: { type: 'object', properties: {} },
          supportedSyncModes: this.supportedSyncModes,
          sourceDefinedPrimaryKey: ['_key'],
          _keyCount: count,
        })),
      };
    } finally { r.disconnect(); }
  }

  async *read(cfg, catalog, _state, _ctx) {
    const r = this._client(cfg);
    try {
      await r.connect();
      const wanted = new Map(catalog.streams.map((s) => [s.name, s]));
      let cursor = '0';
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', cfg.pattern || '*', 'COUNT', 1000);
        cursor = next;
        for (const key of keys) {
          const stream = this._streamFor(key, cfg);
          if (!wanted.has(stream)) continue;
          const type = await r.type(key);
          let data = { _key: key, _type: type };
          try {
            if (type === 'hash') Object.assign(data, await r.hgetall(key));
            else if (type === 'string') {
              const v = await r.get(key);
              try { Object.assign(data, JSON.parse(v)); }
              catch { data.value = v; }
            } else if (type === 'set') data.members = await r.smembers(key);
            else if (type === 'list') data.items = await r.lrange(key, 0, -1);
            else if (type === 'zset') {
              const raw = await r.zrange(key, 0, -1, 'WITHSCORES');
              data.items = raw.filter((_, i) => i % 2 === 0).map((m, i) => ({ member: m, score: Number(raw[i * 2 + 1]) }));
            } else if (type === 'ReJSON-RL' || type === 'ReJSON') {
              const v = await r.call('JSON.GET', key).catch(() => null);
              try { Object.assign(data, JSON.parse(v)); } catch { data.value = v; }
            }
            yield record(stream, data);
          } catch (e) {
            yield log('warn', `key ${key}: ${e.message}`);
          }
        }
      } while (cursor !== '0');
      yield log('info', 'finished redis scan');
    } finally { r.disconnect(); }
  }
}

module.exports = new RedisSource();
