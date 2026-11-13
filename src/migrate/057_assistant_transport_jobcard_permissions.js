'use strict';

/**
 * Migration 057: Restore Assistant Transport Manager Job Request & Breakdown Permissions
 *
 * On upgraded core DBs where Access Control edits disabled `jobrequests` ('none'),
 * `jobrequests.create` (0), and `jobs.breakdown` (0) for `assistant_transport_manager`,
 * this one-time migration restores:
 *   1. module `jobrequests` -> 'edit' (when currently missing, 'none', or 'view')
 *   2. capability `jobrequests.create` -> 1 (repair/service job request creation)
 *   3. capability `jobs.breakdown` -> 1 (field breakdown reporting)
 *
 * Existing grants already held on upgraded DBs (such as `jobs`, `jobs.create`, `jobs.edit`)
 * are left untouched, and on fresh unseeded test databases before role seeding runs this
 * exits early without altering canonical role defaults.
 *
 * Guarded by setting key 'migration_057_done' so any later Access Control change by an
 * administrator is preserved across restarts.
 */

function runMigration(targetDb) {
  if (!targetDb) return { applied: false };

  const hasTable = (name) => !!targetDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);

  if (!hasTable('role_permissions') || !hasTable('role_capabilities') || !hasTable('settings')) {
    return { applied: false };
  }

  if (targetDb.prepare("SELECT 1 FROM settings WHERE key = 'migration_057_done'").get()) {
    return { applied: false };
  }

  const seeded = targetDb
    .prepare("SELECT COUNT(*) AS c FROM role_permissions WHERE role = 'assistant_transport_manager'")
    .get();
  if (!seeded || seeded.c === 0) {
    // Wait until role_permissions are seeded before running and marking done.
    return { applied: false };
  }

  const ROLE = 'assistant_transport_manager';
  const applyTx = targetDb.transaction(() => {
    const existingMod = targetDb
      .prepare('SELECT level FROM role_permissions WHERE role = ? AND module = ?')
      .get(ROLE, 'jobrequests');

    let moduleUpdated = 0;
    if (!existingMod) {
      moduleUpdated = targetDb
        .prepare("INSERT OR IGNORE INTO role_permissions (role, module, level) VALUES (?, 'jobrequests', 'edit')")
        .run(ROLE).changes;
    } else if (existingMod.level === 'none' || existingMod.level === 'view') {
      moduleUpdated = targetDb
        .prepare("UPDATE role_permissions SET level = 'edit' WHERE role = ? AND module = 'jobrequests' AND level IN ('none', 'view')")
        .run(ROLE).changes;
    }

    const capStmt = targetDb.prepare(`
      INSERT INTO role_capabilities (role, capability, granted, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(role, capability) DO UPDATE
      SET granted = 1, updated_at = datetime('now')
      WHERE granted = 0
    `);

    const capChanges = capStmt.run(ROLE, 'jobrequests.create').changes
      + capStmt.run(ROLE, 'jobs.breakdown').changes;

    targetDb
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('migration_057_done', '1')")
      .run();

    return { moduleUpdated, capChanges };
  });

  const result = applyTx();
  if (result.moduleUpdated > 0 || result.capChanges > 0) {
    console.log(
      `=== Migration 057: Restored assistant_transport_manager permissions (module edits: ${result.moduleUpdated}, capability grants: ${result.capChanges}) ===`
    );
  }
  return { applied: true, ...result };
}

module.exports = { runMigration };
