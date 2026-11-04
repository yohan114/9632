'use strict';

/**
 * Migration 049: Store Location Project Links, Workshop Bridges & Context Access Grants
 *
 * 1. store_locations:
 *    - Ensure project_id INTEGER REFERENCES projects(id) column exists.
 *    - Explicitly link project site stores (CEP-03, Ruwanwella, Marawila, Batticaloa, Muthur)
 *      to their corresponding project in the projects table.
 *    - Explicitly ensure workshop_id links for site workshop stores (Galagedara -> workshop 2, CW -> workshop 1).
 *
 * 2. store_location_access:
 *    - Seed access grants for users based on their primary workshop / role.
 *
 * Runs across monolithic database (rawDb) and core database when multidb is active.
 * Idempotent: safe to run repeatedly.
 */

const { rawDb, multidb } = require('../db');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[049] Added column ${col} to ${table}`);
  }
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [049] Store Location Project Links Migration for ${label} ---`);

  // 1. Ensure project_id column on store_locations
  ensureCol(targetDb, 'store_locations', 'project_id', 'INTEGER REFERENCES projects(id)');

  // 2. Link store locations to projects by pattern matching or code
  const projects = targetDb.prepare('SELECT id, code, name FROM projects').all();
  const storeLocations = targetDb.prepare('SELECT id, code, name, store_type, project_id, workshop_id FROM store_locations').all();

  for (const sl of storeLocations) {
    // If project_id is missing, attempt to link with corresponding project
    if (!sl.project_id) {
      let matchedProj = null;
      if (sl.code === 'SITE-STORE-CEP03PROJE' || /CEP[- ]*03/i.test(sl.name)) {
        matchedProj = projects.find((p) => /CEP[- ]*03/i.test(p.name));
      } else if (sl.code === 'SITE-STORE-RUWANWELLA' || /Ruwanwella/i.test(sl.name)) {
        matchedProj = projects.find((p) => /Ruwanwella/i.test(p.name));
      } else if (sl.code === 'SITE-STORE-MARAWILARO' || /Marawila/i.test(sl.name)) {
        matchedProj = projects.find((p) => /Marawila/i.test(p.name));
      } else if (sl.code === 'SITE-STORE-BATTICALOA' || /Batticaloa/i.test(sl.name)) {
        matchedProj = projects.find((p) => /Batticaloa/i.test(p.name));
      } else if (sl.code === 'SITE-STORE-MUTHURPLAN' || /Muthur/i.test(sl.name)) {
        matchedProj = projects.find((p) => /Muthur/i.test(p.name));
      }

      if (matchedProj) {
        targetDb.prepare('UPDATE store_locations SET project_id = ? WHERE id = ?').run(matchedProj.id, sl.id);
        console.log(`[049] Linked store location '${sl.name}' (id: ${sl.id}) -> Project '${matchedProj.name}' (id: ${matchedProj.id})`);
      }
    }

    // Ensure workshop bridges
    if (sl.code === 'SITE-STORE-GWS' && (!sl.workshop_id || sl.workshop_id !== 2)) {
      targetDb.prepare('UPDATE store_locations SET workshop_id = 2 WHERE id = ?').run(sl.id);
    } else if (sl.code === 'MAIN-WORKSHOP' && (!sl.workshop_id || sl.workshop_id !== 1)) {
      targetDb.prepare('UPDATE store_locations SET workshop_id = 1 WHERE id = ?').run(sl.id);
    }
  }

  // 3. Ensure store_location_access table exists
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS store_location_access (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_location_id  INTEGER NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
      can_view           INTEGER NOT NULL DEFAULT 1,
      can_request        INTEGER NOT NULL DEFAULT 0,
      can_issue          INTEGER NOT NULL DEFAULT 0,
      can_receive        INTEGER NOT NULL DEFAULT 0,
      can_dispatch       INTEGER NOT NULL DEFAULT 0,
      can_count          INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, store_location_id)
    );
    CREATE INDEX IF NOT EXISTS idx_store_loc_access_user ON store_location_access(user_id);
    CREATE INDEX IF NOT EXISTS idx_store_loc_access_store ON store_location_access(store_location_id);
  `);

  // 4. Seed user store_location_access grants if missing
  const users = targetDb.prepare('SELECT id, username, workshop_id FROM users WHERE active = 1').all();
  const allStores = targetDb.prepare('SELECT id, code, name, store_type, workshop_id, is_default FROM store_locations WHERE active = 1').all();
  const mainStore = allStores.find((s) => s.store_type === 'MAIN_STORE') || allStores[0];
  const mainWsStore = allStores.find((s) => s.store_type === 'MAIN_WORKSHOP_STORE') || allStores[0];

  const insertAccess = targetDb.prepare(`
    INSERT OR IGNORE INTO store_location_access (user_id, store_location_id, can_view, can_request, can_issue, can_receive, can_dispatch, can_count)
    VALUES (?, ?, 1, 1, 1, 1, 1, 1)
  `);

  for (const u of users) {
    if (u.username === 'admin') {
      // Admin gets access to all stores
      for (const s of allStores) {
        insertAccess.run(u.id, s.id);
      }
    } else if (u.username === 'mstore') {
      // Main storekeeper gets access to Central Main Stores + Central Workshop Stores
      if (mainStore) insertAccess.run(u.id, mainStore.id);
      if (mainWsStore) insertAccess.run(u.id, mainWsStore.id);
    } else if (u.workshop_id === 2 || u.username === 'galagedara') {
      // Galagedara site user -> Galagedara Site Store
      const gwsStore = allStores.find((s) => s.workshop_id === 2 || s.code === 'SITE-STORE-GWS');
      if (gwsStore) insertAccess.run(u.id, gwsStore.id);
    } else {
      // Default to their workshop store or main store
      const wsStore = (u.workshop_id && allStores.find((s) => s.workshop_id === u.workshop_id)) || mainStore;
      if (wsStore) insertAccess.run(u.id, wsStore.id);
    }
  }

  console.log(`=== [049] Migration Completed for ${label} ===`);
}

function runMigration(optionalDb) {
  if (optionalDb) {
    migrateSingleDb(optionalDb, 'Passed Database');
  }

  if (multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()) {
    const core = multidb.getCoreDb();
    if (core && core !== optionalDb) {
      migrateSingleDb(core, 'Core Database');
    }
  }

  if (!optionalDb && rawDb) {
    migrateSingleDb(rawDb, 'Primary Database');
  }
}

module.exports = {
  runMigration,
  migrateSingleDb
};
