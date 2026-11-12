'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mrn-backfill-'));
const TEST_DB = path.join(TMP, 'test.db');
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';
delete process.env.MULTIDB;

const { migrate, run, get, all, db } = require('../src/db');
const storeLocations = require('../src/lib/store_locations');
migrate();

run("INSERT OR IGNORE INTO workshops (id, code, name, active) VALUES (1, 'CW', 'Central Workshop', 1)");
storeLocations.seedStoreLocations(db);

test('Historical MRNs and MRN lines without target_store_location_id are stamped with workshop store (id=2)', () => {
  // Create an un-stamped MRN and line
  const mrnId = run("INSERT INTO mrn (mrn_no, workshop_id, req_date, status) VALUES ('MRN-LEGACY-001', 1, '2026-11-01', 'open')").lastInsertRowid;
  const lineId = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Bearing 6204', 2, 'nos')", mrnId).lastInsertRowid;

  // Run backfill
  storeLocations.migrateStoreLocationsStage2(db);

  const mrnRow = get('SELECT target_store_location_id FROM mrn WHERE id = ?', mrnId);
  const lineRow = get('SELECT target_store_location_id FROM mrn_lines WHERE id = ?', lineId);

  assert.strictEqual(mrnRow.target_store_location_id, 2, 'MRN target_store_location_id must be stamped as 2');
  assert.strictEqual(lineRow.target_store_location_id, 2, 'MRN line target_store_location_id must be stamped as 2');

  // Verify trigger on new insertion
  const mrn2Id = run("INSERT INTO mrn (mrn_no, workshop_id, req_date, status) VALUES ('MRN-TRIGGER-001', 1, '2026-11-05', 'open')").lastInsertRowid;
  const line2Id = run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (?, 'Filter Oil', 1, 'nos')", mrn2Id).lastInsertRowid;

  const mrn2Row = get('SELECT target_store_location_id FROM mrn WHERE id = ?', mrn2Id);
  const line2Row = get('SELECT target_store_location_id FROM mrn_lines WHERE id = ?', line2Id);

  assert.strictEqual(mrn2Row.target_store_location_id, 2, 'Trigger must stamp MRN target_store_location_id as 2');
  assert.strictEqual(line2Row.target_store_location_id, 2, 'Trigger must stamp MRN line target_store_location_id as 2');
});
