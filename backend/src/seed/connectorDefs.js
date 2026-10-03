const db = require('../core/db');
const registry = require('../connectors/registry');
const logger = require('../core/logger');
const { sourceCatalog, destinationCatalog } = require('./fivetranCatalog');

// Syncs two layers into connector_definitions:
//  1. implemented connectors from the code registry (source-*, destination-*)
//  2. catalog-only entries from the public Fivetran connector directory,
//     marked implemented=false — these render in the catalog UI but can't
//     be instantiated yet.

function catalogName(c) {
  // canonical internal name: 'cat:slug:display-name' keeps it unique + stable
  return `cat:${c.slug}:${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

async function syncConnectorDefs() {
  // ---- implemented connectors ----
  const implBySlugName = new Map();  // "slug|Name" -> connector
  const implBySlug = new Map();      // slug -> connector (fallback)
  for (const c of registry.list()) {
    const spec = (() => { try { return c.spec(); } catch { return {}; } })();
    await db.query(
      `INSERT INTO connector_definitions
         (name, type, version, display_name, description, icon, spec, supported_sync_modes,
          category, badge, implemented, catalog_slug, docs_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)
       ON CONFLICT (name) DO UPDATE SET
         version=$3, display_name=$4, description=$5, icon=$6, spec=$7, supported_sync_modes=$8,
         category=$9, badge=$10, implemented=true, catalog_slug=$11, docs_url=$12`,
      [c.name, c.type, c.version, c.displayName, c.description, c.icon,
       JSON.stringify(spec), c.supportedSyncModes || [],
       c.category || null, c.badge || null,
       c.catalogSlug || null,
       c.catalogSlug ? `https://fivetran.com/docs/${c.type === 'destination' ? 'destinations' : 'connectors'}/${c.catalogSlug}` : null]
    );
    if (c.catalogSlug) {
      implBySlugName.set(`${c.catalogSlug}|${c.catalogName || c.displayName}`, c);
      if (!implBySlug.has(c.catalogSlug)) implBySlug.set(c.catalogSlug, c);
    }
  }
  logger.info(`connector definitions synced: ${registry.list().length} implemented`);

  // ---- catalog-only entries ----
  const insertCatalog = async (entries, type) => {
    let linked = 0, added = 0;
    for (const e of entries) {
      // does an implemented connector claim this catalog entry?
      const impl = implBySlugName.get(`${e.slug}|${e.name}`) || implBySlug.get(e.slug);
      const row = {
        name: catalogName(e),
        type,
        display: e.name,
        description: impl ? `${e.name} connector.` : `${e.name} — available in the connector catalog.`,
        icon: null,
        spec: impl ? JSON.stringify((() => { try { return impl.spec(); } catch { return {}; } })()) : '{}',
        modes: impl ? (impl.supportedSyncModes || []) : [],
        category: e.category,
        badge: e.badge,
        implemented: !!impl,
        implName: impl ? impl.name : null,
        slug: e.slug,
        docs: e.docsUrl,
      };
      // Catalog entries that an implemented connector claims get folded into
      // the implemented row instead (display name + badge merged).
      if (impl) {
        await db.query(
          `UPDATE connector_definitions SET
             catalog_slug=$3, badge=COALESCE(badge,$4), docs_url=COALESCE(docs_url,$5), category=COALESCE(category,$6)
           WHERE name=$1 AND type=$2`,
          [impl.name, type, e.slug, e.badge, e.docsUrl, e.category]
        );
        linked++;
        continue;
      }
      await db.query(
        `INSERT INTO connector_definitions
           (name, type, version, display_name, description, icon, spec, supported_sync_modes,
            category, badge, implemented, catalog_slug, docs_url)
         VALUES ($1,$2,'1.0.0',$3,$4,$5,$6,$7,$8,$9,false,$10,$11)
         ON CONFLICT (type, catalog_slug, display_name) WHERE catalog_slug IS NOT NULL DO UPDATE SET
           display_name=$3, description=$4, category=$8, badge=$9, docs_url=$11`,
        [row.name, type, row.display, row.description, null, '{}', '{}',
         row.category, row.badge, row.slug, row.docs]
      );
      added++;
    }
    return { linked, added };
  };

  const s = await insertCatalog(sourceCatalog, 'source');
  const d = await insertCatalog(destinationCatalog, 'destination');
  logger.info(`catalog synced: ${s.added + d.added} catalog-only entries, ${s.linked + d.linked} linked to implementations`);
}

module.exports = { syncConnectorDefs };
