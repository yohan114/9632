'use strict';

// Regression coverage for assistant_transport_manager job request / job card / breakdown
// permissions and `to_open` queue visibility when `jobrequests` clearance is restricted.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-asst-perm-'));
process.env.DB_PATH = path.join(TMP, 'asst.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, run, get, rawDb } = require('../src/db');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const jobsFlow = require('../src/lib/jobs_flow');
const m057 = require('../src/migrate/057_assistant_transport_jobcard_permissions');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, `Built-in ${n}`);
}
capabilities.seedCapabilities();
perms.seedDefaults();

test.after(() => {
  try { rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('fresh DB preserves canonical assistant_transport_manager defaults (no extra jobs.create grant)', () => {
  const level = perms.levelForRoles(['assistant_transport_manager'], 'jobrequests');
  const caps = capabilities.capsForRoles(['assistant_transport_manager']);
  assert.strictEqual(level, 'edit');
  assert.ok(caps.includes('jobrequests.create'));
  assert.ok(caps.includes('jobs.breakdown'));
  assert.ok(!caps.includes('jobs.create'));
});

test('Migration 057 restores disabled jobrequests/breakdown without clobbering jobs grants or future revocations', () => {
  const db = rawDb;
  // Simulate an upgraded database where Access Control disabled jobrequests & breakdown
  // while leaving jobs='edit' and jobs.create=1 in place.
  perms.setPermission('assistant_transport_manager', 'jobrequests', 'none');
  capabilities.setCapability('assistant_transport_manager', 'jobrequests.create', false);
  capabilities.setCapability('assistant_transport_manager', 'jobs.breakdown', false);
  perms.setPermission('assistant_transport_manager', 'jobs', 'edit');
  capabilities.setCapability('assistant_transport_manager', 'jobs.create', true);
  run("DELETE FROM settings WHERE key = 'migration_057_done'");

  const res = m057.runMigration(db);
  assert.strictEqual(res.applied, true);
  assert.strictEqual(res.moduleUpdated, 1);
  assert.strictEqual(res.capChanges, 2);

  assert.strictEqual(perms.levelForRoles(['assistant_transport_manager'], 'jobrequests'), 'edit');
  assert.strictEqual(perms.levelForRoles(['assistant_transport_manager'], 'jobs'), 'edit');
  const capsAfter = capabilities.capsForRoles(['assistant_transport_manager']);
  assert.ok(capsAfter.includes('jobrequests.create'));
  assert.ok(capsAfter.includes('jobs.breakdown'));
  assert.ok(capsAfter.includes('jobs.create'), 'existing jobs.create grant is preserved');
  assert.strictEqual(get("SELECT value FROM settings WHERE key = 'migration_057_done'").value, '1');

  // Later admin revocation must persist across restarts / re-running migration.
  capabilities.setCapability('assistant_transport_manager', 'jobrequests.create', false);
  const again = m057.runMigration(db);
  assert.strictEqual(again.applied, false);
  assert.ok(!capabilities.capsForRoles(['assistant_transport_manager']).includes('jobrequests.create'));

  // Restore clean default for subsequent tests
  capabilities.setCapability('assistant_transport_manager', 'jobrequests.create', true);
});

test('jobs_flow exposes to_open approved requests to jobs.create holders even when jobrequests module is none', () => {
  const wid = get('SELECT id FROM workshops LIMIT 1').id;
  const assetId = run(
    "INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES ('ASST-1', 'ASST1', 'ASST-1', 'active', 1)"
  ).lastInsertRowid;
  const uid = run(
    "INSERT INTO users (username, password_hash, active, workshop_id) VALUES ('opener1', 'x', 1, ?)",
    wid
  ).lastInsertRowid;

  run(
    `INSERT INTO job_requests (jr_no, req_date, asset_id, type, description, approval_status, workshop_id)
     VALUES ('JR-ASST-1', '2026-11-10', ?, 'repair', 'Brake line replacement', 'approved', ?)`,
    assetId, wid
  );
  run(
    `INSERT INTO job_requests (jr_no, req_date, asset_id, type, description, approval_status, workshop_id)
     VALUES ('JR-ASST-2', '2026-11-10', ?, 'repair', 'Uncertified item', 'requested', ?)`,
    assetId, wid
  );

  run("INSERT INTO roles (name, label) VALUES ('card_opener_only', 'Card Opener Only')");
  perms.setPermission('card_opener_only', 'jobs', 'edit');
  perms.setPermission('card_opener_only', 'jobrequests', 'none');
  capabilities.setCapability('card_opener_only', 'jobs.create', true);

  const user = { id: uid, roles: ['card_opener_only'], workshop_id: wid };
  const toOpen = jobsFlow.requests(user, { step: 'to_open' });
  assert.strictEqual(toOpen.length, 1);
  assert.strictEqual(toOpen[0].no, 'JR-ASST-1');
  assert.strictEqual(toOpen[0].can.open_card, true);

  const toCertify = jobsFlow.requests(user, { step: 'to_certify' });
  assert.strictEqual(toCertify.length, 0, 'does not leak uncertified requests');

  const mon = jobsFlow.monitor(user);
  assert.strictEqual(mon.sees.jobrequests, false);
  assert.strictEqual(mon.requests.to_open, 1);
});
