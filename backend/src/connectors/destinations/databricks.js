const { BaseDestination } = require('../base');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

// Databricks destination — lazily loads @databricks/sql (SQL warehouse).
// Creates managed Delta tables and inserts batches via SQL.
let sdk = null;
function driver() {
  if (!sdk) {
    try { sdk = require('@databricks/sql'); }
    catch { throw new Error('Databricks destination requires "@databricks/sql": npm i @databricks/sql'); }
  }
  return sdk;
}

const IDENT = (s) => `\`${String(s).replace(/`/g, '')}\``;

class DatabricksDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-databricks';
    this.displayName = 'Databricks';
    this.description = 'Load data into Databricks Delta tables via a SQL warehouse.';
    this.icon = '🧱';
    this.category = 'Warehouse';
    this.catalogSlug = 'databricks';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['serverHostname', 'httpPath', 'accessToken'],
        properties: {
          serverHostname: { type: 'string', title: 'Server hostname' },
          httpPath: { type: 'string', title: 'HTTP path (/sql/1.0/warehouses/xxx)' },
          accessToken: { type: 'string', airbyte_secret: true },
          catalog: { type: 'string', default: 'main' },
          schema: { type: 'string', default: 'datamove' },
        },
      },
    };
  }

  async _session(cfg) {
    const { DBSQLClient } = driver();
    const client = new DBSQLClient();
    await client.connect({
      host: `https://${cfg.serverHostname}`,
      path: cfg.httpPath,
      token: cfg.accessToken,
    });
    return client.openSession();
  }

  async check(cfg) {
    let s;
    try {
      s = await this._session(cfg);
      const op = await s.executeStatement('SELECT 1', { runAsync: false });
      await op.close();
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (s) await s.close().catch(() => {}); }
  }

  _typeOf(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
    if (typeof v === 'boolean') return 'BOOLEAN';
    if (v !== null && typeof v === 'object') return 'STRING';   // Delta stores JSON as STRING/VARIANT
    if (v instanceof Date) return 'TIMESTAMP';
    return 'STRING';
  }

  _lit(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  async write(cfg, catalog, messageStream, ctx) {
    const session = await this._session(cfg);
    const stats = { streams: {}, bytes: 0 };
    const cat = cfg.catalog || 'main';
    const schema = cfg.schema || 'datamove';
    const exec = async (sql) => {
      const op = await session.executeStatement(sql, { runAsync: false });
      await op.close();
    };
    await exec(`CREATE SCHEMA IF NOT EXISTS ${IDENT(cat)}.${IDENT(schema)}`);

    const tables = new Map();
    const getTable = async (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, qualified: `${IDENT(cat)}.${IDENT(schema)}.${IDENT(table)}`,
          pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(),
          truncated: false,
          syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        const cols = Object.keys(t.schemaProps).map((n) => `${IDENT(sanitizeName(n))} STRING`);
        await exec(`CREATE TABLE IF NOT EXISTS ${t.qualified} (${cols.join(',')}${cols.length ? ',' : ''} _dm_synced_at TIMESTAMP DEFAULT current_timestamp()) USING DELTA`);
        for (const n of Object.keys(t.schemaProps)) t.columns.set(sanitizeName(n), 'STRING');
        tables.set(streamName, t);
      }
      return tables.get(streamName);
    };

    const buffer = new Map();
    const flush = async (streamName) => {
      const rows = buffer.get(streamName);
      if (!rows?.length) return;
      buffer.set(streamName, []);
      const t = await getTable(streamName);
      const st = (stats.streams[streamName] ||= { written: 0, failed: 0 });
      const isDelete = rows[0]._cdc?.op === 'd';
      if (!isDelete && t.syncMode === 'full_refresh' && !t.truncated) {
        await exec(`TRUNCATE TABLE ${t.qualified}`).catch(() => exec(`DELETE FROM ${t.qualified}`));
        t.truncated = true;
      }
      const cols = [...t.columns.keys()];
      if (isDelete) {
        for (const { data } of rows) {
          const where = t.pk.map((p) => `${IDENT(p)}=${this._lit(data[p])}`).join(' AND ');
          try { await exec(`DELETE FROM ${t.qualified} WHERE ${where}`); st.written++; }
          catch (e) { st.failed++; ctx.logger?.('warn', `delete failed: ${e.message}`); }
        }
        return;
      }
      // Delta supports MERGE — batch upsert when a PK exists
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values = chunk.map(({ data }) => `(${cols.map((c) => this._lit(data[c])).join(',')})`).join(',');
        try {
          if (t.pk.length) {
            const on = t.pk.map((p) => `t.${IDENT(p)} = s.${IDENT(p)}`).join(' AND ');
            const set = cols.filter((c) => !t.pk.includes(c)).map((c) => `t.${IDENT(c)} = s.${IDENT(c)}`).join(',');
            await exec(
              `MERGE INTO ${t.qualified} t USING (VALUES ${values}) s(${cols.map(IDENT).join(',')}) ON ${on}
               WHEN MATCHED THEN UPDATE SET ${set}
               WHEN NOT MATCHED THEN INSERT *`
            );
          } else {
            await exec(`INSERT INTO ${t.qualified} (${cols.map(IDENT).join(',')}) VALUES ${values}`);
          }
          st.written += chunk.length;
          stats.bytes += chunk.reduce((a, r) => a + JSON.stringify(r.data).length, 0);
        } catch (e) {
          st.failed += chunk.length;
          ctx.logger?.('warn', `batch failed on ${streamName}: ${e.message}`);
          if (st.failed > (ctx.maxRecordErrors || 1000)) throw e;
        }
      }
    };

    try {
      for await (const msg of messageStream) {
        if (msg.type === 'STATE') {
          for (const key of [...buffer.keys()]) await flush(key);
          if (ctx.onState && msg.state) await ctx.onState(msg.stream, msg.state);
          continue;
        }
        if (msg.type === 'LOG') { ctx.logger?.(msg.level, msg.message); continue; }
        if (msg.type !== 'RECORD') continue;
        const t = await getTable(msg.stream);
        for (const key of Object.keys(msg.data)) {
          if (!t.columns.has(key)) {
            await exec(`ALTER TABLE ${t.qualified} ADD COLUMNS (${IDENT(key)} ${this._typeOf(msg.data[key])})`).catch(() => {});
            t.columns.set(key, this._typeOf(msg.data[key]));
          }
        }
        const buf = buffer.get(msg.stream) || [];
        if (buf.length && buf[0]._cdc?.op !== msg.cdc?.op) await flush(msg.stream);
        buf.push({ data: msg.data, _cdc: msg.cdc });
        buffer.set(msg.stream, buf);
        if (buf.length >= (ctx.batchSize || 1000)) await flush(msg.stream);
      }
      for (const key of [...buffer.keys()]) await flush(key);
    } finally {
      await session.close().catch(() => {});
    }
    return stats;
  }
}

module.exports = new DatabricksDestination();
