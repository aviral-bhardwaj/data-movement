const express = require('express');
const db = require('../core/db');
const { signToken, generateApiKey, authenticate, requireRole, audit, bcrypt } = require('../core/auth');
const { AppError, asyncWrap } = require('../core/errors');

const router = express.Router();

router.post('/login', asyncWrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.one('SELECT * FROM users WHERE email=$1', [email]);
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    throw new AppError('invalid credentials', 401);
  }
  res.json({ token: signToken(user), user: { id: user.id, email: user.email, role: user.role, name: user.name } });
}));

router.get('/me', authenticate, asyncWrap(async (req, res) => {
  const u = await db.one('SELECT id, email, name, role, created_at FROM users WHERE id=$1', [req.user.id]);
  res.json(u);
}));

router.post('/users', authenticate, requireRole('admin'), asyncWrap(async (req, res) => {
  const { email, password, role = 'viewer', name } = req.body || {};
  if (!email || !password) throw new AppError('email and password required');
  const hash = await bcrypt.hash(password, 10);
  const u = await db.one(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
    [email, name, hash, role]
  );
  await audit(req.user.id, 'user.create', 'user', u.id, { email, role });
  res.status(201).json(u);
}));

router.get('/users', authenticate, requireRole('admin'), asyncWrap(async (_req, res) => {
  res.json(await db.many('SELECT id, email, name, role, created_at FROM users ORDER BY created_at'));
}));

router.post('/apikeys', authenticate, requireRole('editor'), asyncWrap(async (req, res) => {
  const { key, prefix, hash } = generateApiKey();
  const row = await db.one(
    'INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, prefix, created_at',
    [req.user.id, req.body?.name || 'default', prefix, hash]
  );
  await audit(req.user.id, 'apikey.create', 'api_key', row.id, { name: row.name });
  res.status(201).json({ ...row, key }); // key shown once
}));

router.get('/apikeys', authenticate, asyncWrap(async (req, res) => {
  res.json(await db.many('SELECT id, name, prefix, revoked, last_used_at, created_at FROM api_keys WHERE user_id=$1', [req.user.id]));
}));

router.delete('/apikeys/:id', authenticate, asyncWrap(async (req, res) => {
  await db.query('UPDATE api_keys SET revoked=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
