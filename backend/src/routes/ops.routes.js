const express = require('express');
const db = require('../core/db');
const redis = require('../core/redis');
const { authenticate, requireRole } = require('../core/auth');
const { AppError, asyncWrap } = require('../core/errors');
const { syncQueue } = require('../core/queue');
const registry = require('../connectors/registry');

const router = express.Router();

// public health
router.get('/health', asyncWrap(async (_req, res) => {
  const checks = {};
  try { await db.one('SELECT 1'); checks.postgres = 'up'; } catch (e) { checks.postgres = `down: ${e.message}`; }
  try { await redis.ping(); checks.redis = 'up'; } catch (e) { checks.redis = `down: ${e.message}`; }
  const counts = await syncQueue.getJobCounts().catch(() => ({}));
  res.json({
    status: checks.postgres === 'up' && checks.redis === 'up' ? 'ok' : 'degraded',
    checks, queue: counts, connectors: registry.list().length,
    ts: new Date().toISOString(),
  });
}));

// webhook ingestion also available under the API prefix for convenience
router.use('/webhooks', require('./webhook.routes'));

// public stats for the marketing home page (no auth)
router.get('/public/stats', asyncWrap(async (_req, res) => {
  const [defs, conns, rows] = await Promise.all([
    db.one(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE implemented) implemented,
                   COUNT(*) FILTER (WHERE type='source') sources,
                   COUNT(*) FILTER (WHERE type='destination') destinations
            FROM connector_definitions`),
    db.one(`SELECT COUNT(*) total FROM connections`),
    db.one(`SELECT COALESCE(SUM(records_written),0) rows_written FROM sync_jobs`),
  ]);
  res.json({ connectors: defs, connections: conns.total, rowsWritten: rows.rows_written });
}));

// public connector list for the landing page wall / public catalog preview
router.get('/public/connectors', asyncWrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '80', 10), 400);
  const rows = await db.many(
    `SELECT name, display_name, icon, category, badge, implemented
     FROM connector_definitions
     WHERE type='source'
     ORDER BY implemented DESC, display_name
     LIMIT $1`, [limit]);
  res.json(rows);
}));

router.use(authenticate);

// ---- sync jobs ----
router.get('/syncs', asyncWrap(async (req, res) => {
  const { status, connectionId } = req.query;
  let sql = `SELECT j.*, c.name AS connection_name FROM sync_jobs j JOIN connections c ON c.id=j.connection_id`;
  const params = [], conds = [];
  if (status) { params.push(status); conds.push(`j.status=$${params.length}`); }
  if (connectionId) { params.push(connectionId); conds.push(`j.connection_id=$${params.length}`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  params.push(Math.min(parseInt(req.query.limit || '50', 10), 200));
  sql += ` ORDER BY j.created_at DESC LIMIT $${params.length}`;
  res.json(await db.many(sql, params));
}));

router.get('/syncs/:id', asyncWrap(async (req, res) => {
  const job = await db.one('SELECT j.*, c.name AS connection_name FROM sync_jobs j JOIN connections c ON c.id=j.connection_id WHERE j.id=$1', [req.params.id]);
  if (!job) throw new AppError('not found', 404);
  job.streams = await db.many('SELECT * FROM sync_stream_stats WHERE job_id=$1', [job.id]);
  res.json(job);
}));

router.get('/syncs/:id/logs', asyncWrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
  res.json(await db.many('SELECT * FROM job_logs WHERE job_id=$1 ORDER BY ts DESC LIMIT $2', [req.params.id, limit]));
}));

router.post('/syncs/:id/cancel', requireRole('editor'), asyncWrap(async (req, res) => {
  const job = await db.one('SELECT * FROM sync_jobs WHERE id=$1', [req.params.id]);
  if (!job) throw new AppError('not found', 404);
  if (job.status === 'queued') {
    await syncQueue.remove(String(job.id)).catch(() => {});
    await db.query(`UPDATE sync_jobs SET status='cancelled', finished_at=now() WHERE id=$1`, [job.id]);
  } else if (job.status === 'running') {
    await db.query(`UPDATE sync_jobs SET status='cancelled', finished_at=now(), error='cancelled by user' WHERE id=$1`, [job.id]);
  }
  res.json({ ok: true });
}));

// ---- logs search ----
router.get('/logs', asyncWrap(async (req, res) => {
  const params = [];
  let sql = `SELECT l.*, j.connection_id, c.name AS connection_name
             FROM job_logs l JOIN sync_jobs j ON j.id=l.job_id JOIN connections c ON c.id=j.connection_id`;
  const conds = [];
  if (req.query.level) { params.push(req.query.level); conds.push(`l.level=$${params.length}`); }
  if (req.query.q) { params.push(`%${req.query.q}%`); conds.push(`l.message ILIKE $${params.length}`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  params.push(Math.min(parseInt(req.query.limit || '100', 10), 1000));
  sql += ` ORDER BY l.ts DESC LIMIT $${params.length}`;
  res.json(await db.many(sql, params));
}));

// ---- metrics ----
router.get('/metrics/overview', asyncWrap(async (_req, res) => {
  const [conns, jobs24h, totals, byStatus] = await Promise.all([
    db.one(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='active') active FROM connections`),
    db.one(`SELECT COUNT(*) total,
              COUNT(*) FILTER (WHERE status='succeeded') succeeded,
              COUNT(*) FILTER (WHERE status='failed') failed,
              COUNT(*) FILTER (WHERE status='partial') partial,
              COUNT(*) FILTER (WHERE status='running') running,
              COALESCE(SUM(records_written),0) rows_written,
              COALESCE(SUM(records_read),0) rows_read,
              COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at-started_at))),0) avg_seconds
            FROM sync_jobs WHERE created_at > now() - interval '24 hours'`),
    db.one(`SELECT COALESCE(SUM(records_written),0) rows_written, COUNT(*) total_jobs FROM sync_jobs`),
    db.many(`SELECT status, COUNT(*) FROM sync_jobs GROUP BY status`),
  ]);
  res.json({ connections: conns, last24h: jobs24h, allTime: totals, jobsByStatus: byStatus });
}));

router.get('/metrics/timeseries', asyncWrap(async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10), 720);
  res.json(await db.many(
    `SELECT date_trunc('hour', created_at) AS bucket,
            COUNT(*) jobs,
            COUNT(*) FILTER (WHERE status='succeeded') succeeded,
            COUNT(*) FILTER (WHERE status='failed') failed,
            COALESCE(SUM(records_written),0) rows_written
     FROM sync_jobs WHERE created_at > now() - ($1 || ' hours')::interval
     GROUP BY 1 ORDER BY 1`,
    [hours]
  ));
}));

router.get('/metrics/connectors', asyncWrap(async (_req, res) => {
  res.json(await db.many(
    `SELECT sd.display_name AS source_connector, dd.display_name AS destination_connector,
            COUNT(*) connections,
            (SELECT COUNT(*) FROM sync_jobs j WHERE j.connection_id=c.id AND j.status='failed') failures
     FROM connections c
     JOIN sources s ON s.id=c.source_id JOIN connector_definitions sd ON sd.id=s.connector_definition_id
     JOIN destinations d ON d.id=c.destination_id JOIN connector_definitions dd ON dd.id=d.connector_definition_id
     GROUP BY 1,2`
  ));
}));

// ---- audit ----
router.get('/audit', requireRole('admin'), asyncWrap(async (req, res) => {
  res.json(await db.many('SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1', [Math.min(parseInt(req.query.limit || '200', 10), 1000)]));
}));

module.exports = router;
