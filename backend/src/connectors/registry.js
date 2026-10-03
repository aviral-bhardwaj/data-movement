const path = require('path');
const fs = require('fs');

// Loads every connector module in sources/ and destinations/.
// Each module exports a class instance (singleton is fine — connectors are stateless).

const registry = new Map();

function loadDir(dir, type) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js') || file.startsWith('_')) continue;
    try {
      const mod = require(path.join(dir, file));
      // A module may export a single connector or an array (spec-driven packs, db variants).
      const items = Array.isArray(mod) ? mod : [mod.default || mod];
      for (const conn of items) {
        const instance = typeof conn === 'function' ? new conn() : conn;
        if (!instance || !instance.name) continue;
        instance.type = type;
        registry.set(instance.name, instance);
      }
    } catch (e) {
      // Optional connectors may miss deps; skip but note it.
      console.warn(`[registry] skipped ${file}: ${e.message}`);
    }
  }
}

loadDir(path.join(__dirname, 'sources'), 'source');
loadDir(path.join(__dirname, 'destinations'), 'destination');

function get(name) {
  const c = registry.get(name);
  if (!c) throw new Error(`unknown connector: ${name}`);
  return c;
}

function list(type) {
  return [...registry.values()].filter((c) => !type || c.type === type);
}

module.exports = { get, list, registry };
