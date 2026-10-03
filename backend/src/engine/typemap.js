// Maps connector JSON-schema types to destination column types.

function pgType(prop) {
  const types = new Set([].concat(prop?.type || 'string'));
  if (types.has('integer')) return 'BIGINT';
  if (types.has('number')) return 'DOUBLE PRECISION';
  if (types.has('boolean')) return 'BOOLEAN';
  if (types.has('object') || types.has('array')) return 'JSONB';
  if (prop?.format === 'date-time') return 'TIMESTAMPTZ';
  if (prop?.format === 'date') return 'DATE';
  if (prop?.format === 'binary') return 'BYTEA';
  return 'TEXT';
}

function mysqlType(prop) {
  const types = new Set([].concat(prop?.type || 'string'));
  if (types.has('integer')) return 'BIGINT';
  if (types.has('number')) return 'DOUBLE';
  if (types.has('boolean')) return 'BOOLEAN';
  if (types.has('object') || types.has('array')) return 'JSON';
  if (prop?.format === 'date-time') return 'DATETIME(6)';
  if (prop?.format === 'date') return 'DATE';
  return 'TEXT';
}

function sqliteType(prop) {
  const types = new Set([].concat(prop?.type || 'string'));
  if (types.has('integer') || types.has('boolean')) return 'INTEGER';
  if (types.has('number')) return 'REAL';
  if (prop?.format === 'binary') return 'BLOB';
  return 'TEXT';
}

function mongoType(prop) {
  // Mongo keeps native types; schema only used for validation docs.
  const types = new Set([].concat(prop?.type || 'string'));
  if (types.has('integer') || types.has('number')) return 'number';
  if (types.has('boolean')) return 'bool';
  if (types.has('array')) return 'array';
  if (types.has('object')) return 'object';
  return 'string';
}

const mappers = { postgres: pgType, mysql: mysqlType, sqlite: sqliteType, mongodb: mongoType };

module.exports = { mapType: (dest, prop) => (mappers[dest] || pgType)(prop), pgType, mysqlType, sqliteType };
