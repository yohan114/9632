'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-guard-test-'));
process.env.DB_PATH = path.join(TMP, 'guard.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, db } = require('../src/db');
const auth = require('../src/lib/auth');

test('migrations 045, 047, and 049 are guarded by settings keys and do not restore revoked grants on second migrate()', () => {
  // First boot / migration
  migrate();

  // 1. Verify settings keys are recorded
  const m45 = db.prepare("SELECT value FROM settings WHERE key = 'migration_045_done'").get();
  const m47 = db.prepare("SELECT value FROM settings WHERE key = 'migration_047_done'").get();
  const m49 = db.prepare("SELECT value FROM settings WHERE key = 'migration_049_done'").get();

  assert.ok(m45, 'migration_045_done setting must be recorded');
  assert.ok(m47, 'migration_047_done setting must be recorded');
  assert.ok(m49, 'migration_049_done setting must be recorded');

  // 2. Insert a user and give them a grant, then simulate admin revoking it
  const userId = db.prepare("INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('clerk', 'hash', 1, 1)").run().lastInsertRowid;
  const store = db.prepare("SELECT id FROM store_locations LIMIT 1").get();
  assert.ok(store, 'A store location should exist');

  db.prepare(`
    INSERT INTO store_location_access (user_id, store_location_id, can_view, can_request)
    VALUES (?, ?, 1, 1)
  `).run(userId, store.id);

  // Admin revokes the grant
  db.prepare('DELETE FROM store_location_access WHERE user_id = ? AND store_location_id = ?').run(userId, store.id);
  const checkRevoked = db.prepare('SELECT 1 FROM store_location_access WHERE user_id = ? AND store_location_id = ?').get(userId, store.id);
  assert.strictEqual(checkRevoked, undefined, 'Grant should be deleted');

  // Record row counts across key tables before second restart
  const countBefore = {
    settings: db.prepare('SELECT COUNT(*) c FROM settings').get().c,
    store_locations: db.prepare('SELECT COUNT(*) c FROM store_locations').get().c,
    store_location_access: db.prepare('SELECT COUNT(*) c FROM store_location_access').get().c
  };

  // 3. Second boot / migration (restart)
  migrate();

  // 4. Verify revoked grant was NOT restored by guarded migration
  const checkAfterRestart = db.prepare('SELECT 1 FROM store_location_access WHERE user_id = ? AND store_location_id = ?').get(userId, store.id);
  assert.strictEqual(checkAfterRestart, undefined, 'Revoked grant must not be restored on restart');

  // 5. Verify row counts remain identical after restart
  const countAfter = {
    settings: db.prepare('SELECT COUNT(*) c FROM settings').get().c,
    store_locations: db.prepare('SELECT COUNT(*) c FROM store_locations').get().c,
    store_location_access: db.prepare('SELECT COUNT(*) c FROM store_location_access').get().c
  };
  assert.deepStrictEqual(countAfter, countBefore, 'Row counts must be identical across restarts');
});
