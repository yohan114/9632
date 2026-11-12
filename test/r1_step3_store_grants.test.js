'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-grant-test-'));
process.env.DB_PATH = path.join(TMP, 'grant.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, db } = require('../src/db');
const migration049 = require('../src/migrate/049_store_location_project_links');

test('migration 049 seeds only can_view and can_request, and never defaults unmapped user to main store', () => {
  migrate();

  // Create an unmapped user (no workshop_id)
  const unmappedId = db.prepare(`
    INSERT INTO users (username, password_hash, active, workshop_id)
    VALUES ('unmapped_clerk', 'hash', 1, NULL)
  `).run().lastInsertRowid;
  // Clear any default trigger assignment so the user is genuinely unmapped
  db.prepare('UPDATE users SET workshop_id = NULL WHERE id = ?').run(unmappedId);

  // Create a mapped user
  const mappedId = db.prepare(`
    INSERT INTO users (username, password_hash, active, workshop_id)
    VALUES ('site_worker', 'hash', 1, 1)
  `).run().lastInsertRowid;

  // Run migration 049
  migration049.migrateSingleDb(db, 'Test DB');

  // 1. Unmapped user must have NO access grants
  const unmappedGrants = db.prepare('SELECT * FROM store_location_access WHERE user_id = ?').all(unmappedId);
  assert.strictEqual(unmappedGrants.length, 0, 'Unmapped user must receive no default store access');

  // 2. Mapped user must receive only can_view and can_request
  const mappedGrants = db.prepare('SELECT * FROM store_location_access WHERE user_id = ?').all(mappedId);
  assert.strictEqual(mappedGrants.length, 1, 'Mapped user should receive exactly one store grant');

  const g = mappedGrants[0];
  assert.strictEqual(g.can_view, 1, 'can_view must be 1');
  assert.strictEqual(g.can_request, 1, 'can_request must be 1');
  assert.strictEqual(g.can_issue, 0, 'can_issue must not be seeded (0)');
  assert.strictEqual(g.can_receive, 0, 'can_receive must not be seeded (0)');
  assert.strictEqual(g.can_dispatch, 0, 'can_dispatch must not be seeded (0)');
  assert.strictEqual(g.can_count, 0, 'can_count must not be seeded (0)');
});
