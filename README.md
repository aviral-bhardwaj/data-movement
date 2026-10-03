# DataMove

An open-source data integration platform — Fivetran/Airbyte-style ETL/ELT pipelines built
entirely on **Node.js**. Sources and destinations follow a connector protocol modelled on
the Airbyte spec (`spec` / `check` / `discover` / `read` / `write`), with Debezium-style
log-based CDC for PostgreSQL via logical replication.

## Architecture

```
┌────────────┐   ┌──────────────┐   ┌─────────────┐
│  React UI  │──▶│  API server  │──▶│  PostgreSQL │  (metadata: connections,
│  (Vite)    │   │  (Express)   │   │  :5432      │   state, jobs, logs, users)
└────────────┘   └──────┬───────┘   └─────────────┘
                        │
                 ┌──────▼───────┐    ┌──────────────┐
                 │ Redis/BullMQ │───▶│   Workers    │──▶ sources.read()
                 │  job queue   │    │  (sync       │    -> transforms
                 └──────▲───────┘    │   engine)    │──▶ destinations.write()
                        │            └──────────────┘
                 ┌──────┴───────┐
                 │  Scheduler   │  BullMQ job schedulers (cron/interval/CDC drain)
                 └──────────────┘
```

- **API server** (`backend/src/api/server.js`) — REST API, serves the built UI, webhook ingest.
- **Scheduler** (`backend/src/scheduler/index.js`) — reconciles connection schedules into BullMQ
  job schedulers every 15s; survives restarts (schedules live in Redis).
- **Worker** (`backend/src/worker/index.js`) — pulls jobs off the queue, runs the sync engine,
  retries with exponential backoff (3 attempts).
- **Sync engine** (`backend/src/engine/`) — source→transform→normalize→destination pipeline,
  cursor state checkpoints, per-stream stats, job logs.
- **Connectors** (`backend/src/connectors/`) — pluggable source/destination implementations.

## Quick start (local)

Requires: Node ≥18, PostgreSQL, Redis.

```bash
cp .env.example .env          # set DATABASE_URL + ENCRYPTION_KEY
npm install                   # installs all workspaces
npm run migrate && npm run seed   # schema + admin user (admin@datamove.local / admin123)

npm run api        # :8080  (also serves frontend/dist when built)
npm run scheduler  # background
npm run worker     # background
npm run web        # vite dev server :5173 (proxy → :8080)
```

Or everything at once: `npm run dev` (api + scheduler + worker + vite).

### Demo sync (verifies the whole stack in ~10s)

```bash
# optional: disposable logical-replication source for CDC demos
docker run -d --name dm-pg-demo -p 5433:5432 \
  -e POSTGRES_USER=demo -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=demo_source \
  postgres:16-alpine -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10

cd backend && node src/seed/demo-setup.js          # full + incremental demo
node src/seed/demo-setup.js --cdc                  # CDC demo (publication+slot, 30s drain)
```

### Docker compose (full stack)

```bash
docker compose up -d --build    # postgres + redis + api + scheduler + workers + web(:5173)
```

## Connectors (16)

| Type | Connector | Sync modes |
|------|-----------|------------|
| Source | PostgreSQL | full refresh, incremental cursor, **CDC (logical replication)** |
| Source | MySQL | full refresh, incremental |
| Source | MongoDB | full refresh, incremental (`_id`/date cursor) |
| Source | REST API | generic: auth, pagination (offset/page/cursor/link), record paths |
| Source | Stripe | customers, charges, invoices, subscriptions, … incremental on `created` |
| Source | File | CSV/JSON/JSONL from disk or HTTP |
| Source | Webhook | generated endpoint buffers events to Redis, drained on schedule |
| Source | Kafka | consume N messages per run |
| Dest | PostgreSQL | create/evolve schema, PK upsert, CDC apply (insert/update/delete) |
| Dest | MySQL | same, `ON DUPLICATE KEY UPDATE` |
| Dest | SQLite | local warehouse file — zero-dependency testing |
| Dest | MongoDB | upsert/replace on PK |
| Dest | File | CSV / JSONL output |
| Dest | S3 | JSONL objects (AWS, MinIO, R2, LocalStack) |
| Dest | Snowflake | staged JSON + COPY INTO (needs `snowflake-sdk`) |
| Dest | BigQuery | streaming insertAll (needs `@google-cloud/bigquery`) |

## Sync modes

- **Full refresh** — truncate destination table, re-read everything.
- **Incremental** — `WHERE cursor_field > saved_cursor`; cursor checkpoints persist per stream
  with full sub-millisecond precision.
- **CDC** — Postgres logical replication (`pgoutput`): publication + slot auto-created,
  changes (insert/update/delete) drained per scheduled run and applied by the destination.
- **Real-time-ish** — webhook endpoint + scheduled drain; Kafka consume.

## Key features

- **Schema discovery** — `discover()` introspects each source; catalog UI lets you pick
  streams, sync mode, cursor field, and destination table name.
- **Schema evolution** — new record fields become new destination columns automatically
  (`ALTER TABLE … ADD COLUMN`), add-only, never destructive.
- **Normalization** — nested JSON flattens (`payload.event` → `payload_event`); objects/arrays
  land as JSONB/JSON columns.
- **Transforms** — per-stream rename / cast / filter / drop / flatten config.
- **Dedup** — destination upserts on the source-defined primary key.
- **Checkpoint/resume** — STATE messages persist cursors; failed syncs retry from the last
  checkpoint, not from scratch.
- **Auth** — JWT login + RBAC (admin/editor/viewer) + API keys (`x-api-key` header).
- **Credentials** — AES-256-GCM encrypted at rest; secrets masked in API responses.
- **Observability** — per-stream row counts, per-job logs, metrics endpoints,
  failure webhook + optional SMTP alerts, audit log.
- **Post-sync hooks** — e.g. `post_sync_command: "dbt run"` runs after each sync.

## API surface

```
POST /api/auth/login                  GET  /api/connectors?type=source|destination
POST /api/connectors/:name/check      POST /api/connectors/:name/discover
GET|POST /api/sources                 POST /api/sources/:id/check|discover
GET|POST /api/destinations            POST /api/destinations/:id/check
GET|POST|PUT|DELETE /api/connections  POST /api/connections/:id/sync|pause|resume
GET  /api/syncs                       GET  /api/syncs/:id/logs      POST /api/syncs/:id/cancel
GET  /api/logs                        GET  /api/metrics/overview|timeseries|connectors
GET  /api/health                      POST /webhooks/:token        (public ingest)
GET  /api/audit                       POST /api/auth/apikeys
```

Docs: [`docs/architecture.md`](docs/architecture.md) ·
[`docs/api.md`](docs/api.md) · [`docs/connector-sdk.md`](docs/connector-sdk.md)
