'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3-multiple-ciphers');

const { splitDatabase, CORE_TABLES, WS_TABLES } = require('../scripts/split_database');

test('Multi-database architecture suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multidb-suite-'));
  const originalDb = path.join(__dirname, '../data/workshopone.db');

  await t.test('Phase 2 split: creates core.db and workshops/CW.db with 100% row match', () => {
    splitDatabase(originalDb, tmpDir);

    const corePath = path.join(tmpDir, 'core.db');
    const cwPath = path.join(tmpDir, 'workshops/CW.db');

    assert.ok(fs.existsSync(corePath), 'core.db exists');
    assert.ok(fs.existsSync(cwPath), 'CW.db exists');

    const coreDb = new Database(corePath, { readonly: true });
    const cwDb = new Database(cwPath, { readonly: true });

    // Verify all core tables exist in core.db
    for (const name of CORE_TABLES) {
      const exists = coreDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
      assert.ok(exists, `Core table ${name} exists in core.db`);
    }

    // Verify architectural tables exist in core.db
    const archTables = ['workshop_databases', 'workshop_keys', 'store_access_grants', 'store_access_usage', 'vehicle_holds', 'transfers', 'integrity_runs'];
    for (const name of archTables) {
      const exists = coreDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
      assert.ok(exists, `Architectural table ${name} exists in core.db`);
    }

    // Verify workshop tables exist in CW.db
    for (const name of WS_TABLES) {
      const exists = cwDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
      assert.ok(exists, `Workshop table ${name} exists in CW.db`);
    }

    // Verify ws_meta
    const meta = cwDb.prepare('SELECT * FROM ws_meta').get();
    assert.strictEqual(meta.code, 'CW');
    assert.strictEqual(meta.workshop_id, 1);

    coreDb.close();
    cwDb.close();

    const multidb = require('../src/db/multidb');
    multidb.init(null, tmpDir);
  });

  await t.test('Phase 3: Automatic sub-workshop provisioning creates isolated db', () => {
    const multidb = require('../src/db/multidb');
    const mockActor = { id: 1, username: 'admin' };

    const newWs = multidb.createWorkshopDatabase(mockActor, {
      code: 'TEST1',
      name: 'Test Workshop 1',
      place: 'Trincomalee',
      own_store: true,
      grant_main_store: true
    });

    assert.ok(newWs);
    assert.strictEqual(newWs.code, 'TEST1');

    const testDbPath = path.join(tmpDir, 'workshops/TEST1.db');
    assert.ok(fs.existsSync(testDbPath), 'TEST1.db exists on disk');

    const testDb = new Database(testDbPath, { readonly: true });
    const meta = testDb.prepare('SELECT * FROM ws_meta').get();
    assert.strictEqual(meta.code, 'TEST1');
    assert.strictEqual(meta.workshop_id, newWs.id);

    // Verify table in new workshop db is empty
    const jobs = testDb.prepare('SELECT COUNT(*) c FROM job_cards').get().c;
    assert.strictEqual(jobs, 0, 'New workshop starts fresh with 0 job cards');

    testDb.close();
  });

  await t.test('Phase 4: Vehicle Holds prevent cross-workshop double booking', () => {
    const multidb = require('../src/db/multidb');
    const assetId = 99999;

    // Workshop 1 claims vehicle hold
    multidb.claimVehicleHold(assetId, 1, 101, '2026/10/R/101');
    const hold = multidb.getVehicleHold(assetId);
    assert.ok(hold);
    assert.strictEqual(hold.workshop_id, 1);
    assert.strictEqual(hold.job_no, '2026/10/R/101');

    // Workshop 2 tries to claim same vehicle hold -> must be rejected with 409
    assert.throws(() => {
      multidb.claimVehicleHold(assetId, 2, 202, 'MTR/2026/10/R/202');
    }, (err) => {
      return err.status === 409 && err.message.includes('already has open job card');
    });

    // Releasing hold frees the vehicle
    multidb.releaseVehicleHold(assetId);
    assert.strictEqual(multidb.getVehicleHold(assetId), undefined);
  });

  await t.test('Phase 5: Main store grants with two-person rule enforcement', () => {
    const multidb = require('../src/db/multidb');
    const admin1 = { id: 1, username: 'admin1' };
    const admin2 = { id: 2, username: 'admin2' };

    // Admin 1 creates grant
    const grant = multidb.createStoreGrant(admin1, {
      workshop_id: 2,
      store_id: 1,
      can_view: true,
      can_request: true,
      can_draw: true,
      covering: 'all',
      line_limit: 50000,
      monthly_limit: 500000
    });

    assert.ok(grant);
    assert.strictEqual(grant.state, 'pending');

    // Admin 1 attempts to approve own grant -> violates two-person rule (403)
    assert.throws(() => {
      multidb.approveStoreGrant(admin1, grant.id);
    }, (err) => {
      return err.status === 403 && err.message.includes('Two-person rule');
    });

    // Admin 2 approves grant -> becomes active
    const approved = multidb.approveStoreGrant(admin2, grant.id);
    assert.strictEqual(approved.state, 'active');
    assert.strictEqual(approved.approved_by, admin2.id);

    // Check store access for workshop 2
    const access = multidb.checkStoreAccess(2, 1, 'draw');
    assert.strictEqual(access.allowed, true);

    // Suspend grant
    multidb.updateStoreGrantState(admin2, grant.id, 'suspended', 'Audit review');
    const denied = multidb.checkStoreAccess(2, 1, 'draw');
    assert.strictEqual(denied.allowed, false);
  });

  await t.test('Phase 8: Nightly verifier runs PRAGMA integrity_check across all databases', () => {
    const multidb = require('../src/db/multidb');
    const report = multidb.runIntegrityVerification();
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.core.integrity, 'ok');
    assert.strictEqual(report.workshops.CW.integrity, 'ok');
  });

  // Cleanup tmpDir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});
