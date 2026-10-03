// Per-stream transformation layer.
// transforms: {
//   rename:   { oldName: newName },
//   cast:     { col: 'int'|'float'|'boolean'|'string'|'timestamp'|'json' },
//   filter:   [{ field, op, value }],   // row dropped unless ALL pass
//   drop:     [colNames],
//   flatten:  bool (default true)
// }

const OPS = {
  eq: (a, b) => a == b,
  neq: (a, b) => a != b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  contains: (a, b) => String(a ?? '').includes(String(b)),
  regex: (a, b) => new RegExp(b).test(String(a ?? '')),
  notnull: (a) => a !== null && a !== undefined,
};

function applyTransforms(data, transforms = {}) {
  if (!transforms || typeof transforms !== 'object') return data;

  for (const f of transforms.filter || []) {
    const op = OPS[f.op || 'eq'];
    if (!op) continue;
    if (!op(data?.[f.field], f.value)) return null; // drop record
  }

  let out = { ...data };
  for (const col of transforms.drop || []) delete out[col];

  if (transforms.rename) {
    for (const [from, to] of Object.entries(transforms.rename)) {
      if (from in out) {
        out[to] = out[from];
        delete out[from];
      }
    }
  }

  if (transforms.cast) {
    for (const [col, t] of Object.entries(transforms.cast)) {
      if (!(col in out) || out[col] === null || out[col] === undefined) continue;
      try {
        out[col] = castValue(out[col], t);
      } catch (_) {
        /* leave original on cast failure */
      }
    }
  }
  return out;
}

function castValue(v, t) {
  switch (t) {
    case 'int': case 'integer': return parseInt(v, 10);
    case 'float': case 'number': return parseFloat(v);
    case 'boolean': case 'bool':
      if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.toLowerCase());
      return Boolean(v);
    case 'string': return typeof v === 'object' ? JSON.stringify(v) : String(v);
    case 'timestamp': case 'date': case 'datetime': return new Date(v).toISOString();
    case 'json': return typeof v === 'string' ? JSON.parse(v) : v;
    default: return v;
  }
}

module.exports = { applyTransforms, castValue };
