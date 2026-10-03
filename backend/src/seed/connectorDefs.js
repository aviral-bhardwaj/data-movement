const db = require('../core/db');
const registry = require('../connectors/registry');
const logger = require('../core/logger');

// Registers every connector in the registry into connector_definitions,
// keeping spec/version in sync with code on each boot.
async function syncConnectorDefs() {
  for (const c of registry.list()) {
    const spec = (() => { try { return c.spec(); } catch { return {}; } })();
    await db.query(
      `INSERT INTO connector_definitions (name, type, version, display_name, description, icon, spec, supported_sync_modes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET
         version=$3, display_name=$4, description=$5, icon=$6, spec=$7, supported_sync_modes=$8`,
      [c.name, c.type, c.version, c.displayName, c.description, c.icon,
       JSON.stringify(spec), c.supportedSyncModes || []]
    );
  }
  logger.info(`connector definitions synced: ${registry.list().length}`);
}

module.exports = { syncConnectorDefs };
