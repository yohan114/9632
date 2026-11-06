'use strict';

/**
 * Migration 053: MTN Store Locations Schema & Legacy Backfill
 *
 * 1. Ensures columns `from_store_location_id` and `to_store_location_id`
 *    exist on `mtn` and `mtn_lines`.
 * 2. Backfills missing store location IDs on `mtn` from:
 *    - `from_place` / `to_place` ('w:<id>', 'p:<id>')
 *    - textual locations (`from_location`, `to_location`)
 *    - associated asset project/workshop links (`from_asset_id`, `to_asset_id`)
 * 3. Synchronizes `from_store_location_id` and `to_store_location_id` from
 *    `mtn` headers down to `mtn_lines`.
 * 4. Produces a detailed dry-run/migration summary of mapped and unmapped notes.
 *
 * Runs once via settings key 'migration_053_done'.
 * Fully idempotent across single-database and multidb modes.
 */

const { rawDb, multidb } = require('../db');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[053] Added column ${col} to ${table}`);
  }
}

function resolveStoreLocation(place, text, assetId, targetDb) {
  // 1. Place string exact matches (w:<id>, p:<id>)
  if (place) {
    if (place === 'w:1') return 2; // Central Workshop Store
    if (place === 'w:2') return 3; // Galagedara Site Store
    if (place === 'p:1') return 4; // CEP-03 Project Site Store
    if (place === 'p:2') return 5; // Ruwanwella Project Site Store
    if (place === 'p:3') return 6; // Marawila Road Project Site Store
    if (place === 'p:4') return 7; // Batticaloa Project Site Store
    if (place === 'p:5') return 8; // Muthur Plant Site Store
  }

  // 2. Textual matching
  const t = String(text || '');
  if (/main\s*store/i.test(t)) return 1; // Central Main Stores
  if (/work\s*shop|central/i.test(t)) return 2; // Central Workshop Stores
  if (/galagedara|gws/i.test(t)) return 3; // Galagedara Site Store
  if (/cep[- /]*0?3|wadakada/i.test(t)) return 4; // CEP-03 Project Site Store
  if (/ruwanwella/i.test(t)) return 5; // Ruwanwella Site Store
  if (/marawila/i.test(t)) return 6; // Marawila Site Store
  if (/battic|bt\/03/i.test(t)) return 7; // Batticaloa Site Store
  if (/muthur/i.test(t)) return 8; // Muthur Plant Site Store

  // 3. Asset project links
  if (assetId && targetDb) {
    try {
      const a = targetDb.prepare('SELECT current_project_id, home_project_id FROM assets WHERE id = ?').get(assetId);
      if (a) {
        const p = a.current_project_id || a.home_project_id;
        if (p === 1) return 4;
        if (p === 2) return 5;
        if (p === 3) return 6;
        if (p === 4) return 7;
        if (p === 5) return 8;
      }
    } catch (_) {}
  }

  return null;
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [053] MTN Store Locations Migration for ${label} ---`);

  // 1. Ensure columns
  ensureCol(targetDb, 'mtn', 'from_store_location_id', 'INTEGER');
  ensureCol(targetDb, 'mtn', 'to_store_location_id', 'INTEGER');
  ensureCol(targetDb, 'mtn_lines', 'from_store_location_id', 'INTEGER');
  ensureCol(targetDb, 'mtn_lines', 'to_store_location_id', 'INTEGER');
  ensureCol(targetDb, 'mtn', 'stock_synced_at', 'TEXT');
  ensureCol(targetDb, 'mtn', 'receive_stock_synced_at', 'TEXT');

  // 2. Backfill MTNs
  const mtns = targetDb.prepare(`
    SELECT id, mtn_no, from_location, to_location, from_place, to_place,
           from_asset_id, to_asset_id, from_store_location_id, to_store_location_id
      FROM mtn
  `).all();

  let fromUpdated = 0;
  let toUpdated = 0;
  const unmapped = [];

  targetDb.transaction(() => {
    const updateStmt = targetDb.prepare(`
      UPDATE mtn
         SET from_store_location_id = ?,
             to_store_location_id = ?
       WHERE id = ?
    `);

    for (const m of mtns) {
      let fromLocId = m.from_store_location_id;
      let toLocId = m.to_store_location_id;
      let dirty = false;

      if (!fromLocId) {
        fromLocId = resolveStoreLocation(m.from_place, m.from_location, m.from_asset_id, targetDb) || 2; // Default from Central Workshop
        fromUpdated++;
        dirty = true;
      }

      if (!toLocId) {
        toLocId = resolveStoreLocation(m.to_place, m.to_location, m.to_asset_id, targetDb);
        if (toLocId) {
          toUpdated++;
          dirty = true;
        } else {
          unmapped.push({ id: m.id, mtn_no: m.mtn_no, to_location: m.to_location, to_place: m.to_place });
        }
      }

      if (dirty) {
        updateStmt.run(fromLocId, toLocId, m.id);
      }
    }

    // 3. Propagate to mtn_lines
    targetDb.exec(`
      UPDATE mtn_lines
         SET from_store_location_id = (SELECT from_store_location_id FROM mtn WHERE mtn.id = mtn_lines.mtn_id)
       WHERE from_store_location_id IS NULL
         AND mtn_id IN (SELECT id FROM mtn WHERE from_store_location_id IS NOT NULL);

      UPDATE mtn_lines
         SET to_store_location_id = (SELECT to_store_location_id FROM mtn WHERE mtn.id = mtn_lines.mtn_id)
       WHERE to_store_location_id IS NULL
         AND mtn_id IN (SELECT id FROM mtn WHERE to_store_location_id IS NOT NULL);
    `);
  })();

  console.log(`[053] Backfilled ${fromUpdated} origin store locations, ${toUpdated} destination store locations.`);
  console.log(`[053] ${unmapped.length} legacy MTNs remain unmapped to physical warehouse stores (direct external transfers).`);
  if (unmapped.length > 0) {
    console.log(`[053] Unmapped sample:`, unmapped.slice(0, 5));
  }
  console.log(`=== [053] Migration Completed for ${label} ===`);
  return { fromUpdated, toUpdated, unmappedCount: unmapped.length };
}

function runMigration(optionalDb) {
  if (optionalDb) {
    return migrateSingleDb(optionalDb, 'Passed Database');
  }

  if (multidb && multidb.isMultiDbEnabled && multidb.isMultiDbEnabled()) {
    const workshops = multidb.getAvailableWorkshops();
    for (const ws of workshops) {
      const wdb = multidb.getWorkshopDb(ws.id);
      migrateSingleDb(wdb, `Workshop ${ws.id} (${ws.code})`);
    }
    const coreDb = multidb.getCoreDb();
    migrateSingleDb(coreDb, 'Core Database');
  } else {
    migrateSingleDb(rawDb, 'Monolithic Database');
  }
}

module.exports = {
  runMigration,
  resolveStoreLocation
};
