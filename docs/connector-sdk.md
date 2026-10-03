# Connector SDK

DataMove connectors are plain JavaScript classes — the same protocol Airbyte standardized,
minus the Docker ceremony. A connector is a single file in
`backend/src/connectors/{sources,destinations}/` exporting an instance. The registry
loads it automatically and `syncConnectorDefs()` publishes it to the catalog on boot.

## Protocol

```js
const { BaseSource, record, state, log, inferJsonSchema } = require('../base');

class MySource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-myservice';              // unique, used in the API
    this.displayName = 'My Service';
    this.description = 'What it syncs and how.';
    this.icon = '🚀';
    this.supportedSyncModes = ['full_refresh', 'incremental'];
  }

  spec() {
    return {
      connectionSpecification: {                  // JSON Schema; drives the setup UI
        type: 'object',
        required: ['apiKey'],
        properties: {
          apiKey: { type: 'string', airbyte_secret: true },   // encrypted + masked
          region: { type: 'string', enum: ['us', 'eu'], default: 'us' },
        },
      },
    };
  }

  async check(cfg) {
    // return { status:'SUCCEEDED' } or { status:'FAILED', message }
  }

  async discover(cfg) {
    return {
      streams: [{
        name: 'orders',                            // becomes the stream key
        namespace: 'v1',                           // optional grouping
        jsonSchema: { type: 'object', properties: { id: {type:'integer'}, … } },
        supportedSyncModes: this.supportedSyncModes,
        sourceDefinedPrimaryKey: ['id'],
        availableCursorFields: ['updated_at'],
        defaultCursorField: 'updated_at',
      }],
    };
  }

  async *read(cfg, catalog, state, ctx) {
    for (const stream of catalog.streams) {
      const cursor = state?.[stream.name]?.cursor;
      let max = cursor;
      // …fetch rows…
      for (const row of rows) {
        if (stream.cursorField && row[stream.cursorField] > (max ?? -Infinity)) max = row[stream.cursorField];
        yield record(stream.name, row, { namespace: stream.namespace });
      }
      if (stream.syncMode === 'incremental' && stream.cursorField) {
        yield state(stream.name, { cursor: max });    // checkpoint — survives retries
      }
    }
  }
}

module.exports = new MySource();
```

### Destinations

```js
class MyDest extends BaseDestination {
  constructor() { super(); this.name = 'destination-myservice'; … }

  async write(cfg, catalog, messageStream, ctx) {
    const stats = { streams: {}, bytes: 0 };
    for await (const msg of messageStream) {
      if (msg.type === 'STATE') {
        await ctx.onState(msg.stream, msg.state);     // persist checkpoint
        continue;
      }
      if (msg.type === 'LOG')    { ctx.logger?.(msg.level, msg.message); continue; }
      if (msg.type !== 'RECORD') continue;
      const sc = catalog.streams.find(s => s.name === msg.stream) || {};
      // msg.data is flattened + transform-processed
      // msg.cdc = { op: 'c'|'u'|'d', lsn } for CDC streams — apply deletes!
      …batch write, upsert on sc.primaryKey…
      stats.streams[msg.stream] = { written, failed };
    }
    return stats;
  }
}
```

`ctx` provides: `batchSize`, `logger(level,msg)` (→ job_logs), `onState(stream,state)`,
`connection` (the connection row, e.g. for `webhook_token`), `namespace`.

## Message protocol

| Message | Shape | When |
|---------|-------|------|
| RECORD | `{type:'RECORD', stream, data, namespace?, cdc?}` | one per source row |
| STATE  | `{type:'STATE', stream, state}` | cursor checkpoint — emit at least per stream end |
| LOG    | `{type:'LOG', level, message}` | surfaces in the job log UI |

## Conventions

- **Incremental**: only emit rows where `cursor > state.cursor`; always emit a final
  STATE with the max seen. Cursor values are compared server-side where possible —
  store them with full precision (see `source-postgres` `_dm_cursor` pattern).
- **CDC**: emit `record(…, {cdc:{op}})`; destinations apply `d` as PK deletes.
- **Batching**: sources stream lazily (`async *`); destinations buffer `ctx.batchSize`.
- **Error tolerance**: prefer logging + `st.failed++` over throwing on bad rows;
  throw only for infrastructure failures (auth, connectivity).
- **Secrets**: mark spec fields `airbyte_secret: true` — they encrypt at rest and mask in UI.
- Keep connectors **stateless**; all durable state flows through `state` checkpoints.

## Testing a new connector

```bash
node -e "
const c = require('./src/connectors/sources/myservice');
c.check({apiKey:'…'}).then(console.log);
"
# then register via UI/API and run a real sync.
```
