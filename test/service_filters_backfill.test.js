'use strict';

// The service import dropped filter lines with a BLANK filter number — which is how a
// CLEANED filter is logged ("Air Filter Inner, action E, no part number"). This restores
// them without disturbing any cost, and is safe to run repeatedly.
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-svcfilters-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');

migrate();

// A stand-in for sources/service/service.db, written where the step looks for it.
const SOURCE = path.join(__dirname, '..', 'sources', 'service', 'service.db');
const REAL_SOURCE_EXISTS = fs.existsSync(SOURCE);
const FIXTURE = path.join(os.tmpdir(), 'workshopone-svcfilters-source.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(FIXTURE + s); } catch {} }

const sdb = new Database(FIXTURE);
sdb.exec(`
  CREATE TABLE ServiceJobs (ServiceID INTEGER PRIMARY KEY, ServiceDate TEXT, JobNo TEXT);
  CREATE TABLE ServiceFilters (
    ServiceFilterID INTEGER PRIMARY KEY AUTOINCREMENT, ServiceID INTEGER,
    FilterCategory TEXT, FilterNo TEXT, ActionType TEXT, Price REAL DEFAULT 0, Quantity INTEGER DEFAULT 1);
  INSERT INTO ServiceJobs VALUES (900, '2026-06-08', '2026/06/S/900');
  -- two numbered lines (already imported) and two blank-number lines (dropped)
  INSERT INTO ServiceFilters (ServiceID, FilterCategory, FilterNo, ActionType, Price, Quantity)
    VALUES (900, 'Engine Oil Filter', 'C206 (VIC Japan)', 'x', 1949.15, 1),
           (900, 'Air Filter',        '',                 'e', 0,       1),
           (900, 'Air Filter Inner',  NULL,               'E', 0,       1),
           (900, 'Fuel Sedimentary',  '6667352',          'x', 3000,    1);`);
sdb.close();

const svc = run("INSERT INTO service_jobs (legacy_service_id, vehicle_label, service_date, job_no, labour_charge, sundry_amount) VALUES (900, 'DC-10', '2026-06-08', '2026/06/S/900', 500, 100)").lastInsertRowid;
// Only the numbered lines made it in, exactly as the original import left things.
run("INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price) VALUES (?, 'C206 (VIC Japan)', 'C206', 'Engine Oil Filter', 'x', 1, 1949.15)", svc);
run("INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price) VALUES (?, '6667352', '6667352', 'Fuel Sedimentary', 'x', 1, 3000)", svc);
run("INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price) VALUES ('C206 (VIC Japan)', 'C206', 1949.15)");
run("INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price) VALUES ('6667352', '6667352', 3000)");

const step = require('../src/migrate/28_service_filters_backfill');
// Point the step at the fixture rather than the real export.
const realRunStep = step.runStep;
function runStep(opts) {
  const orig = fs.existsSync(SOURCE) ? fs.readFileSync(SOURCE) : null;
  fs.mkdirSync(path.dirname(SOURCE), { recursive: true });
  fs.copyFileSync(FIXTURE, SOURCE);
  try { return realRunStep(opts); }
  finally {
    if (orig) fs.writeFileSync(SOURCE, orig);
    else fs.unlinkSync(SOURCE);
  }
}

const cost = () => get(
  `SELECT (SELECT COALESCE(SUM(COALESCE(p.unit_price,0) * COALESCE(f.qty,1)),0)
             FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
            WHERE f.service_id = ?) + COALESCE(s.labour_charge,0) + COALESCE(s.sundry_amount,0) AS c
     FROM service_jobs s WHERE s.id = ?`, svc, svc).c;

test('a dry run reports the dropped lines and changes nothing', () => {
  const before = get('SELECT COUNT(*) c FROM service_filters').c;
  const rep = runStep({ apply: false });
  assert.strictEqual(rep.lines.length, 2, 'the two blank-number lines are missing');
  assert.strictEqual(rep.services_short, 1);
  assert.strictEqual(rep.inserted, 0);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_filters').c, before);
});

test('applying restores them with no filter number', () => {
  const costBefore = cost();
  const rep = runStep({ apply: true });
  assert.strictEqual(rep.inserted, 2);
  const rows = all('SELECT category, action_type, filter_no, filter_no_norm, price FROM service_filters WHERE service_id = ? ORDER BY id', svc);
  assert.strictEqual(rows.length, 4);
  const air = rows.filter((r) => String(r.category).startsWith('Air'));
  assert.strictEqual(air.length, 2);
  for (const r of air) {
    assert.strictEqual(r.filter_no, null, 'a blank number is stored as NULL, not an empty string');
    assert.strictEqual(r.filter_no_norm, null);
    assert.strictEqual(r.price, 0);
  }
  assert.strictEqual(cost(), costBefore, 'the service cost is completely unchanged');
});

test('re-running inserts nothing', () => {
  const rep = runStep({ apply: true });
  assert.strictEqual(rep.inserted, 0);
  assert.strictEqual(rep.lines.length, 0);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_filters WHERE service_id = ?', svc).c, 4);
});

test('an unnumbered line never counts as "needs a price"', () => {
  const missing = get(
    `SELECT COUNT(*) c FROM service_filters f LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
      WHERE f.service_id = ? AND COALESCE(p.unit_price, 0) = 0
        AND f.filter_no IS NOT NULL AND TRIM(f.filter_no) <> ''`, svc).c;
  assert.strictEqual(missing, 0, 'both numbered lines are priced; the blank ones are not pricing work');
});

test('a line legitimately recorded twice is not collapsed', () => {
  run("INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price) VALUES (?, 'C206 (VIC Japan)', 'C206', 'Engine Oil Filter', 'x', 1, 1949.15)", svc);
  const rep = runStep({ apply: true });
  assert.strictEqual(rep.inserted, 0, 'an extra live line is never "missing"');
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_filters WHERE service_id = ?', svc).c, 5);
});

test.after(() => {
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(FIXTURE + s); } catch {} }
  void REAL_SOURCE_EXISTS;
});
