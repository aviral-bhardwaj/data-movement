const { PostgresDestination } = require('./postgres');

// Redshift destination — Postgres wire protocol. Redshift differs mainly in
// type support (no real JSONB, prefers SUPER) and lacks ON CONFLICT for
// tables without a declared PK, which we already declare.
class RedshiftDestination extends PostgresDestination {
  constructor() {
    super();
    this.name = 'destination-redshift';
    this.displayName = 'Redshift';
    this.description = 'Load data into Amazon Redshift via the Postgres protocol with PK upserts.';
    this.icon = '🚀';
    this.category = 'Warehouse';
    this.catalogSlug = 'redshift';
  }

  spec() {
    const s = super.spec();
    s.connectionSpecification.properties.port.default = 5439;
    return s;
  }

  // Redshift has no native JSONB; SUPER exists on ra3+ but TEXT is the
  // safest default across all node types.
  _val(v, colType) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
    return super._val(v, colType);
  }

  async _evolve(c, t, data) {
    const IDENT = (s) => `"${String(s).replace(/"/g, '""')}"`;
    for (const key of Object.keys(data)) {
      if (!t.columns.has(key)) {
        const v = data[key];
        const type = typeof v === 'number' ? (Number.isInteger(v) ? 'BIGINT' : 'DOUBLE PRECISION')
          : typeof v === 'boolean' ? 'BOOLEAN'
          : (v !== null && typeof v === 'object') ? 'SUPER' : 'VARCHAR(65535)';
        await c.query(`ALTER TABLE ${t.qualified} ADD COLUMN IF NOT EXISTS ${IDENT(key)} ${type}`);
        t.columns.set(key, type);
      }
    }
  }
}

module.exports = new RedshiftDestination();
