const { MongoClient, ObjectId } = require('mongodb');
const { BaseSource, record, state, inferJsonSchema, mergeJsonSchemas } = require('../base');

class MongodbSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-mongodb';
    this.displayName = 'MongoDB';
    this.description = 'Sync collections from MongoDB via full refresh or cursor-based incremental (_id or date fields).';
    this.icon = '🍃';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['uri', 'database'],
        properties: {
          uri: { type: 'string', title: 'Connection URI', airbyte_secret: true },
          database: { type: 'string' },
          sampleSize: { type: 'integer', default: 100, title: 'Schema discovery sample size' },
        },
      },
    };
  }

  _client(cfg) { return new MongoClient(cfg.uri); }

  async check(cfg) {
    const c = this._client(cfg);
    try { await c.connect(); await c.db(cfg.database).command({ ping: 1 }); return { status: 'SUCCEEDED' }; }
    catch (e) { return { status: 'FAILED', message: e.message }; }
    finally { await c.close().catch(() => {}); }
  }

  async discover(cfg) {
    const c = this._client(cfg);
    await c.connect();
    try {
      const db = c.db(cfg.database);
      const colls = await db.listCollections({}, { nameOnly: true }).toArray();
      const streams = [];
      for (const coll of colls) {
        if (coll.name.startsWith('system.')) continue;
        let schema = { type: 'object', properties: { _id: { type: 'string' } } };
        const cursor = db.collection(coll.name).find({}).limit(cfg.sampleSize || 100);
        for await (const doc of cursor) {
          const copy = { ...doc, _id: String(doc._id) };
          schema = mergeJsonSchemas(schema, inferJsonSchema(copy));
        }
        streams.push({
          name: coll.name, namespace: cfg.database, jsonSchema: schema,
          supportedSyncModes: this.supportedSyncModes,
          sourceDefinedPrimaryKey: ['_id'],
          availableCursorFields: ['_id', 'updated_at', 'created_at', 'updatedAt', 'createdAt'],
          defaultCursorField: '_id',
        });
      }
      return { streams };
    } finally { await c.close(); }
  }

  async *read(cfg, catalog, state, _ctx) {
    const c = this._client(cfg);
    await c.connect();
    try {
      const db = c.db(cfg.database);
      for (const stream of catalog.streams) {
        const st = state?.[stream.name] || {};
        const filter = {};
        if (stream.syncMode === 'incremental' && stream.cursorField && st.cursor !== undefined) {
          filter[stream.cursorField] = { $gt: coerceCursor(st.cursor, stream.cursorField) };
        }
        let maxCursor = st.cursor;
        const cursor = db.collection(stream.name).find(filter).batchSize(2000);
        for await (const doc of cursor) {
          if (doc._id instanceof ObjectId) doc._id = doc._id.toHexString();
          if (stream.cursorField && doc[stream.cursorField] !== undefined) {
            const v = String(doc[stream.cursorField] instanceof ObjectId ? doc[stream.cursorField].toHexString() : doc[stream.cursorField]);
            if (maxCursor === undefined || v > String(maxCursor)) maxCursor = v;
          }
          yield record(stream.name, doc, { namespace: cfg.database });
        }
        if (stream.syncMode === 'incremental' && stream.cursorField) {
          yield state(stream.name, { cursor: maxCursor });
        }
      }
    } finally { await c.close(); }
  }
}

function coerceCursor(v, field) {
  if (field === '_id' && typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) return new ObjectId(v);
  return v;
}

module.exports = new MongodbSource();
