# DataMove architecture

DataMove merges two proven designs into one Node.js platform:

- **Airbyte's connector protocol** — every connector exposes `spec`, `check`, `discover`
  (sources) and `read`/`write` against a normalized record/state/log message stream.
- **Debezium's change-data-capture model** — log-based replication for Postgres
  (`pgoutput` logical decoding with publications + replication slots), plus
  cursor-based incremental replication for everything else.

## Services

| Service | Entry point | Responsibility |
|---------|-------------|----------------|
| API server | `src/api/server.js` | REST API, auth, webhook ingest, serves built UI |
| Scheduler | `src/scheduler/index.js` | Reconciles `connections.schedule_*` → BullMQ job schedulers |
| Worker | `src/worker/index.js` | Executes sync jobs (`engine/runner.js`), concurrency 3 |

All three share the same metadata Postgres (`DATABASE_URL`) and Redis (BullMQ).
They are separate OS processes and can run on separate hosts; `docker compose`
scales workers with `deploy.replicas`.

## Data flow

```
connection (catalog + schedule)
        │  POST /connections/:id/sync ──or── scheduler tick
        ▼
sync_jobs row (queued) ──▶ BullMQ (Redis) ──▶ worker picks job
        │                                           │
        │                              source.read(config, catalog, state)
        │                                           │  RECORD/STATE/LOG msgs
        │                              transform (filter/rename/cast/drop)
        │                                           │
        │                              normalize (flatten, sanitize names)
        │                                           │
        │                              destination.write(config, catalog, stream)
        │                              - ensure/evolve table schema
        │                              - batch insert/upsert on PK
        │                              - cdc delete ops → DELETE WHERE pk
        │                                           │
        │                              STATE msgs → connection_state (checkpoint)
        ▼                                           ▼
job_logs, sync_stream_stats, records_read/written/failed, bytes
```

## Metadata schema (Postgres)

`users`, `api_keys` — auth & RBAC.
`connector_definitions` — catalog synced from code on boot.
`sources`, `destinations` — configured instances, `config_encrypted` AES-256-GCM JSON.
`connections` — source+dest pair, `catalog` JSONB (streams/modes/cursors/PKs/transforms),
schedule, `webhook_token`, `notify_webhook_url`, `post_sync_command`.
`connection_state` — per-stream cursor checkpoints (connection_id, stream_name → state).
`sync_jobs` — status, trigger, worker, counters, timing.
`sync_stream_stats` — per-stream counters per job.
`job_logs` — buffered per-job log lines.
`audit_log` — configuration changes.

## Scheduling

`schedule_type`:

- `manual` — API/UI trigger only.
- `interval` — `schedule_value` like `15m`, `1h` → BullMQ `upsertJobScheduler(every: ms)`.
- `cron` — `schedule_value` cron pattern → BullMQ `upsertJobScheduler(pattern:)`.
- `cdc` — treated as interval (default 30s); each run drains the replication slot.

The scheduler reconciles DB↔Redis every `SCHEDULER_TICK_SECONDS` (default 15s),
so schedules survive restarts and edits take effect without redeploying.

## CDC design (Debezium-equivalent for Postgres)

1. On first CDC sync, the source ensures `PUBLICATION datamove_pub` covers the
   catalog tables and creates replication slot `datamove_slot` (`pgoutput` plugin).
2. `LogicalReplicationService` + `PgoutputPlugin` streams decoded
   insert/update/delete (and relation/truncate metadata) messages.
3. Each run drains until the WAL is idle for `cdcIdleSeconds` (default 30s),
   acknowledges the last LSN, then emits a STATE checkpoint.
4. Destination destinations apply `cdc.op`: `c`/`u` → upsert on PK, `d` → delete on PK.
5. Requires `wal_level=logical` on the source; table `REPLICA IDENTITY FULL` gives
   complete old-row images for deletes (demo script sets this).

Incremental (non-CDC) syncs use `WHERE cursor > :state` with the cursor captured
**as text** — preserving microsecond precision that JS `Date` would truncate.

## Fault model

- BullMQ retries each job up to 3× with exponential backoff (10s base).
- Cursor checkpoints persist mid-sync on every STATE message; a retried job resumes
  from the last committed cursor, not from zero.
- Per-record insert failures fall back to row-by-row isolation; jobs end `partial`
  rather than `failed` when some rows land.
- `MAX_RECORD_ERRORS` (default 1000) bounds tolerance before a job fails outright.
- Worker crashes mid-sync: BullMQ stalled-job detection requeues; cursor state
  prevents duplicates where destinations upsert by PK.

## Security

- JWT (`HS256`, `JWT_SECRET`) for UI sessions; API keys (`x-api-key`, sha256-hashed) for automation.
- RBAC: `admin` > `editor` > `viewer`; writes require `editor`, user management `admin`.
- Connector configs encrypted with AES-256-GCM (`ENCRYPTION_KEY`, 32-byte hex); secret
  fields (`airbyte_secret`) are masked as `••••••••` in GET responses and preserved on update.
- Webhook ingest authenticates by unguessable per-connection token (128-bit random).
