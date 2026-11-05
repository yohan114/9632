'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-h7-refuse-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
const context = require('../src/lib/context');
migrate();
storeLocations.seedStoreLocations(db);

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('H7: unassigned user is refused with 403 and forced error does not give store 1', () => {
  // User with no store_location_access grant and no workshop
  const unassignedUser = { id: 999, username: 'unassigned_user', roles: ['clerk'] };

  // 1. Must throw an error with status 403
  assert.throws(
    () => {
      context.getUserAssignedStoreId(unassignedUser);
    },
    (err) => {
      assert.strictEqual(err.status, 403, 'Error must have status 403');
      assert.match(err.message, /no store assigned/i);
      return true;
    },
    'Unassigned user must be refused with 403'
  );

  // 2. Forced DB error in getUserStoreLocations must not fall back to store 1
  const origFn = storeLocations.getUserStoreLocations;
  storeLocations.getUserStoreLocations = () => { throw new Error('Simulated DB failure'); };

  try {
    assert.throws(
      () => {
        context.getUserAssignedStoreId(unassignedUser);
      },
      (err) => {
        assert.notStrictEqual(err, null);
        return true;
      },
      'Forced DB error must throw, not return store 1'
    );
  } finally {
    storeLocations.getUserStoreLocations = origFn;
  }
});
