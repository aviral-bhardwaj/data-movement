const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  const key = `dm_${crypto.randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 10), hash: hashApiKey(key) };
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const row = await db.one(
        `SELECT k.id AS key_id, u.id, u.email, u.role FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = $1 AND k.revoked = false`,
        [hashApiKey(String(apiKey))]
      );
      if (!row) return res.status(401).json({ error: 'invalid api key' });
      db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => {});
      req.user = { id: row.id, email: row.email, role: row.role, viaApiKey: true };
      return next();
    }
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role] || 0;
    if (rank < ROLE_RANK[role]) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

async function audit(userId, action, entityType, entityId, details) {
  try {
    await db.query(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [userId, action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null]
    );
  } catch (_) {}
}

module.exports = { signToken, generateApiKey, authenticate, requireRole, audit, bcrypt };
