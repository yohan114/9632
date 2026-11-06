'use strict';

/**
 * Migration 052: Fabrication Access Foundation, General Works Schema & Costing Sheet
 *
 * 1. Seed and activate role 'fabrication_officer'
 * 2. Backfill role_permissions and role_capabilities from canonical definitions
 * 3. Add General Works columns to job_requests and job_cards:
 *    - work_target ('vehicle' | 'general', default 'vehicle')
 *    - category, drawing_ref, drawing_path, drawing_filename, cost_centre, quantity_or_size, deliver_to
 * 4. Create fabrication_costing_sheets table with draft -> submit -> approve/reject lifecycle
 * 5. Create fabrication_costing_adjustments table for manual non-stock and outsourced work lines
 * 6. Create fabrication_categories table with standard seed categories
 * 7. Ensure fabrication settings in settings table
 *
 * Guarded by setting key 'migration_052_done'.
 */

const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[052] Added column ${col} to ${table}`);
  }
}

function runMigration(targetDb) {
  console.log('=== Running Migration 052: Fabrication Access Foundation & General Works Schema ===');
  if (!targetDb) return;

  // 1. Ensure roles table exists and seed fabrication_officer
  const hasRoles = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles'").get());
  if (hasRoles) {
    const existingRole = targetDb.prepare("SELECT id, name, is_system FROM roles WHERE name = 'fabrication_officer'").get();
    if (!existingRole) {
      targetDb.prepare(`
        INSERT INTO roles (name, label, description, is_system, active)
        VALUES ('fabrication_officer', 'Fabrication Officer', 'Manages fabrication jobs, general works specifications, drawings, and costing sheets', 1, 1)
      `).run();
      console.log('[052] Created fabrication_officer role');
    } else {
      targetDb.prepare("UPDATE roles SET is_system = 1, active = 1, label = COALESCE(label, 'Fabrication Officer') WHERE name = 'fabrication_officer'").run();
      console.log('[052] Updated fabrication_officer role as system role');
    }
  }

  // 2. Backfill role_permissions
  const hasRolePerms = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_permissions'").get());
  if (hasRolePerms) {
    const insertPermStmt = targetDb.prepare('INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES (?, ?, ?)');
    let permsSeeded = 0;
    for (const [role, mods] of Object.entries(permissions.DEFAULT_MATRIX)) {
      for (const [mod, lvl] of Object.entries(mods)) {
        const info = insertPermStmt.run(role, mod, lvl);
        if (info.changes) permsSeeded++;
      }
    }
    console.log(`[052] Backfilled ${permsSeeded} role_permissions entries`);
  }

  // 3. Backfill role_capabilities
  const hasRoleCaps = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_capabilities'").get());
  if (hasRoleCaps) {
    const insertCapStmt = targetDb.prepare(`
      INSERT OR IGNORE INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
    `);
    let capsSeeded = 0;
    for (const c of capabilities.CAPABILITIES) {
      for (const role of c.legacy) {
        const info = insertCapStmt.run(role, c.key);
        if (info.changes) capsSeeded++;
      }
    }
    console.log(`[052] Backfilled ${capsSeeded} role_capabilities entries`);
  }

  // Check if targetDb is a workshop database (has job_cards or job_requests)
  const isWorkshopDb = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_cards'").get());
  if (!isWorkshopDb) {
    console.log('[052] Core DB updated (roles/permissions/capabilities); skipping workshop schema');
    return;
  }

  // 4. Columns on job_requests and job_cards for General Works
  ensureCol(targetDb, 'job_requests', 'work_target', "TEXT DEFAULT 'vehicle'");
  ensureCol(targetDb, 'job_requests', 'category', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'drawing_ref', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'drawing_path', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'drawing_filename', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'cost_centre', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'quantity_or_size', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'deliver_to', 'TEXT');

  ensureCol(targetDb, 'job_cards', 'work_target', "TEXT DEFAULT 'vehicle'");
  ensureCol(targetDb, 'job_cards', 'category', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'drawing_ref', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'drawing_path', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'drawing_filename', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'cost_centre', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'quantity_or_size', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'deliver_to', 'TEXT');

  // 5. Create Costing Tables
  // In multi-database SQLite setups, users table resides in core.db so workshop db cannot FK to users(id).
  targetDb.pragma('foreign_keys = OFF');
  try {
    const adjTable = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fabrication_costing_adjustments'").get();
    if (adjTable && adjTable.sql && adjTable.sql.includes('REFERENCES users(id)')) {
      targetDb.exec('DROP TABLE IF EXISTS fabrication_costing_adjustments;');
    }
    const sheetTable = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fabrication_costing_sheets'").get();
    if (sheetTable && sheetTable.sql && sheetTable.sql.includes('REFERENCES users(id)')) {
      targetDb.exec('DROP TABLE IF EXISTS fabrication_costing_sheets;');
    }
  } finally {
    targetDb.pragma('foreign_keys = ON');
  }

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS fabrication_costing_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL UNIQUE REFERENCES job_cards(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
      estimated_materials REAL DEFAULT 0,
      estimated_labour REAL DEFAULT 0,
      estimated_total REAL DEFAULT 0,
      outside_quotation REAL DEFAULT 0,
      overhead_percentage REAL DEFAULT 0,
      prepared_by INTEGER,
      prepared_at TEXT,
      submitted_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      rejected_by INTEGER,
      rejected_at TEXT,
      rejection_reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fabrication_costing_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL REFERENCES fabrication_costing_sheets(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('non_stock_purchase', 'outsourced_work', 'other')),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      supplier_or_contractor TEXT,
      invoice_ref TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fabrication_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 6. Seed fabrication categories
  const categories = [
    { key: 'road_marks', label: 'Road Marks / Sign Boards', description: 'Highway markers, directional boards, and traffic signage', order: 10 },
    { key: 'beds', label: 'Beds / Furniture', description: 'Camp beds, bunks, steel tables and workshop furniture', order: 20 },
    { key: 'stands', label: 'Stands / Frameworks', description: 'Engine stands, transmission fixtures, structural racks and trestles', order: 30 },
    { key: 'containers', label: 'Containers / Skips', description: 'Rubbish skips, equipment storage enclosures, metal bins', order: 40 },
    { key: 'brackets', label: 'Brackets / Mounts', description: 'Heavy machinery mounting brackets, reinforcing plates, lugs', order: 50 },
    { key: 'other', label: 'Other General Works', description: 'Custom metalwork, gates, railings, and miscellaneous welding', order: 90 }
  ];

  const catStmt = targetDb.prepare(`
    INSERT OR IGNORE INTO fabrication_categories (key, label, description, display_order)
    VALUES (?, ?, ?, ?)
  `);
  for (const c of categories) {
    catStmt.run(c.key, c.label, c.description, c.order);
  }

  // 7. Default Settings
  const hasSettings = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get());
  if (hasSettings) {
    targetDb.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fabrication.enabled', '1')").run();
    targetDb.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fabrication.default_overhead_rate', '0')").run();
  }

  console.log('=== Migration 052 Completed Successfully ===');
}

module.exports = { runMigration };
