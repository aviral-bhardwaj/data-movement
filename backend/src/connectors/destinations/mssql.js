const { BaseDestination } = require('../base');
const { sanitizeName, flattenJsonSchema } = require('../../engine/normalize');

// SQL Server destination — lazily loads `mssql` (tedious). Creates tables,
// evolves schema, upserts by PK via MERGE, applies CDC deletes.
let sqlMod = null;
function driver() {
  if (!sqlMod) {
    try { sqlMod = require('mssql'); }
    catch { throw new Error('SQL Server destination requires the "mssql" package: npm i mssql'); }
  }
  return sqlMod;
}

const IDENT = (s) => `[${String(s).replace(/]/g, ']]')}]`;

class MssqlDestination extends BaseDestination {
  constructor() {
    super();
    this.name = 'destination-sqlserver';
    this.displayName = 'SQL Server';
    this.description = 'Load data into Microsoft SQL Server with schema evolution and PK merges.';
    this.icon = '🗄️';
    this.category = 'Database';
    this.catalogSlug = 'sql-server';
  }

  spec() {
    return {
      connectionSpecification: {
        type: 'object',
        required: ['host', 'port', 'database', 'user'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', default: 1433 },
          database: { type: 'string' },
          user: { type: 'string' },
          password: { type: 'string', airbyte_secret: true },
          schema: { type: 'string', default: 'datamove' },
          encrypt: { type: 'boolean', default: true },
          trustServerCertificate: { type: 'boolean', default: false },
        },
      },
    };
  }

  async _connect(cfg) {
    const sql = driver();
    const pool = new sql.ConnectionPool({
      server: cfg.host, port: cfg.port || 1433, database: cfg.database,
      user: cfg.user, password: cfg.password,
      options: { encrypt: cfg.encrypt !== false, trustServerCertificate: !!cfg.trustServerCertificate },
    });
    await pool.connect();
    return { sql, pool };
  }

  async check(cfg) {
    let pool;
    try {
      ({ pool } = await this._connect(cfg));
      await pool.request().query('SELECT 1');
      return { status: 'SUCCEEDED' };
    } catch (e) {
      return { status: 'FAILED', message: e.message };
    } finally { if (pool) await pool.close().catch(() => {}); }
  }

  _typeOf(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? 'BIGINT' : 'FLOAT';
    if (typeof v === 'boolean') return 'BIT';
    if (v !== null && typeof v === 'object') return 'NVARCHAR(MAX)';
    if (v instanceof Date) return 'DATETIME2';
    return 'NVARCHAR(MAX)';
  }

  async write(cfg, catalog, messageStream, ctx) {
    const { pool } = await this._connect(cfg);
    const stats = { streams: {}, bytes: 0 };
    const schema = cfg.schema || 'datamove';
    await pool.request().query(`IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name='${schema.replace(/'/g, '')}') EXEC('CREATE SCHEMA [${schema.replace(/'/g, '')}]')`);

    const tables = new Map();
    const getTable = async (streamName) => {
      if (!tables.has(streamName)) {
        const sc = catalog.streams.find((s) => s.name === streamName) || {};
        const table = sanitizeName(sc.destinationName || streamName);
        const t = {
          table, qualified: `[${schema}].[${table}]`,
          pk: (sc.primaryKey || []).map(sanitizeName),
          columns: new Map(),
          truncated: false,
          syncMode: sc.syncMode,
          schemaProps: flattenJsonSchema(sc.jsonSchema || {}, { delimiter: '_', maxDepth: 3, flatten: sc.flatten !== false }).properties,
        };
        const cols = Object.keys(t.schemaProps).map((n) => `${IDENT(sanitizeName(n))} NVARCHAR(MAX)`);
        const pkClause = t.pk.length ? `, CONSTRAINT PK_${table.replace(/\W/g, '_')} PRIMARY KEY (${t.pk.map(IDENT).join(',')})` : '';
        await pool.request().query(
          `IF NOT EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id WHERE t.name='${table.replace(/'/g, '')}' AND s.name='${schema.replace(/'/g, '')}')
           CREATE TABLE ${t.qualified} (${cols.length ? cols.join(',') + ',' : ''} _dm_synced_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()${pkClause})`);
        for (const n of Object.keys(t.schemaProps)) t.columns.set(sanitizeName(n), 'NVARCHAR(MAX)');
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
        await pool.request().query(`TRUNCATE TABLE ${t.qualified}`);
        t.truncated = true;
      }
      const cols = [...t.columns.keys()];
      for (const { data } of rows) {
        try {
          if (isDelete) {
            const where = t.pk.map((p, i) => `${IDENT(p)}=@d${i}`).join(' AND ');
            const req = pool.request();
            t.pk.forEach((p, i) => req.input(`d${i}`, data[p]));
            await req.query(`DELETE FROM ${t.qualified} WHERE ${where}`);
          } else {
            const req = pool.request();
            cols.forEach((c) => {
              const v = data[c];
              req.input(`p_${c}`, (v !== null && typeof v === 'object') ? JSON.stringify(v) : v);
            });
            if (t.pk.length) {
              const upd = cols.filter((c) => !t.pk.includes(c)).map((c) => `${IDENT(c)}=@p_${c}`).join(',');
              await req.query(`UPDATE ${t.qualified} SET ${upd} WHERE ${t.pk.map((p) => `${IDENT(p)}=@p_${p}`).join(' AND ')};
                IF @@ROWCOUNT=0 INSERT INTO ${t.qualified} (${cols.map(IDENT).join(',')}) VALUES (${cols.map((c) => `@p_${c}`).join(',')})`);
            } else {
              await req.query(`INSERT INTO ${t.qualified} (${cols.map(IDENT).join(',')}) VALUES (${cols.map((c) => `@p_${c}`).join(',')})`);
            }
          }
          st.written++;
          stats.bytes += JSON.stringify(data).length;
        } catch (e) {
          st.failed++;
          ctx.logger?.('warn', `record failed on ${streamName}: ${e.message}`);
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
        // evolve columns
        for (const key of Object.keys(msg.data)) {
          if (!t.columns.has(key)) {
            await pool.request().query(`ALTER TABLE ${t.qualified} ADD ${IDENT(key)} ${this._typeOf(msg.data[key])}`).catch(() => {});
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
      await pool.close().catch(() => {});
    }
    return stats;
  }
}

module.exports = new MssqlDestination();
module.exports.MssqlDestination = MssqlDestination;
