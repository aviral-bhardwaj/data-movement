const express = require('express');
const db = require('../core/db');
const { encryptJson, decryptJson } = require('../core/crypto');
const { authenticate, requireRole, audit } = require('../core/auth');
const { AppError, asyncWrap } = require('../core/errors');
const registry = require('../connectors/registry');

const router = express.Router();
router.use(authenticate);

// ---- connector catalog ----
router.get('/connectors', asyncWrap(async (req, res) => {
  const defs = await db.many(
    `SELECT id, name, type, version, display_name, description, icon, spec, supported_sync_modes
     FROM connector_definitions ${req.query.type ? 'WHERE type=$1' : ''} ORDER BY type, display_name`,
    req.query.type ? [req.query.type] : []
  );
  res.json(defs);
}));

// ad-hoc check/discover against raw config (used by setup wizards before save)
router.post('/connectors/:name/check', asyncWrap(async (req, res) => {
  res.json(await registry.get(req.params.name).check(req.body?.config || {}));
}));

router.post('/connectors/:name/discover', requireRole('editor'), asyncWrap(async (req, res) => {
  const c = registry.get(req.params.name);
  if (c.type !== 'source') throw new AppError('not a source connector');
  res.json(await c.discover(req.body?.config || {}));
}));

// ---- generic CRUD factory for source/destination instances ----
function instanceRoutes(kind) {
  const table = kind === 'source' ? 'sources' : 'destinations';
  const defType = kind;

  const r = express.Router();

  r.get('/', asyncWrap(async (_req, res) => {
    const rows = await db.many(
      `SELECT s.id, s.name, s.status, s.last_check_status, s.last_check_at, s.created_at,
              c.name AS connector, c.display_name AS connector_name, c.icon
       FROM ${table} s JOIN connector_definitions c ON c.id = s.connector_definition_id
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  }));

  r.get('/:id', asyncWrap(async (req, res) => {
    const row = await db.one(
      `SELECT s.*, c.name AS connector, c.display_name AS connector_name
       FROM ${table} s JOIN connector_definitions c ON c.id = s.connector_definition_id WHERE s.id=$1`,
      [req.params.id]
    );
    if (!row) throw new AppError('not found', 404);
    // decrypt for display but mask secrets
    const cfg = decryptJson(row.config_encrypted) || {};
    const spec = registry.get(row.connector).spec()?.connectionSpecification?.properties || {};
    for (const [k, v] of Object.entries(spec)) {
      if (v.airbyte_secret && cfg[k]) cfg[k] = '••••••••';
    }
    row.config = cfg;
    delete row.config_encrypted;
    res.json(row);
  }));

  r.post('/', requireRole('editor'), asyncWrap(async (req, res) => {
    const { name, connector, config } = req.body || {};
    const def = await db.one('SELECT * FROM connector_definitions WHERE name=$1 AND type=$2', [connector, defType]);
    if (!def) throw new AppError(`unknown ${kind} connector: ${connector}`);
    const check = await registry.get(connector).check(config || {});
    const row = await db.one(
      `INSERT INTO ${table} (name, connector_definition_id, config_encrypted, last_check_status, last_check_at, created_by)
       VALUES ($1,$2,$3,$4,now(),$5) RETURNING *`,
      [name, def.id, encryptJson(config || {}), check.status, req.user.id]
    );
    await audit(req.user.id, `${kind}.create`, kind, row.id, { name, connector });
    res.status(201).json({ ...row, config_encrypted: undefined, check });
  }));

  r.put('/:id', requireRole('editor'), asyncWrap(async (req, res) => {
    const { name, config } = req.body || {};
    const row = await db.one(`SELECT s.*, c.name AS connector FROM ${table} s JOIN connector_definitions c ON c.id=s.connector_definition_id WHERE s.id=$1`, [req.params.id]);
    if (!row) throw new AppError('not found', 404);
    let newConfig = decryptJson(row.config_encrypted) || {};
    if (config) {
      // merge: '••••••••' means "keep existing secret"
      for (const [k, v] of Object.entries(config)) {
        newConfig[k] = v === '••••••••' ? newConfig[k] : v;
      }
    }
    const check = await registry.get(row.connector).check(newConfig);
    await db.query(
      `UPDATE ${table} SET name=$2, config_encrypted=$3, last_check_status=$4, last_check_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, name || row.name, encryptJson(newConfig), check.status]
    );
    await audit(req.user.id, `${kind}.update`, kind, req.params.id, { name });
    res.json({ ok: true, check });
  }));

  r.delete('/:id', requireRole('editor'), asyncWrap(async (req, res) => {
    const refCol = kind === 'source' ? 'source_id' : 'destination_id';
    const used = await db.one(`SELECT id, name FROM connections WHERE ${refCol}=$1 LIMIT 1`, [req.params.id]);
    if (used) throw new AppError(`in use by connection "${used.name}"`, 409);
    await db.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
    await audit(req.user.id, `${kind}.delete`, kind, req.params.id);
    res.json({ ok: true });
  }));

  r.post('/:id/check', asyncWrap(async (req, res) => {
    const row = await db.one(
      `SELECT s.*, c.name AS connector FROM ${table} s JOIN connector_definitions c ON c.id=s.connector_definition_id WHERE s.id=$1`,
      [req.params.id]
    );
    if (!row) throw new AppError('not found', 404);
    const result = await registry.get(row.connector).check(decryptJson(row.config_encrypted) || {});
    await db.query(`UPDATE ${table} SET last_check_status=$2, last_check_at=now() WHERE id=$1`, [req.params.id, result.status]);
    res.json(result);
  }));

  if (kind === 'source') {
    r.post('/:id/discover', asyncWrap(async (req, res) => {
      const row = await db.one(
        `SELECT s.*, c.name AS connector FROM sources s JOIN connector_definitions c ON c.id=s.connector_definition_id WHERE s.id=$1`,
        [req.params.id]
      );
      if (!row) throw new AppError('not found', 404);
      res.json(await registry.get(row.connector).discover(decryptJson(row.config_encrypted) || {}));
    }));
  }
  return r;
}

router.use('/sources', instanceRoutes('source'));
router.use('/destinations', instanceRoutes('destination'));

module.exports = router;
