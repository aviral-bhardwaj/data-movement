const db = require('../core/db');
const config = require('../core/config');
const logger = require('../core/logger');
const { decryptJson } = require('../core/crypto');
const registry = require('../connectors/registry');
const { applyTransforms } = require('./transform');
const { flattenRecord } = require('./normalize');
const axios = require('axios');
const { spawn } = require('child_process');

// Executes one sync job: source.read -> transform/normalize -> destination.write
// Persists STATE checkpoints, stream stats and job logs along the way.
async function runSync({ jobId, connectionId, triggerType = 'manual', bullJob }) {
  const startedAt = Date.now();
  let job = jobId
    ? await db.one('SELECT * FROM sync_jobs WHERE id=$1', [jobId])
    : null;

  if (!job) {
    job = await db.one(
      `INSERT INTO sync_jobs (connection_id, status, trigger_type) VALUES ($1,'queued',$2) RETURNING *`,
      [connectionId, triggerType]
    );
    jobId = job.id;
  }

  const jobLog = makeJobLogger(jobId);
  const fail = async (err, status = 'failed') => {
    await db.query(
      `UPDATE sync_jobs SET status=$2, finished_at=now(), error=$3 WHERE id=$1`,
      [jobId, status, String(err?.message || err)]
    );
    await jobLog('error', `sync ${status}: ${err?.message || err}`);
    const conn = await db.one('SELECT * FROM connections WHERE id=$1', [job?.connection_id]);
    if (conn) await notifyFailure(conn, err);
    throw err;
  };

  try {
    const conn = await db.one('SELECT * FROM connections WHERE id=$1', [job.connection_id]);
    if (!conn) throw new Error('connection not found');
    await db.query(
      `UPDATE sync_jobs SET status='running', started_at=now(), worker_id=$2, connection_id=$3 WHERE id=$1`,
      [jobId, config.worker.id, conn.id]
    );
    await jobLog('info', `sync started (trigger=${triggerType}, worker=${config.worker.id})`);

    const src = await db.one(
      `SELECT s.*, c.name AS connector_name FROM sources s JOIN connector_definitions c ON c.id=s.connector_definition_id WHERE s.id=$1`,
      [conn.source_id]
    );
    const dst = await db.one(
      `SELECT d.*, c.name AS connector_name FROM destinations d JOIN connector_definitions c ON c.id=d.connector_definition_id WHERE d.id=$1`,
      [conn.destination_id]
    );
    const source = registry.get(src.connector_name);
    const destination = registry.get(dst.connector_name);
    const srcCfg = decryptJson(src.config_encrypted);
    const dstCfg = decryptJson(dst.config_encrypted);

    const catalog = buildCatalog(conn);
    const streamNames = catalog.streams.map((s) => s.name);
    await jobLog('info', `source=${src.connector_name} destination=${dst.connector_name} streams=[${streamNames.join(', ')}]`);

    // per-stream DB stat rows
    const streamStats = {};
    for (const s of catalog.streams) {
      const row = await db.one(
        `INSERT INTO sync_stream_stats (job_id, stream_name) VALUES ($1,$2) RETURNING id`,
        [jobId, s.name]
      );
      streamStats[s.name] = { id: row.id, read: 0, written: 0, failed: 0 };
    }

    // load saved cursor state
    const stateRows = await db.many('SELECT stream_name, state FROM connection_state WHERE connection_id=$1', [conn.id]);
    const state = Object.fromEntries(stateRows.map((r) => [r.stream_name, r.state]));

    const persistState = async (streamName, st) => {
      await db.query(
        `INSERT INTO connection_state (connection_id, stream_name, state, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (connection_id, stream_name) DO UPDATE SET state=$3, updated_at=now()`,
        [conn.id, streamName, JSON.stringify(st)]
      );
    };

    const ctx = {
      batchSize: config.worker.batchSize,
      logger: jobLog,
      bullJob,
      onState: persistState,
      connection: conn,
      namespace: conn.namespace || 'datamove',
    };

    // ---- message pipeline: read -> count -> transform -> flatten ----
    const streamCfgs = Object.fromEntries(catalog.streams.map((s) => [s.name, s]));
    const pipeline = transformStream(source.read(srcCfg, catalog, state, ctx), async (msg) => {
      if (msg.type === 'RECORD') {
        const cfg = streamCfgs[msg.stream];
        streamStats[msg.stream].read++;
        let data = applyTransforms(msg.data, cfg?.transforms);
        if (data === null) return null; // filtered out
        data = flattenRecord(data, { flatten: cfg?.transforms?.flatten !== false });
        return { ...msg, data };
      }
      return msg;
    });

    const writeStats = await destination.write(dstCfg, catalog, pipeline, ctx);

    // merge dest-side stats
    for (const [name, st] of Object.entries(writeStats?.streams || {})) {
      if (!streamStats[name]) streamStats[name] = { id: null, read: 0, written: 0, failed: 0 };
      streamStats[name].written = st.written || 0;
      streamStats[name].failed += st.failed || 0;
    }
    for (const [name, st] of Object.entries(streamStats)) {
      const status = st.failed > 0 && st.written === 0 ? 'failed' : 'succeeded';
      if (st.id) {
        await db.query(
          `UPDATE sync_stream_stats SET status=$3, records_read=$4, records_written=$5, records_failed=$6 WHERE id=$1 AND stream_name=$2`,
          [st.id, name, status, st.read, st.written, st.failed]
        );
      }
    }

    const totals = Object.values(streamStats).reduce(
      (a, s) => ({ read: a.read + s.read, written: a.written + s.written, failed: a.failed + s.failed }),
      { read: 0, written: 0, failed: 0 }
    );
    const finalStatus = totals.failed > 0 ? (totals.written > 0 ? 'partial' : 'failed') : 'succeeded';

    await db.query(
      `UPDATE sync_jobs SET status=$2, finished_at=now(), records_read=$3, records_written=$4, records_failed=$5, bytes_written=$6 WHERE id=$1`,
      [jobId, finalStatus, totals.read, totals.written, totals.failed, writeStats?.bytes || 0]
    );
    await db.query('UPDATE connections SET last_sync_at=now() WHERE id=$1', [conn.id]);
    await jobLog('info', `sync ${finalStatus}: read=${totals.read} written=${totals.written} failed=${totals.failed} in ${Date.now() - startedAt}ms`);

    if (conn.post_sync_command) runPostSync(conn.post_sync_command, jobLog);

    if (finalStatus === 'failed') throw new Error('all streams failed');
    return { jobId, status: finalStatus, totals };
  } catch (err) {
    return fail(err).catch((e) => ({ jobId, status: 'failed', error: String(e.message) }));
  }
}

