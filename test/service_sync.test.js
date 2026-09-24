'use strict';

// Merging a REFRESHED service-record export into a live system: take the new services
// and genuine corrections, without duplicating, blanking or overwriting local work.
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB = path.join(os.tmpdir(), 'workshopone-svcsync-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');

migrate();

const SOURCE = path.join(os.tmpdir(), 'workshopone-svcsync-source.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(SOURCE + s); } catch {} }
const sdb = new Database(SOURCE);
sdb.exec(`
  CREATE TABLE Vehicles (VehicleID INTEGER PRIMARY KEY, ECNumber TEXT, RegistrationNo TEXT);
  CREATE TABLE ServiceJobs (ServiceID INTEGER PRIMARY KEY, VehicleID INTEGER, VehicleLabel TEXT, ServiceDate TEXT,
    JobNo TEXT, MeterReading TEXT, NextServiceMeter TEXT, ServiceType TEXT, SiteLocation TEXT, UpkeepingStatus TEXT,
    RepairDetails TEXT, PartsSubtotal REAL DEFAULT 0, LabourRate REAL DEFAULT 0, LabourCharge REAL DEFAULT 0,
    SundryRate REAL DEFAULT 0, SundryAmount REAL DEFAULT 0, GrandTotal REAL DEFAULT 0);
  CREATE TABLE ServiceFilters (ServiceFilterID INTEGER PRIMARY KEY AUTOINCREMENT, ServiceID INTEGER,
    FilterCategory TEXT, FilterNo TEXT, ActionType TEXT, Price REAL DEFAULT 0, Quantity INTEGER DEFAULT 1);
  CREATE TABLE ServiceOils (ServiceOilID INTEGER PRIMARY KEY AUTOINCREMENT, ServiceID INTEGER,
    OilName TEXT, OilType TEXT, ActionType TEXT, Quantity REAL DEFAULT 0, Price REAL DEFAULT 0);
  CREATE TABLE FilterPrices (SupplierFilterCode TEXT, UnitPriceLKR REAL);

  INSERT INTO Vehicles VALUES (1, 'DC-10', '28-4314'), (2, 'ZZ-99', 'XX-0001');
  -- 100: already imported, corrected at source. 101: already imported, unchanged.
  -- 102: brand new, on a vehicle the fleet has never seen.
  INSERT INTO ServiceJobs (ServiceID, VehicleID, VehicleLabel, ServiceDate, JobNo, UpkeepingStatus,
                           PartsSubtotal, LabourRate, LabourCharge, SundryRate, SundryAmount, GrandTotal)
    VALUES (100, 1, 'DC-10 pickup', '2026-06-08', '2026/6/S/100', 'Good', 13499.15, 15, 2024.87, 5, 674.96, 16198.98),
           (101, 1, 'DC-10 pickup', '2026-06-09', '2026/6/S/101', '',      1000,     0,  200,     0, 50,     1250),
           (102, 2, 'NEW MACHINE',  '2026-07-04', '2026/7/S/151', 'Fair',  5000,    15,  750,     5, 250,    6000);
  INSERT INTO ServiceFilters (ServiceID, FilterCategory, FilterNo, ActionType, Price, Quantity)
    VALUES (100, 'Engine Oil Filter', 'C206', 'x', 1949.15, 1),
           (100, 'Air Filter',        '',     'e', 0,       1),
           (102, 'Engine Oil Filter', 'NEW-777', 'x', 3200, 1);
  INSERT INTO ServiceOils (ServiceID, OilName, OilType, ActionType, Quantity, Price)
    VALUES (100, 'Engine Oil', '15W40', 'x', 10, 4500),
           (102, 'Engine Oil', '15W40', 'x',  5, 2250);
  INSERT INTO FilterPrices VALUES ('NEW-777', 3999);`);
sdb.close();

// The fleet vehicle the first two services belong to.
run("INSERT INTO assets (code, code_norm, registration, ec_code, in_register) VALUES ('DC-10', 'DC10', '28-4314', 'DC-10', 1)");
// State left by the ORIGINAL import: service 100 with stale totals, 101 complete.
const s100 = run(`INSERT INTO service_jobs (legacy_service_id, vehicle_label, service_date, job_no, parts_subtotal,
   labour_charge, sundry_amount, grand_total, labour_rate, sundry_rate)
   VALUES (100, 'DC-10 pickup', '2026-06-08', '2026/6/S/100', 4649.15, 929.83, 232.46, 5811.44, 20, 5)`).lastInsertRowid;
run(`INSERT INTO service_jobs (legacy_service_id, vehicle_label, service_date, job_no, parts_subtotal,
   labour_charge, sundry_amount, grand_total, labour_rate, sundry_rate)
   VALUES (101, 'DC-10 pickup', '2026-06-09', '2026/6/S/101', 1000, 200, 50, 1250, 20, 5)`);
run("INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price) VALUES (?, 'C206', 'C206', 'Engine Oil Filter', 'x', 1, 1949.15)", s100);
// A locally-added service and a locally-set price the sync must not disturb.
run("INSERT INTO service_jobs (vehicle_label, service_date, job_no, grand_total) VALUES ('LOCAL ONLY', '2026-07-10', 'LOCAL/1', 999)");
run("INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price, source) VALUES ('C206', 'C206', 2500, 'manual')");

const step = require('../src/migrate/29_service_sync');
const sync = (apply) => step.runStep({ apply, source: SOURCE });

test('a dry run plans the work and changes nothing', () => {
  const before = get('SELECT COUNT(*) c FROM service_jobs').c;
  const rep = sync(false);
  assert.strictEqual(rep.new_services.length, 1);
  assert.strictEqual(rep.new_services[0].legacy_id, 102);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_jobs').c, before);
});

test('an empty or zero source value never blanks what we already hold', () => {
  const rep = sync(false);
  const u101 = rep.header_updates.find((u) => u.legacy_id === 101);
  assert.strictEqual(u101, undefined, 'service 101 has blank upkeeping and 0 rates — nothing to take');
  assert.strictEqual(get('SELECT labour_rate FROM service_jobs WHERE legacy_service_id = 101').labour_rate, 20);
});

test('applying brings in the new service, its lines and its vehicle', () => {
  const rep = sync(true);
  const s = get('SELECT * FROM service_jobs WHERE legacy_service_id = 102');
  assert.ok(s, 'the new service is inserted');
  assert.strictEqual(s.job_no, '2026/7/S/151');
  assert.strictEqual(s.upkeeping, 'Fair');
  assert.strictEqual(s.labour_rate, 15);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_filters WHERE service_id = ?', s.id).c, 1);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_oils WHERE service_id = ?', s.id).c, 1);
  // Its vehicle was unknown to the fleet, so it was minted for review.
  const a = get('SELECT * FROM assets WHERE id = ?', s.asset_id);
  assert.ok(a, 'the service is linked to a vehicle');
  assert.strictEqual(a.in_register, 0);
  assert.ok(rep.assets_created.length >= 1);
});

