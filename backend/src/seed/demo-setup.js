#!/usr/bin/env node
// End-to-end demo: provisions a demo Postgres source + destination, wires them
// through the DataMove API, and runs syncs. Also a CDC demo against the
// wal_level=logical docker postgres on :5433.
//
// Usage: node src/seed/demo-setup.js [--cdc]
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const API = process.env.API_BASE_URL || 'http://localhost:8080';
const ADMIN = { email: 'admin@datamove.local', password: 'admin123' };

const SRC = { host: 'localhost', port: 5433, database: 'demo_source', user: 'demo', password: 'demo' };
const DST = { host: 'localhost', port: 5432, database: 'postgres', user: process.env.USER, password: '', schema: 'demo_wh' };

async function api(method, pathName, body, token) {
  const res = await fetch(`${API}/api${pathName}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${pathName} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function provisionSourceData(cdc = false) {
  const c = new Client(SRC);
  await c.connect();
  await c.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      tier TEXT DEFAULT 'free',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INT REFERENCES customers(id),
      amount NUMERIC(10,2),
      status TEXT DEFAULT 'pending',
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  const { rows } = await c.query('SELECT COUNT(*)::int n FROM customers');
  if (rows[0].n === 0) {
    await c.query(`
      INSERT INTO customers (name, email, tier)
      SELECT 'Customer ' || i, 'cust' || i || '@demo.io',
             (ARRAY['free','pro','enterprise'])[1 + (i % 3)]
      FROM generate_series(1, 500) i;
      INSERT INTO orders (customer_id, amount, status, meta)
      SELECT 1 + (i % 500), round((random() * 500)::numeric, 2),
             (ARRAY['pending','paid','shipped','refunded'])[1 + (i % 4)],
             jsonb_build_object('channel', (ARRAY['web','mobile','api'])[1 + (i % 3)])
      FROM generate_series(1, 2000) i;
    `);
    console.log('[demo] seeded 500 customers + 2000 orders into demo_source');
  }
  if (cdc) {
    await c.query(`ALTER TABLE customers REPLICA IDENTITY FULL; ALTER TABLE orders REPLICA IDENTITY FULL;`);
  }
  await c.end();
}

async function main() {
  const cdc = process.argv.includes('--cdc');
  await provisionSourceData(cdc);

  const { token } = await api('POST', '/auth/login', ADMIN);
  console.log('[demo] logged in');

  const upsertInstance = async (kind, name, connector, config) => {
    const list = await api('GET', `/${kind}s`, null, token);
    const existing = list.find((x) => x.name === name);
    if (existing) return existing;
    const created = await api('POST', `/${kind}s`, { name, connector, config }, token);
    console.log(`[demo] created ${kind} "${name}" check=${created.check?.status}`);
    return created;
  };

  const src = await upsertInstance('source', 'Demo Postgres Source', 'source-postgres', { ...SRC, schemas: 'public' });
  const dst = await upsertInstance('destination', 'Demo Postgres WH', 'destination-postgres', DST);

  const cat = await api('POST', `/sources/${src.id}/discover`, {}, token);
  console.log(`[demo] discovered ${cat.streams.length} streams: ${cat.streams.map((s) => s.name).join(', ')}`);

  const connName = cdc ? 'Demo CDC Pipeline' : 'Demo Pipeline';
  const conns = await api('GET', '/connections', null, token);
  let conn = conns.find((x) => x.name === connName);
  if (!conn) {
    conn = await api('POST', '/connections', {
      name: connName,
      sourceId: src.id,
      destinationId: dst.id,
      catalog: {
        streams: cat.streams.map((s) => ({
          name: s.name,
          namespace: s.namespace,
          jsonSchema: s.jsonSchema,
          primaryKey: s.sourceDefinedPrimaryKey,
          cursorField: 'updated_at',
          syncMode: cdc ? 'cdc' : 'incremental',
          destinationName: s.name,
        })),
      },
      scheduleType: cdc ? 'cdc' : 'manual',
      scheduleValue: cdc ? '30s' : null,
      namespace: 'demo_wh',
    }, token);
    console.log(`[demo] created connection "${connName}" (${cdc ? 'cdc @30s' : 'manual'})`);
  }

  const job = await api('POST', `/connections/${conn.id}/sync`, {}, token);
  console.log(`[demo] triggered sync job ${job.id}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api('GET', `/syncs/${job.id}`, null, token);
    if (!['queued', 'running'].includes(j.status)) {
      console.log(`[demo] job ${j.status}: read=${j.records_read} written=${j.records_written} failed=${j.records_failed}`);
      j.streams?.forEach((s) => console.log(`       - ${s.stream_name}: ${s.records_written} rows`));
      if (j.error) console.log(`       error: ${j.error}`);
      break;
    }
  }
}

main().catch((e) => { console.error('[demo] failed:', e.message); process.exit(1); });
