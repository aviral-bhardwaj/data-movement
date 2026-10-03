const { Client } = require('pg');
const { BaseSource, record, state, log } = require('../base');

const IDENT = (s) => `"${String(s).replace(/"/g, '""')}"`;

class PostgresSource extends BaseSource {
  constructor() {
    super();
    this.name = 'source-postgres';
    this.displayName = 'PostgreSQL';
    this.description = 'Sync tables from PostgreSQL via full refresh, cursor-based incremental, or logical replication CDC (Debezium-style).';
    this.icon = '🐘';
    this.supportedSyncModes = ['full_refresh', 'incremental', 'cdc'];
  }

  spec() {
    return {
      documentationUrl: 'https://www.postgresql.org/docs/',
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'database', 'user'],
        properties: {
          host: { type: 'string', title: 'Host' },
          port: { type: 'integer', title: 'Port', default: 5432 },
          database: { type: 'string', title: 'Database' },
          user: { type: 'string', title: 'User' },
          password: { type: 'string', title: 'Password', airbyte_secret: true },
          schemas: { type: 'string', title: 'Schemas (comma separated)', default: 'public' },
          ssl: { type: 'boolean', title: 'SSL', default: false },
          replicationSlot: { type: 'string', title: 'Replication slot (CDC)', default: 'datamove_slot' },
          publication: { type: 'string', title: 'Publication (CDC)', default: 'datamove_pub' },
          cdcIdleSeconds: { type: 'integer', title: 'CDC drain idle timeout (s)', default: 30 },
        },
      },
    };
  }

  _client(cfg) {
    return new Client({
      host: cfg.host, port: cfg.port || 5432, database: cfg.database,
      user: cfg.user, password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    });
  }

  async check(cfg) {
    const c = this._client(cfg);
    try {
      await c.connect();
      await c.query('SELECT 1');
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally {
      await c.end().catch(() => {});
    }
  }

  async discover(cfg) {
    const c = this._client(cfg);
    await c.connect();
    try {
      const schemas = (cfg.schemas || 'public').split(',').map((s) => s.trim());
      const { rows: cols } = await c.query(
        `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = ANY($1) ORDER BY table_schema, table_name, ordinal_position`,
        [schemas]
      );
      const { rows: pks } = await c.query(
        `SELECT tc.table_schema, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ANY($1)`,
        [schemas]
      );
      const { rows: cursorCols } = await c.query(
        `SELECT table_schema, table_name, column_name FROM information_schema.columns
         WHERE table_schema = ANY($1) AND data_type IN ('timestamp with time zone','timestamp without time zone','date','bigint','integer','numeric')
         ORDER BY table_schema, table_name`,
        [schemas]
      );

      const streams = new Map();
      for (const col of cols) {
        const key = `${col.table_schema}.${col.table_name}`;
        if (!streams.has(key)) {
          streams.set(key, {
            name: col.table_name,
            namespace: col.table_schema,
            jsonSchema: { type: 'object', properties: {} },
            supportedSyncModes: this.supportedSyncModes,
            sourceDefinedPrimaryKey: [],
            availableCursorFields: [],
          });
        }
        streams.get(key).jsonSchema.properties[col.column_name] = pgToJson(col);
      }
      for (const pk of pks) {
        const s = streams.get(`${pk.table_schema}.${pk.table_name}`);
        if (s) s.sourceDefinedPrimaryKey.push(pk.column_name);
      }
      for (const cc of cursorCols) {
        const s = streams.get(`${cc.table_schema}.${cc.table_name}`);
        if (s) s.availableCursorFields.push(cc.column_name);
      }
      return { streams: [...streams.values()] };
    } finally {
      await c.end();
    }
  }

  async *read(cfg, catalog, state, ctx) {
    for (const stream of catalog.streams) {
      if (stream.syncMode === 'cdc') {
        yield* this._readCdc(cfg, catalog, state, ctx);
        return;
      }
    }
    for (const stream of catalog.streams) {
      yield* this._readStream(cfg, stream, state?.[stream.name] || {});
    }
  }

  async *_readStream(cfg, stream, streamState) {
    const c = this._client(cfg);
    await c.connect();
    const schema = stream.namespace || 'public';
    const table = IDENT(stream.name);
    const qualified = `${IDENT(schema)}.${table}`;
    const batch = 2000;
    try {
      await c.query('BEGIN');
      const hasCursor = stream.syncMode === 'incremental' && stream.cursorField;
      // Cursor column is also selected as text to preserve sub-ms precision
      // (JS Date truncates to milliseconds, which would re-read boundary rows).
      const cursorSel = hasCursor ? `, ${IDENT(stream.cursorField)}::text AS _dm_cursor` : '';
      let sql;
      const params = [];
      if (hasCursor && streamState.cursor !== undefined && streamState.cursor !== null) {
        params.push(streamState.cursor);
        sql = `DECLARE dm_cur CURSOR FOR SELECT *${cursorSel} FROM ${qualified} WHERE ${IDENT(stream.cursorField)} > $1 ORDER BY ${IDENT(stream.cursorField)}`;
      } else {
        sql = `DECLARE dm_cur CURSOR FOR SELECT *${cursorSel} FROM ${qualified}`;
      }
      await c.query(sql, params);
      let maxCursor = streamState.cursor;
      for (;;) {
        const { rows } = await c.query(`FETCH FORWARD ${batch} FROM dm_cur`);
        if (!rows.length) break;
        for (const row of rows) {
          if (hasCursor && row._dm_cursor !== undefined && row._dm_cursor !== null) {
            if (maxCursor === undefined || maxCursor === null || compareCursor(row._dm_cursor, maxCursor) > 0) {
              maxCursor = row._dm_cursor;
            }
          }
          delete row._dm_cursor;
          yield record(stream.name, row, { namespace: schema });
        }
      }
      await c.query('CLOSE dm_cur');
      await c.query('COMMIT');
      if (stream.syncMode === 'incremental' && stream.cursorField) {
        yield state(stream.name, { cursor: maxCursor });
      }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      yield log('error', `stream ${stream.name} failed: ${e.message}`);
      throw e;
    } finally {
      await c.end().catch(() => {});
    }
  }

  // Debezium-equivalent: read committed changes from a logical replication slot
  // (pgoutput plugin) for all catalog tables, until the WAL goes idle.
  async *_readCdc(cfg, catalog, prevState, ctx) {
    const { LogicalReplicationService, PgoutputPlugin } = require('pg-logical-replication');
    const slotName = cfg.replicationSlot || 'datamove_slot';
    const pubName = cfg.publication || 'datamove_pub';
    const idleMs = (cfg.cdcIdleSeconds || 30) * 1000;

    const admin = this._client(cfg);
    await admin.connect();
    try {
      const wanted = catalog.streams.map((s) => `${IDENT(s.namespace || 'public')}.${IDENT(s.name)}`);
      const pub = await admin.query('SELECT 1 FROM pg_publication WHERE pubname=$1', [pubName]);
      if (!pub.rows.length) {
        await admin.query(`CREATE PUBLICATION ${IDENT(pubName)} FOR TABLE ${wanted.join(', ')}`);
        yield log('info', `created publication ${pubName} for ${wanted.length} table(s)`);
      } else {
        // ensure all wanted tables are covered
        const existing = await admin.query(
          `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname=$1`, [pubName]);
        const have = new Set(existing.rows.map((r) => `${r.schemaname}.${r.tablename}`));
        for (const s of catalog.streams) {
          const key = `${s.namespace || 'public'}.${s.name}`;
          if (!have.has(key)) {
            await admin.query(`ALTER PUBLICATION ${IDENT(pubName)} ADD TABLE ${IDENT(s.namespace || 'public')}.${IDENT(s.name)}`);
            yield log('info', `added ${key} to publication ${pubName}`);
          }
        }
      }
      const slot = await admin.query('SELECT 1 FROM pg_replication_slots WHERE slot_name=$1', [slotName]);
      if (!slot.rows.length) {
        await admin.query(`SELECT pg_create_logical_replication_slot($1, 'pgoutput')`, [slotName]);
        yield log('info', `created replication slot ${slotName}`);
      }
    } finally {
      await admin.end();
    }

    const byName = Object.fromEntries(
      catalog.streams.map((s) => [`${s.namespace || 'public'}.${s.name}`, s])
    );
    const relations = new Map(); // relKey -> {schema, name}
    const queue = [];
    let resolveWait = null;
    let lastLsn = null;
    let done = false;
    let failed = null;

    const service = new LogicalReplicationService(
      { host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.user, password: cfg.password },
      { acknowledge: { auto: false } }
    );
    service.on('data', (lsn, msg) => {
      lastLsn = lsn;
      queue.push(msg);
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });
    service.on('error', (e) => { failed = e; if (resolveWait) { resolveWait(); resolveWait = null; } });

    const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [pubName] });
    yield log('info', `CDC: subscribing to slot=${slotName} publication=${pubName}`);
    service.subscribe(plugin, slotName).catch((e) => { failed = e; });

    const deadline = Date.now() + idleMs;
    try {
      while (!done) {
        if (failed) throw failed;
        if (!queue.length) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) { done = true; break; }
          await Promise.race([
            new Promise((r) => { resolveWait = r; }),
            new Promise((r) => setTimeout(r, Math.min(remaining, 1000))),
          ]);
          continue;
        }
        const msg = queue.shift();
        if (msg.tag === 'relation') {
          // relation metadata is carried on the message itself
          relations.set(`${msg.schema}.${msg.name}`, msg);
          relations.set(msg.relationOid, msg);
        } else if (['insert', 'update', 'delete'].includes(msg.tag)) {
          const rel = msg.relation;
          const key = `${rel.schema}.${rel.name}`;
          const stream = byName[key];
          if (!stream) continue;
          const data = msg.tag === 'delete' ? (msg.key || msg.old || {}) : (msg.new || {});
          yield record(stream.name, data, {
            namespace: rel.schema,
            cdc: { op: { insert: 'c', update: 'u', delete: 'd' }[msg.tag], lsn: String(lastLsn) },
          });
        } else if (msg.tag === 'truncate') {
          const names = (msg.relations || []).map((r) => `${r.schema}.${r.name}`);
          yield log('warn', `CDC: TRUNCATE on [${names.join(', ')}] — run a full_refresh sync to re-sync`);
        }
      }
    } finally {
      try {
        if (lastLsn) await service.acknowledge(lastLsn);
        await service.stop();
      } catch (_) {}
    }
    yield state('__cdc__', { lsn: String(lastLsn || '') });
  }
}

// Compare cursor values: numeric when both look numeric, otherwise lexicographic
// on normalized timestamp text ('2026-10-03 06:30:38.469221+00'). ISO 'T...Z'
// stored by older syncs is normalized to the same space/+00 shape first.
function compareCursor(a, b) {
  const num = /^-?\d+(\.\d+)?$/;
  if (num.test(String(a)) && num.test(String(b))) return Number(a) - Number(b);
  const norm = (s) => String(s).replace('T', ' ').replace(/Z$/, '+00');
  const x = norm(a), y = norm(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function pgToJson(col) {
  const t = col.data_type;
  if (['integer', 'bigint', 'smallint'].includes(t)) return { type: 'integer' };
  if (['numeric', 'real', 'double precision'].includes(t)) return { type: 'number' };
  if (['boolean'].includes(t)) return { type: 'boolean' };
  if (t === 'json' || t === 'jsonb') return { type: 'object' };
  if (t === 'date') return { type: 'string', format: 'date' };
  if (t.startsWith('timestamp')) return { type: 'string', format: 'date-time' };
  if (t === 'bytea') return { type: 'string', format: 'binary' };
  if (t === 'ARRAY') return { type: 'array' };
  return { type: 'string' };
}

module.exports = new PostgresSource();
