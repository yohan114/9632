'use strict';

/**
 * Migration 058: Grant Assistant Transport Manager Asset, Project & Pre-Approval JR Edit Permissions
 *
 * Ensures upgraded DBs align with updated role defaults for `assistant_transport_manager`
 * (and `jobrequests.edit` for transport/workshop/manager roles), while guarding with
 * `migration_058_done` so any later Access Control changes made by an administrator persist.
 */

function runMigration(targetDb) {
  if (!targetDb) return { applied: false };

  const hasTable = (name) => !!targetDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);

  if (!hasTable('role_permissions') || !hasTable('role_capabilities') || !hasTable('settings')) {
    return { applied: false };
  }

  if (targetDb.prepare("SELECT 1 FROM settings WHERE key = 'migration_058_done'").get()) {
    return { applied: false };
  }

  const seeded = targetDb
    .prepare("SELECT COUNT(*) AS c FROM role_permissions WHERE role = 'assistant_transport_manager'")
    .get();
  if (!seeded || seeded.c === 0) {
    return { applied: false };
  }

  const ATM = 'assistant_transport_manager';
  const result = targetDb.transaction(() => {
    let moduleUpdates = 0;
    const modStmt = targetDb.prepare(`
      INSERT INTO role_permissions (role, module, level)
      VALUES (?, ?, 'edit')
      ON CONFLICT(role, module) DO UPDATE
      SET level = 'edit'
      WHERE level IN ('none', 'view')
    `);
    moduleUpdates += modStmt.run(ATM, 'assets').changes;
    moduleUpdates += modStmt.run(ATM, 'projects').changes;
    moduleUpdates += modStmt.run(ATM, 'jobrequests').changes;

    const capStmt = targetDb.prepare(`
      INSERT INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(role, capability) DO UPDATE
      SET granted = 1, updated_at = datetime('now')
      WHERE granted = 0
    `);

    let capChanges = 0;
    for (const cap of ['assets.create', 'assets.edit', 'assets.photo.upload', 'projects.manage', 'jobrequests.edit']) {
      capChanges += capStmt.run(ATM, cap).changes;
    }
    for (const role of ['transport_manager', 'operational_manager', 'manager']) {
      const roleExists = targetDb.prepare('SELECT 1 FROM roles WHERE name = ?').get(role);
      if (roleExists) {
        capChanges += capStmt.run(role, 'jobrequests.edit').changes;
      }
    }

    targetDb
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migration_058_done', '1')")
      .run();

    return { moduleUpdates, capChanges };
  })();

  if (result.moduleUpdates > 0 || result.capChanges > 0) {
    console.log(
      `=== Migration 058: Updated assistant_transport_manager permissions (modules: ${result.moduleUpdates}, caps: ${result.capChanges}) ===`
    );
  }
  return { applied: true, ...result };
}

module.exports = { runMigration };
