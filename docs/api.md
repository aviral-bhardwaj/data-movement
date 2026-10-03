# DataMove REST API

Base URL: `http://localhost:8080/api`. Auth: `Authorization: Bearer <jwt>` or `x-api-key: <key>`.

## Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | `{email,password}` → `{token,user}` |
| GET | `/auth/me` | current user |
| GET/POST | `/auth/users` | list / create users (admin) |
| GET/POST/DELETE | `/auth/apikeys` | manage API keys (POST returns the raw key once) |

## Connector catalog

| Method | Path | Description |
|--------|------|-------------|
| GET | `/connectors?type=source` | list connector definitions (spec, sync modes, version) |
| POST | `/connectors/:name/check` | `{config}` → `{status,message}` ad-hoc connection test |
| POST | `/connectors/:name/discover` | `{config}` → `{streams:[…]}` (sources only) |

## Sources / destinations

`GET|POST /sources`, `GET|PUT|DELETE /sources/:id`, `POST /sources/:id/check`,
`POST /sources/:id/discover` — same shape under `/destinations` (minus discover).

`POST /sources` body: `{name, connector: "source-postgres", config: {...}}` — the connector's
`check` runs immediately; its result is stored as `last_check_status`.

## Connections

| Method | Path | Description |
|--------|------|-------------|
| GET | `/connections` | list with last-sync status |
| POST | `/connections` | create (see below) |
| GET/PUT/DELETE | `/connections/:id` | detail incl. state / update / delete |
| POST | `/connections/:id/sync` | trigger a sync job → `202 {job}` |
| POST | `/connections/:id/pause` `/resume` | schedule control |
| GET | `/connections/:id/jobs` | recent sync jobs |
| DELETE | `/connections/:id/state` | reset cursors (forces full re-read) |

Create body:

```json
{
  "name": "Prod → WH",
  "sourceId": "<uuid>",
  "destinationId": "<uuid>",
  "namespace": "datamove",
  "catalog": {
    "streams": [{
      "name": "orders", "namespace": "public",
      "syncMode": "incremental",          // full_refresh | incremental | cdc
      "cursorField": "updated_at",
      "primaryKey": ["id"],
      "destinationName": "orders",
      "jsonSchema": {"type":"object","properties":{…}},
      "transforms": {"rename":{},"cast":{},"filter":[],"drop":[],"flatten":true}
    }]
  },
  "scheduleType": "interval",             // manual | interval | cron | cdc
  "scheduleValue": "15m",
  "notifyWebhookUrl": "https://hooks.slack.com/…",
  "postSyncCommand": "dbt run"
}
```

## Sync jobs & logs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/syncs?status=&connectionId=&limit=` | job list with counters |
| GET | `/syncs/:id` | job detail + per-stream stats |
| GET | `/syncs/:id/logs?limit=` | log lines (newest first) |
| POST | `/syncs/:id/cancel` | cancel queued/running job |
| GET | `/logs?level=&q=` | cross-job log search |

## Metrics & health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | public: postgres/redis/queue/connectors |
| GET | `/metrics/overview` | connections, 24h job stats, all-time totals |
| GET | `/metrics/timeseries?hours=` | hourly buckets for charts |
| GET | `/metrics/connectors` | per connector-pair usage & failures |
| GET | `/audit` | config change audit (admin) |

## Webhook ingest (public)

`POST /webhooks/:token` — accepts any JSON body; buffered for the connection's
`source-webhook` stream. The token is shown as `webhook_url` on the connection detail.

## Example session

```bash
TOKEN=$(curl -s -XPOST localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@datamove.local","password":"admin123"}' | jq -r .token)

curl -XPOST localhost:8080/api/sources -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"pg","connector":"source-postgres","config":{"host":"localhost","port":5432,"database":"app","user":"me","password":"pw","schemas":"public"}}'

curl -XPOST localhost:8080/api/sources/<id>/discover -H "Authorization: Bearer $TOKEN"

curl -XPOST localhost:8080/api/connections -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"pg→wh","sourceId":"…","destinationId":"…","catalog":{"streams":[…]},"scheduleType":"interval","scheduleValue":"15m"}'

curl -XPOST localhost:8080/api/connections/<id>/sync -H "Authorization: Bearer $TOKEN"
```
