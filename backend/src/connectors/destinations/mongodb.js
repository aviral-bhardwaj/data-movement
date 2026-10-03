const { MongoClient, ObjectId } = require('mongodb');
const { BaseDestination } = require('../base');

class MongodbDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-mongodb';
    this.displayName = 'MongoDB';
    this.description = 'Load data into MongoDB collections with upsert on primary key.';
    this.icon = '🍃';
    this.category = 'Database';
    this.catalogSlug = null;
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['uri', 'database'],
        properties: {
          uri: { type: 'string', airbyte_secret: true },
          database: { type: 'string' },
        },
      },
    };
  }

  async check(cfg) {
    const c = new MongoClient(cfg.uri);
    try { await c.connect(); await c.db(cfg.database).command({ ping: 1 }); return { status: 'SUCCEEDED' }; }
    catch (e) { return { status: 'FAILED', message: e.message }; }
    finally { await c.close().catch(() => {}); }
  }

  async write(cfg, catalog, messageStream, ctx) {
    const c = new MongoClient(cfg.uri);
    await c.connect();
    const stats = { streams: {}, bytes: 0 };
    const db = c.db(cfg.database);
    const buffers = new Map();
    const streamCfgs = Object.fromEntries(catalog.streams.map((s) => [s.name, s]));
    const truncated = new Set();

    const flush = async (streamName) => {
      const rows = buffers.get(streamName);
      if (!rows?.length) return;
      buffers.set(streamName, []);
      const sc = streamCfgs[streamName] || {};
      const coll = db.collection(sc.destinationName || streamName);
      const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
      if (sc.syncMode === 'full_refresh' && !truncated.has(streamName)) {
        await coll.deleteMany({});
        truncated.add(streamName);
      }
      const ops = rows.map((r) => {
        const pk = sc.primaryKey?.length ? sc.primaryKey : ['_id'];
        const filter = {};
        for (const p of pk) {
          let v = r.data[p];
          if (p === '_id' && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) v = new ObjectId(v);
          filter[p] = v;
        }
        if (r._cdc?.op === 'd') return { deleteOne: { filter } };
        return { replaceOne: { filter, replacement: { ...r.data, _dm_synced_at: new Date() }, upsert: true } };
      });
      try {
        const res = await coll.bulkWrite(ops, { ordered: false });
        st.written += (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.insertedCount || 0) + (res.deletedCount || 0);
        stats.bytes += rows.reduce((a, r) => a + JSON.stringify(r.data).length, 0);
      } catch (e) {
        st.failed += rows.length;
        ctx.logger?.('error', `bulk write failed on ${streamName}: ${e.message}`);
      }
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const k of [...buffers.keys()]) await flush(k);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const buf = buffers.get(msg.stream) || [];
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffers.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) await flush(msg.stream);
      }
      for (const k of [...buffers.keys()]) await flush(k);
    } finally { await c.close(); }
    return stats;
  }
}

module.exports = new MongodbDestination();
