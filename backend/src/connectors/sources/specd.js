const path = require('path');
const fs = require('fs');
const { SpecdSource } = require('./_specd/engine');

// Loads every spec module under _specd/ and exposes all of them as connectors.
// Each spec module exports an array of spec objects.
const connectors = [];
const dir = path.join(__dirname, '_specd');
for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith('.js') || file === 'engine.js') continue;
  try {
    const specs = require(path.join(dir, file));
    for (const spec of specs) connectors.push(new SpecdSource(spec));
  } catch (e) {
    console.warn(`[specd] failed to load ${file}: ${e.message}`);
  }
}

module.exports = connectors;
