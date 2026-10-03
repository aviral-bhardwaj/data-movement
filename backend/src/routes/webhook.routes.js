const express = require('express');
const crypto = require('crypto');
const db = require('../core/db');
const { AppError, asyncWrap } = require('../core/errors');

const router = express.Router();

// Public webhook ingest — the token in the URL is the secret.
// Events are buffered in Redis and drained by the webhook source connector.
router.post('/:token', asyncWrap(async (req, res) => {
  const conn = await db.one(
    `SELECT id FROM connections WHERE webhook_token=$1 AND status='active'`,
    [req.params.token]
  );
  if (!conn) throw new AppError('unknown webhook', 404);
  const { bufferEvent } = require('../connectors/sources/webhook');
  await bufferEvent(req.params.token, {
    _id: crypto.randomUUID(),
    _received_at: new Date().toISOString(),
    _headers: { 'content-type': req.headers['content-type'], 'user-agent': req.headers['user-agent'] },
    payload: req.body,
  });
  res.status(202).json({ ok: true });
}));

module.exports = router;
