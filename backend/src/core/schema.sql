-- DataMove metadata schema
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,            -- e.g. 'source-postgres'
  type TEXT NOT NULL CHECK (type IN ('source','destination')),
  version TEXT NOT NULL DEFAULT '1.0.0',
  display_name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  spec JSONB NOT NULL,                  -- connection spec (JSON Schema)
  supported_sync_modes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  connector_definition_id UUID NOT NULL REFERENCES connector_definitions(id),
  config_encrypted TEXT NOT NULL,       -- AES-256-GCM encrypted JSON
  status TEXT NOT NULL DEFAULT 'active',
  last_check_status TEXT,
  last_check_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  connector_definition_id UUID NOT NULL REFERENCES connector_definitions(id),
  config_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_check_status TEXT,
  last_check_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- catalog jsonb: { streams: [{name, namespace, syncMode, cursorField, primaryKey[], jsonSchema, destinationName, transforms}] }
CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_id UUID NOT NULL REFERENCES sources(id),
  destination_id UUID NOT NULL REFERENCES destinations(id),
  catalog JSONB NOT NULL DEFAULT '{"streams":[]}',
  schedule_type TEXT NOT NULL DEFAULT 'manual' CHECK (schedule_type IN ('manual','interval','cron','cdc')),
  schedule_value TEXT,                  -- '15m', '0 * * * *'
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  namespace TEXT,
  webhook_token TEXT UNIQUE,            -- for webhook sources / failure alerts
  notify_webhook_url TEXT,
  post_sync_command TEXT,               -- e.g. 'dbt run' hook
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS connection_state (
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  stream_name TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, stream_name)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','scheduled','api','cdc')),
  worker_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  records_read BIGINT NOT NULL DEFAULT 0,
  records_written BIGINT NOT NULL DEFAULT 0,
  records_failed BIGINT NOT NULL DEFAULT 0,
  bytes_written BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_conn ON sync_jobs(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);

CREATE TABLE IF NOT EXISTS sync_stream_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  stream_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  records_read BIGINT NOT NULL DEFAULT 0,
  records_written BIGINT NOT NULL DEFAULT 0,
  records_failed BIGINT NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_stream_stats_job ON sync_stream_stats(job_id);

CREATE TABLE IF NOT EXISTS job_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta JSONB
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, ts);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