test('a corrected service is updated in place, not duplicated', () => {
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_jobs WHERE legacy_service_id = 100').c, 1);
  const s = get('SELECT * FROM service_jobs WHERE legacy_service_id = 100');
  assert.strictEqual(s.grand_total, 16198.98, 'the corrected total is taken');
  assert.strictEqual(s.parts_subtotal, 13499.15);
  assert.strictEqual(s.labour_rate, 15, 'a real rate replaces the column default');
  assert.strictEqual(s.upkeeping, 'Good');
});

test('missing lines on an existing service are topped up', () => {
  const s = get('SELECT id FROM service_jobs WHERE legacy_service_id = 100');
  const f = all('SELECT filter_no, category FROM service_filters WHERE service_id = ? ORDER BY id', s.id);
  assert.strictEqual(f.length, 2, 'the blank-number air-filter line is added');
  assert.strictEqual(f[1].filter_no, null);
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_oils WHERE service_id = ?', s.id).c, 1);
});

test('a price a storekeeper set is never overwritten', () => {
  assert.strictEqual(get("SELECT unit_price FROM filter_prices WHERE filter_no_norm = 'C206'").unit_price, 2500);
  // A filter number new to the book arrives priced from the service line.
  const nw = get("SELECT unit_price, source FROM filter_prices WHERE filter_no_norm = 'NEW777'");
  assert.strictEqual(nw.unit_price, 3200, 'the price actually paid beats the supplier catalogue');
});

test('a locally-created service is left completely alone', () => {
  const local = get("SELECT * FROM service_jobs WHERE job_no = 'LOCAL/1'");
  assert.ok(local);
  assert.strictEqual(local.legacy_service_id, null);
  assert.strictEqual(local.grand_total, 999);
});

test('re-running changes nothing', () => {
  const counts = () => [get('SELECT COUNT(*) c FROM service_jobs').c, get('SELECT COUNT(*) c FROM service_filters').c, get('SELECT COUNT(*) c FROM service_oils').c];
  const before = counts();
  const rep = sync(true);
  assert.strictEqual(rep.new_services.length, 0);
  assert.strictEqual(rep.header_updates.length, 0);
  assert.deepStrictEqual(counts(), before);
});

test('a line we hold but the source does not is reported, never deleted', () => {
  const s = get('SELECT id FROM service_jobs WHERE legacy_service_id = 101');
  run("INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price) VALUES (?, 'Extra Oil', 'X', 'x', 1, 100)", s.id);
  const rep = sync(true);
  assert.ok(rep.extra_lines_here.some((x) => x.legacy_id === 101 && x.kind === 'oil'));
  assert.strictEqual(get('SELECT COUNT(*) c FROM service_oils WHERE service_id = ?', s.id).c, 1, 'still there');
});

test.after(() => { for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(SOURCE + s); } catch {} } });
