// Record normalization: sanitizes column names and (optionally) flattens
// nested objects so relational destinations get a flat schema (Debezium/Airbyte
// style normalization). Arrays and nested objects at the leaf are kept as JSON.

function sanitizeName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^([0-9])/, '_$1')
    .toLowerCase()
    .slice(0, 120) || 'col';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);
}

function flattenRecord(data, { flatten = true, delimiter = '_', maxDepth = 3 } = {}) {
  const out = {};
  const walk = (obj, prefix, depth) => {
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = sanitizeName(rawKey);
      const path = prefix ? `${prefix}${delimiter}${key}` : key;
      if (flatten && isPlainObject(value) && depth < maxDepth) {
        walk(value, path, depth + 1);
      } else {
        out[path] = normalizeValue(value);
      }
    }
  };
  walk(data || {}, '', 0);
  return out;
}

function normalizeValue(v) {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (isPlainObject(v) || Array.isArray(v)) return v; // destinations serialize as JSON
  return v;
}

// Builds the effective JSON schema of flattened records for a stream.
function flattenJsonSchema(jsonSchema, opts) {
  const props = {};
  const walk = (schemaProps, prefix, depth) => {
    for (const [rawKey, s] of Object.entries(schemaProps || {})) {
      const key = sanitizeName(rawKey);
      const path = prefix ? `${prefix}${opts.delimiter}${key}` : key;
      const types = [].concat(s.type || 'string');
      if (opts.flatten && types.includes('object') && s.properties && depth < opts.maxDepth) {
        walk(s.properties, path, depth + 1);
      } else {
        props[path] = s;
      }
    }
  };
  walk(jsonSchema?.properties || {}, '', 0);
  return { type: 'object', properties: props };
}

module.exports = { sanitizeName, flattenRecord, flattenJsonSchema, isPlainObject };
