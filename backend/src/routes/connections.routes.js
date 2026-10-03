const express = require('express');
const crypto = require('crypto');
const db = require('../core/db');
const { authenticate, requireRole, audit } = require('../core/auth');
const { AppError, asyncWrap } = require('../core/errors');
const { enqueueSync, upsertSchedule, removeSchedule, syncQueue } = require('../core/queue');
const config = require('../core/config');

const router = express.Router();
router.use(authenticate);

// ---- connections CRUD ----
router.get('/', asyncWrap(async (_req, res) => {
  const rows = await db.many(
    `SELECT c.*, s.name AS source_name, sd.display_name AS source_connector,
            d.name AS destination_name, dd.display_name AS destination_connector,
            (SELECT status FROM sync_jobs j WHERE j.connection_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_status,
            (SELECT finished_at FROM sync_jobs j WHERE j.connection_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_finished
     FROM connections c
     JOIN sources s ON s.id=c.source_id JOIN connector_definitions sd ON sd.id=s.connector_definition_id
     JOIN destinations d ON d.id=c.destination_id JOIN connector_definitions dd ON dd.id=d.connector_definition_id
     ORDER BY c.created_at DESC`
  );
  res.json(rows);
}));

router.get('/:id', asyncWrap(async (req, res) => {
  const c = await db.one(
    `SELECT c.*, s.name AS source_name, sd.name AS source_connector, d.name AS destination_name, dd.name AS destination_connector
     FROM connections c
     JOIN sources s ON s.id=c.source_id JOIN connector_definitions sd ON sd.id=s.connector_definition_id
     JOIN destinations d ON d.id=c.destination_id JOIN connector_definitions dd ON dd.id=d.connector_definition_id
     WHERE c.id=$1`, [req.params.id]);
  if (!c) throw new AppError('not found', 404);
  if (c.webhook_token) c.webhook_url = `${config.apiBaseUrl}/webhooks/${c.webhook_token}`;
  c.state = await db.many('SELECT stream_name, state, updated_at FROM connection_state WHERE connection_id=$1', [c.id]);
  res.json(c);
}));

router.post('/', requireRole('editor'), asyncWrap(async (req, res) => {
  const {
    name, sourceId, destinationId, catalog = { streams: [] },
    scheduleType = 'manual', scheduleValue, namespace,
    notifyWebhookUrl, postSyncCommand,
  } = req.body || {};
  if (!name || !sourceId || !destinationId) throw new AppError('name, sourceId, destinationId required');
  validateSchedule(scheduleType, scheduleValue);

  const row = await db.one(
    `INSERT INTO connections (name, source_id, destination_id, catalog, schedule_type, schedule_value, namespace, webhook_token, notify_webhook_url, post_sync_command, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name, sourceId, destinationId, JSON.stringify(catalog), scheduleType, scheduleValue || null,
     namespace || 'datamove', crypto.randomBytes(16).toString('hex'),
     notifyWebhookUrl || null, postSyncCommand || null, req.user.id]
  );
  if (['interval', 'cron', 'cdc'].includes(scheduleType)) {
    await upsertSchedule(row.id, scheduleType, scheduleValue);
  }
  await audit(req.user.id, 'connection.create', 'connection', row.id, { name });
  res.status(201).json(row);
}));

router.put('/:id', requireRole('editor'), asyncWrap(async (req, res) => {
  const c = await db.one('SELECT * FROM connections WHERE id=$1', [req.params.id]);
  if (!c) throw new AppError('not found', 404);
  const b = req.body || {};
  const scheduleType = b.scheduleType ?? c.schedule_type;
  const scheduleValue = b.scheduleValue ?? c.schedule_value;
  validateSchedule(scheduleType, scheduleValue);
  await db.query(
    `UPDATE connections SET name=$2, catalog=$3, schedule_type=$4, schedule_value=$5,
       namespace=$6, notify_webhook_url=$7, post_sync_command=$8, status=$9, updated_at=now()
     WHERE id=$1`,
    [req.params.id, b.name ?? c.name, JSON.stringify(b.catalog ?? c.catalog),
     scheduleType, scheduleValue, b.namespace ?? c.namespace,
     b.notifyWebhookUrl ?? c.notify_webhook_url, b.postSyncCommand ?? c.post_sync_command,
     b.status ?? c.status]
  );
  if (c.status === 'active' || b.status === 'active') {
    if (['interval', 'cron', 'cdc'].includes(scheduleType)) await upsertSchedule(req.params.id, scheduleType, scheduleValue);
    else await removeSchedule(req.params.id);
  }
  await audit(req.user.id, 'connection.update', 'connection', req.params.id, b);
  res.json({ ok: true });
}));

router.delete('/:id', requireRole('editor'), asyncWrap(async (req, res) => {
  await removeSchedule(req.params.id);
  await db.query('DELETE FROM connections WHERE id=$1', [req.params.id]);
  await audit(req.user.id, 'connection.delete', 'connection', req.params.id);
  res.json({ ok: true });
}));

router.post('/:id/pause', requireRole('editor'), asyncWrap(async (req, res) => {
  await db.query(`UPDATE connections SET status='paused', updated_at=now() WHERE id=$1`, [req.params.id]);
  await removeSchedule(req.params.id);
  res.json({ ok: true });
}));

router.post('/:id/resume', requireRole('editor'), asyncWrap(async (req, res) => {
  const c = await db.one('SELECT * FROM connections WHERE id=$1', [req.params.id]);
  if (!c) throw new AppError('not found', 404);
  await db.query(`UPDATE connections SET status='active', updated_at=now() WHERE id=$1`, [req.params.id]);
  if (['interval', 'cron', 'cdc'].includes(c.schedule_type)) {
    await upsertSchedule(c.id, c.schedule_type, c.schedule_value);
  }
  res.json({ ok: true });
}));

router.post('/:id/sync', requireRole('editor'), asyncWrap(async (req, res) => {
  const c = await db.one('SELECT * FROM connections WHERE id=$1', [req.params.id]);
  if (!c) throw new AppError('not found', 404);
  if (c.status !== 'active') throw new AppError(`connection is ${c.status}`, 409);
  const job = await db.one(
    `INSERT INTO sync_jobs (connection_id, status, trigger_type) VALUES ($1,'queued',$2) RETURNING *`,
    [c.id, req.user.viaApiKey ? 'api' : 'manual']
  );
  await enqueueSync({ jobId: job.id, connectionId: c.id, triggerType: job.trigger_type });
  await audit(req.user.id, 'connection.sync', 'connection', c.id, { jobId: job.id });
  res.status(202).json(job);
}));

router.delete('/:id/state', requireRole('editor'), asyncWrap(async (req, res) => {
  await db.query('DELETE FROM connection_state WHERE connection_id=$1', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/:id/jobs', asyncWrap(async (req, res) => {
  res.json(await db.many(
    `SELECT * FROM sync_jobs WHERE connection_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [req.params.id, Math.min(parseInt(req.query.limit || '50', 10), 200)]
  ));
}));

function validateSchedule(type, value) {
  if (type === 'cron' && !/^[\d*/,\-?LW# ]+$/.test(value || '')) throw new AppError('invalid cron expression');
  if (type === 'interval' && !/^\d+\s*(s|m|h|d)?$/i.test(value || '')) throw new AppError('invalid interval (e.g. 15m, 1h)');
}

module.exports = router;