function buildCatalog(conn) {
  const streams = (conn.catalog?.streams || []).map((s) => ({
    flatten: s.transforms?.flatten !== false,
    ...s,
  }));
  return { streams };
}

async function* transformStream(iter, fn) {
  for await (const msg of iter) {
    const out = await fn(msg);
    if (out !== null && out !== undefined) yield out;
  }
}

function makeJobLogger(jobId) {
  let buffer = [];
  let timer = null;
  const flush = async () => {
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    const vals = rows.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
    await db.query(
      `INSERT INTO job_logs (job_id, level, message, meta) VALUES ${vals}`,
      rows.flatMap((r) => [jobId, r.level, r.message, r.meta ? JSON.stringify(r.meta) : null])
    ).catch((e) => logger.error('job log flush failed', { err: e.message }));
  };
  const log = (level, message, meta) => {
    buffer.push({ level, message: String(message).slice(0, 4000), meta });
    logger.info(`[job ${jobId.slice(0, 8)}] ${message}`, meta);
    if (buffer.length >= 20) return flush();
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 1000);
    return Promise.resolve();
  };
  log.flush = flush;
  return log;
}

async function notifyFailure(conn, err) {
  const url = conn.notify_webhook_url || config.alertWebhookUrl;
  if (!url) return;
  try {
    await axios.post(url, {
      text: `DataMove sync failed: connection "${conn.name}" — ${err.message}`,
      connection: conn.name,
      error: err.message,
      ts: new Date().toISOString(),
    }, { timeout: 5000 });
  } catch (_) {}
}

function runPostSync(cmd, jobLog) {
  jobLog('info', `running post-sync command: ${cmd}`);
  const child = spawn(cmd, { shell: true });
  child.stdout.on('data', (d) => jobLog('info', `[post-sync] ${d}`));
  child.stderr.on('data', (d) => jobLog('warn', `[post-sync] ${d}`));
  child.on('exit', (code) => jobLog(code === 0 ? 'info' : 'warn', `post-sync exited ${code}`));
}

module.exports = { runSync };
