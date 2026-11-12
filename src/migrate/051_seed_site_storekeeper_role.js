'use strict';

/**
 * Migration 051: Seed and Backfill Site Storekeeper Role Permissions & Capabilities
 *
 * 1. Ensures the 'site_storekeeper' role is marked as is_system = 1, active = 1.
 * 2. Backfills role_permissions for 'site_storekeeper' from DEFAULT_MATRIX using INSERT OR IGNORE.
 * 3. Backfills role_capabilities for 'site_storekeeper' from CAPABILITIES using INSERT OR IGNORE.
 * 4. Ensures any other missing default permissions from DEFAULT_MATRIX are seeded into role_permissions.
 *
 * Guarded by setting key 'migration_051_done'.
 */

const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');

function runMigration(targetDb) {
  console.log('=== Running Migration 051: Seed Site Storekeeper Role ===');
  if (!targetDb) return;

  const hasRoles = Boolean(targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles'").get());
  if (!hasRoles) {
    console.log('[051] Database has no roles table — skipping role seeding');
    return;
  }

  // 1. Ensure site_storekeeper role exists and is active system role
  const existingRole = targetDb.prepare("SELECT id, name, is_system FROM roles WHERE name = 'site_storekeeper'").get();
  if (!existingRole) {
    targetDb.prepare(`
      INSERT INTO roles (name, label, description, is_system, active)
      VALUES ('site_storekeeper', 'Site Storekeeper', 'Site-level storekeeper managing project site store inventory, issues, and receipts', 1, 1)
    `).run();
    console.log('[051] Created site_storekeeper role');
  } else {
    targetDb.prepare("UPDATE roles SET is_system = 1, active = 1, label = COALESCE(label, 'Site Storekeeper') WHERE name = 'site_storekeeper'").run();
    console.log('[051] Updated site_storekeeper role as system role');
  }

  // 2. Backfill role_permissions for site_storekeeper (and all roles in DEFAULT_MATRIX)
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
    console.log(`[051] Backfilled ${permsSeeded} role_permissions entries`);
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
    console.log(`[051] Backfilled ${capsSeeded} role_capabilities entries`);
  }

  console.log('=== Migration 051 Completed Successfully ===');
}

module.exports = { runMigration };
