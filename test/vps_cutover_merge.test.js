'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeVpsLiveData,
  getVpsCutoverParityReport,
  normDateTime,
} = require('../scripts/vps_cutover_merge');

const ROOT_DIR = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-vps-merge-test-'));

function initMigratedDb(dbPath) {
  execFileSync(
    process.execPath,
    ['-e', "const d = require('./src/db'); d.migrate(); try { d.db.close(); } catch {} process.exit(0);"],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, DB_PATH: dbPath, MULTIDB: '0', BACKUP_INTERVAL_MINUTES: '0' },
      stdio: 'pipe',
    }
  );
}

function createPrismaFuelSchema(db) {
  db.exec(`
    CREATE TABLE "Project" (id TEXT PRIMARY KEY, name TEXT, code TEXT, createdAt DATETIME, updatedAt DATETIME, contactEmail TEXT, contactName TEXT);
    CREATE TABLE "User" (id TEXT PRIMARY KEY, username TEXT, email TEXT, name TEXT, passwordHash TEXT, role TEXT, active BOOLEAN, createdAt DATETIME, updatedAt DATETIME, createdById TEXT, projectId TEXT, bulkTankId TEXT);
    CREATE TABLE "Asset" (id TEXT PRIMARY KEY, code TEXT, brand TEXT, typeLabel TEXT, model TEXT, regNo TEXT, capacity TEXT, yom INTEGER, chassisNo TEXT, engineNo TEXT, serialNo TEXT, site TEXT, status TEXT, meterType TEXT, dailyCapLitres INTEGER, ownership TEXT, createdAt DATETIME, updatedAt DATETIME, categoryId TEXT, projectId TEXT);
    CREATE TABLE "BulkTank" (id TEXT PRIMARY KEY, name TEXT, fuelKind TEXT, capacity REAL, balance REAL, createdAt DATETIME, updatedAt DATETIME, projectId TEXT);
    CREATE TABLE "FuelPrice" (id TEXT PRIMARY KEY, fuelKind TEXT, pricePerLitre INTEGER, effectiveFrom DATETIME, source TEXT, note TEXT, createdAt DATETIME, enteredById TEXT);
    CREATE TABLE "FuelRequest" (id TEXT PRIMARY KEY, fuelKind TEXT, requestedLitres REAL, meterReading REAL, readingType TEXT, reason TEXT, status TEXT, createdAt DATETIME, updatedAt DATETIME, assetId TEXT, requestedById TEXT, reviewedById TEXT, reviewedAt DATETIME, reviewNote TEXT, requestNo TEXT, runningChartNo TEXT, driverName TEXT, tripPurpose TEXT, prevMeterReading REAL, approxKm REAL, consumptionNorm REAL, recommendedLitres REAL, tripTotalFuel REAL, isFullTank BOOLEAN, needsApproval BOOLEAN, sourceMode TEXT, stationName TEXT, targetTankId TEXT, projectId TEXT, actualIssuedLitres REAL, fulfilledById TEXT, fulfilledAt DATETIME);
    CREATE TABLE "FuelIssue" (id TEXT PRIMARY KEY, fuelKind TEXT, litres REAL, meterReading REAL, readingType TEXT, pricePerLitre INTEGER, totalCost INTEGER, source TEXT, issueDate DATETIME, createdAt DATETIME, assetId TEXT, issuedById TEXT, fuelPriceId TEXT, linkedRequestId TEXT, meterReadingRecordId TEXT, bulkTankId TEXT, voided BOOLEAN, voidedAt DATETIME, issuePerson TEXT, importKey TEXT, runningChartNo TEXT, tripPurpose TEXT, approxKmSnapshot REAL, recommendedLitresSnapshot REAL, tripFuelSnapshot REAL, isFullTank BOOLEAN, varianceLitres REAL, variancePct REAL, crossCheckStatus TEXT);
    CREATE TABLE "BulkRequest" (id TEXT PRIMARY KEY, fuelKind TEXT, requestedLitres REAL, status TEXT, createdAt DATETIME, updatedAt DATETIME, bulkTankId TEXT, sourceType TEXT, sourceTankId TEXT, requestedById TEXT, reviewedById TEXT, reviewedAt DATETIME, reviewNote TEXT);
    CREATE TABLE "TankDip" (id TEXT PRIMARY KEY, bulkTankId TEXT, dipLitres REAL, computedBalance REAL, variance REAL, dipDate DATETIME, note TEXT, createdAt DATETIME, recordedById TEXT);
    CREATE TABLE "FuelIssueCorrection" (id TEXT PRIMARY KEY, fuelIssueId TEXT, type TEXT, status TEXT, reason TEXT, newLitres REAL, newMeterReading REAL, newReadingType TEXT, newFuelKind TEXT, newIssueDate DATETIME, origLitres REAL, origMeterReading REAL, origFuelKind TEXT, origIssueDate DATETIME, origSource TEXT, assetId TEXT, assetCode TEXT, projectId TEXT, projectName TEXT, projectCode TEXT, docName TEXT, docMime TEXT, requestedById TEXT, reviewedById TEXT, reviewedAt DATETIME, reviewNote TEXT, createdAt DATETIME, updatedAt DATETIME);
    CREATE TABLE "MeterReading" (id TEXT PRIMARY KEY, value REAL, readingType TEXT, readingDate DATETIME, source TEXT, createdAt DATETIME, assetId TEXT, recordedById TEXT, linkedIssueId TEXT);
    CREATE TABLE "DailyCondition" (id TEXT PRIMARY KEY, status TEXT, logDate DATETIME, note TEXT, createdAt DATETIME, assetId TEXT, recordedById TEXT);
    CREATE TABLE "AssetAssignment" (id TEXT PRIMARY KEY, assetId TEXT, projectId TEXT, startDate DATETIME, endDate DATETIME, note TEXT, driverName TEXT, billingType TEXT, createdAt DATETIME, updatedAt DATETIME, createdById TEXT, origin TEXT);
    CREATE TABLE "RentalRate" (id TEXT PRIMARY KEY, assetId TEXT, sourceLabel TEXT, category TEXT, equipType TEXT, fuelQtyDefault REAL, opRate INTEGER, hrFwCents INTEGER, hrWCents INTEGER, hrDCents INTEGER, dyFwCents INTEGER, dyWCents INTEGER, dyDCents INTEGER, kmFwCents INTEGER, kmWCents INTEGER, kmDCents INTEGER, portDwCents INTEGER, portDdCents INTEGER, defaultBasis TEXT, fuelConsEcon REAL, fuelConsTyp REAL, fuelConsHeavy REAL, fuelConsBasis TEXT, createdAt DATETIME, updatedAt DATETIME);
    CREATE TABLE "VehicleAllocation" (id TEXT PRIMARY KEY, dedupeKey TEXT, projectId TEXT, siteName TEXT, month TEXT, assetId TEXT, vehicleNo TEXT, machineType TEXT, ownerCode TEXT, basis TEXT, active BOOLEAN, sourceFile TEXT, sourceSheet TEXT, createdAt DATETIME, updatedAt DATETIME);
    CREATE TABLE "Bill" (id TEXT PRIMARY KEY, year INTEGER, month INTEGER, periodKey TEXT, periodStart DATETIME, periodEnd DATETIME, assetId TEXT, assetCode TEXT, assetRegNo TEXT, assetLabel TEXT, driverName TEXT, projectId TEXT, projectName TEXT, projectCode TEXT, billingMode TEXT, rateBasis TEXT, rateCents INTEGER, openingMeter REAL, closingMeter REAL, actualUnits REAL, minimumUnits REAL, billableUnits REAL, rentalAmountCents INTEGER, fuelLitres REAL, fuelCostCents INTEGER, subtotalCents INTEGER, ssclRate REAL, ssclCents INTEGER, vatRate REAL, vatCents INTEGER, grandTotalCents INTEGER, invoiceNumber TEXT, status TEXT, issuedDate DATETIME, dueDate DATETIME, paidDate DATETIME, paidAmountCents INTEGER, paymentRef TEXT, paymentNote TEXT, notes TEXT, derivedFromFuel BOOLEAN, breakdownDays INTEGER, breakdownDeductCents INTEGER, createdAt DATETIME, updatedAt DATETIME, generatedById TEXT, emailedAt DATETIME, emailedTo TEXT);
    CREATE TABLE "BillLineItem" (id TEXT PRIMARY KEY, billId TEXT, kind TEXT, description TEXT, quantity REAL, unit TEXT, unitRateCents INTEGER, amountCents INTEGER, projectId TEXT, projectName TEXT);
    CREATE TABLE "BillRevision" (id TEXT PRIMARY KEY, billId TEXT, revision INTEGER, snapshotJson TEXT, subtotalCents INTEGER, grandTotalCents INTEGER, reason TEXT, createdById TEXT, createdAt DATETIME);
    CREATE TABLE "Payment" (id TEXT PRIMARY KEY, billId TEXT, amountCents INTEGER, paidDate DATETIME, method TEXT, reference TEXT, note TEXT, createdById TEXT, createdAt DATETIME);
    CREATE TABLE "CreditNote" (id TEXT PRIMARY KEY, billId TEXT, number TEXT, reason TEXT, amountCents INTEGER, status TEXT, createdById TEXT, createdAt DATETIME, issuedDate DATETIME);
    CREATE TABLE "Budget" (id TEXT PRIMARY KEY, projectId TEXT, year INTEGER, month INTEGER, budgetLitres REAL, budgetAmountCents INTEGER, note TEXT, createdById TEXT, createdAt DATETIME, updatedAt DATETIME);
    CREATE TABLE "PMTask" (id TEXT PRIMARY KEY, categoryId TEXT, taskCode TEXT, intervalHours REAL, intervalLabel TEXT, system TEXT, component TEXT, description TEXT, parts TEXT, skill TEXT, laborHours REAL, notes TEXT, sortOrder INTEGER, createdAt DATETIME, updatedAt DATETIME);
  `);
}

const woPath = path.join(TMP, 'live_workshopone.db');
const fuelPath = path.join(TMP, 'live_fuel_v2.db');
const targetPath = path.join(TMP, 'unified_merged.db');

test.before(() => {
  initMigratedDb(woPath);

  const woDb = new Database(woPath);
  woDb.pragma('foreign_keys = OFF');
  woDb.prepare("INSERT INTO projects (id, code, name, name_norm, active) VALUES (1, 'PROJ-1', 'Badalgama Plant', 'BADALGAMAPLANT', 1)").run();
  woDb.prepare("INSERT INTO assets (id, code, code_norm, registration, asset_class, status, in_register, current_project_id, running_hours) VALUES (10, 'EX-10', 'EX10', 'WP-1010', 'plant', 'active', 1, 1, 1000)").run();
  woDb.prepare("INSERT INTO users (id, username, password_hash, full_name, active) VALUES (2, 'staff1', 'keep-this-exact-hash', 'Staff One', 1)").run();
  woDb.prepare("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, requested_at) VALUES (100, '2026/11/R/001', 10, 1, 'repair', 'Hydraulic seal', 'IN_WORKSHOP', '2026-11-10')").run();
  woDb.prepare("INSERT INTO job_requests (id, jr_no, asset_id, project_id, type, description, approval_status) VALUES (200, 'JR-2026-001', 10, 1, 'repair', 'Pump leak', 'approved')").run();
  woDb.prepare("INSERT INTO mrn (id, mrn_no, asset_id, project_id, req_date, status) VALUES (300, 'MRN-100', 10, 1, '2026-11-10', 'open')").run();
  woDb.close();

  const fuelDb = new Database(fuelPath);
  createPrismaFuelSchema(fuelDb);
  fuelDb.prepare("INSERT INTO \"Project\" (id, name, code, createdAt) VALUES ('fp-1', 'Badalgama Plant', 'PROJ-1', '2026-06-01T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"User\" (id, username, name, role, active) VALUES ('fu-1', 'staff1', 'Staff One', 'ADMIN', 1)").run();
  fuelDb.prepare("INSERT INTO \"Asset\" (id, code, brand, typeLabel, model, regNo, status, meterType, projectId, createdAt, updatedAt) VALUES ('fa-10', 'EX-10', 'CAT', 'Excavator', '320D', 'WP-1010', 'ACTIVE', 'HOURS', 'fp-1', '2026-06-01T00:00:00.000+00:00', '2026-11-10T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"Asset\" (id, code, brand, typeLabel, model, regNo, status, meterType, projectId, createdAt, updatedAt) VALUES ('fa-99', 'EX-NEW-99', 'Komatsu', 'Excavator', 'PC200', 'KG-9999', 'ACTIVE', 'HOURS', 'fp-1', '2026-11-01T00:00:00.000+00:00', '2026-11-12T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"BulkTank\" (id, name, fuelKind, capacity, balance, projectId, createdAt, updatedAt) VALUES ('ft-1', 'New Colombo Tank', 'AUTO_DIESEL', 8000, 4500, 'fp-1', '2026-11-01T00:00:00.000+00:00', '2026-11-12T08:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"FuelPrice\" (id, fuelKind, pricePerLitre, effectiveFrom, source, note, createdAt) VALUES ('fpr-1', 'AUTO_DIESEL', 40000, '2026-11-01T00:00:00.000+00:00', 'MANUAL', 'Nov Price', '2026-11-01T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"FuelRequest\" (id, fuelKind, requestedLitres, status, createdAt, updatedAt, assetId, requestedById, projectId, requestNo) VALUES ('freq-1', 'AUTO_DIESEL', 120, 'APPROVED', '2026-11-10T06:00:00.000+00:00', '2026-11-10T07:00:00.000+00:00', 'fa-10', 'fu-1', 'fp-1', 'FR-001')").run();

  // Issue 1: ISO datetime; Issue 2: epoch ms for brand-new EX-NEW-99; Issue 3: voided
  const epochMs = Date.UTC(2026, 10, 12, 9, 15, 0);
  fuelDb.prepare("INSERT INTO \"FuelIssue\" (id, fuelKind, litres, meterReading, readingType, pricePerLitre, totalCost, source, issueDate, createdAt, assetId, issuedById, linkedRequestId, bulkTankId, voided, issuePerson) VALUES ('fi-1', 'AUTO_DIESEL', 100, 1120, 'HOURS', 40000, 4000000, 'Pump 1', '2026-11-10T08:30:00.000+00:00', '2026-11-10T08:30:00.000+00:00', 'fa-10', 'fu-1', 'freq-1', 'ft-1', 0, 'Driver A')").run();
  fuelDb.prepare("INSERT INTO \"FuelIssue\" (id, fuelKind, litres, meterReading, readingType, pricePerLitre, totalCost, source, issueDate, createdAt, assetId, issuedById, bulkTankId, voided, issuePerson) VALUES ('fi-2', 'AUTO_DIESEL', 50, 250, 'HOURS', 40000, 2000000, 'Pump 1', ?, ?, 'fa-99', 'fu-1', 'ft-1', 0, 'Driver B')").run(epochMs, epochMs);
  fuelDb.prepare("INSERT INTO \"FuelIssue\" (id, fuelKind, litres, meterReading, readingType, pricePerLitre, totalCost, source, issueDate, createdAt, assetId, bulkTankId, voided, voidedAt) VALUES ('fi-3', 'AUTO_DIESEL', 25, 1125, 'HOURS', 40000, 1000000, 'Pump 1', '2026-11-11T10:00:00.000+00:00', '2026-11-11T10:00:00.000+00:00', 'fa-10', 'ft-1', 1, '2026-11-11T11:00:00.000+00:00')").run();

  fuelDb.prepare("INSERT INTO \"BulkRequest\" (id, fuelKind, requestedLitres, status, createdAt, updatedAt, bulkTankId, requestedById, reviewedById, reviewedAt, reviewNote) VALUES ('fbr-1', 'AUTO_DIESEL', 2000, 'APPROVED', '2026-11-05T08:00:00.000+00:00', '2026-11-05T09:00:00.000+00:00', 'ft-1', 'fu-1', 'fu-1', '2026-11-05T09:00:00.000+00:00', 'Bowser #1')").run();
  fuelDb.prepare("INSERT INTO \"BulkRequest\" (id, fuelKind, requestedLitres, status, createdAt, updatedAt, bulkTankId, requestedById) VALUES ('fbr-2', 'AUTO_DIESEL', 500, 'REJECTED', '2026-11-06T08:00:00.000+00:00', '2026-11-06T09:00:00.000+00:00', 'ft-1', 'fu-1')").run();
  fuelDb.prepare("INSERT INTO \"TankDip\" (id, bulkTankId, dipLitres, computedBalance, variance, dipDate, note, createdAt, recordedById) VALUES ('fdip-1', 'ft-1', 4480, 4500, -20, '2026-11-12T17:00:00.000+00:00', 'Evening dip', '2026-11-12T17:00:00.000+00:00', 'fu-1')").run();
  fuelDb.prepare("INSERT INTO \"FuelIssueCorrection\" (id, fuelIssueId, type, status, reason, newLitres, origLitres, assetId, assetCode, projectId, requestedById, createdAt, updatedAt) VALUES ('fcorr-1', 'fi-1', 'EDIT', 'PENDING', 'Check slip', 95, 100, 'fa-10', 'EX-10', 'fp-1', 'fu-1', '2026-11-11T09:00:00.000+00:00', '2026-11-11T09:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"MeterReading\" (id, value, readingType, readingDate, source, createdAt, assetId, recordedById) VALUES ('fmr-1', 1200, 'HOURS', '2026-11-12T12:00:00.000+00:00', 'MANUAL', '2026-11-12T12:00:00.000+00:00', 'fa-10', 'fu-1')").run();
  fuelDb.prepare("INSERT INTO \"DailyCondition\" (id, status, logDate, note, createdAt, assetId, recordedById) VALUES ('fdc-1', 'WORKING', '2026-11-12T07:00:00.000+00:00', 'Normal', '2026-11-12T07:00:00.000+00:00', 'fa-10', 'fu-1')").run();
  fuelDb.prepare("INSERT INTO \"AssetAssignment\" (id, assetId, projectId, startDate, billingType, createdAt, updatedAt, origin) VALUES ('faa-1', 'fa-10', 'fp-1', '2026-11-01T00:00:00.000+00:00', 'STANDARD', '2026-11-01T00:00:00.000+00:00', '2026-11-01T00:00:00.000+00:00', 'FUEL')").run();
  fuelDb.prepare("INSERT INTO \"RentalRate\" (id, assetId, sourceLabel, category, equipType, hrFwCents, hrWCents, hrDCents, defaultBasis, fuelConsEcon, fuelConsTyp, fuelConsHeavy, fuelConsBasis, createdAt, updatedAt) VALUES ('frr-1', 'fa-10', 'Nov Card', 'Excavator', 'FLEET', 400000, 300000, 200000, 'w', 5, 7, 9.5, 'hr', '2026-11-01T00:00:00.000+00:00', '2026-11-01T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"VehicleAllocation\" (id, dedupeKey, projectId, siteName, month, assetId, vehicleNo, active, createdAt, updatedAt) VALUES ('fva-1', '2026-11|EX-10|PROJ-1', 'fp-1', 'Badalgama Plant', '2026-11', 'fa-10', 'EX-10', 1, '2026-11-01T00:00:00.000+00:00', '2026-11-01T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"Bill\" (id, year, month, periodKey, periodStart, periodEnd, assetId, assetCode, projectId, projectName, billingMode, rateBasis, rateCents, actualUnits, minimumUnits, billableUnits, rentalAmountCents, fuelLitres, fuelCostCents, subtotalCents, ssclRate, ssclCents, vatRate, vatCents, grandTotalCents, status, derivedFromFuel, breakdownDays, breakdownDeductCents, createdAt, updatedAt) VALUES ('fb-1', 2026, 11, '2026-11', '2026-11-01T00:00:00.000+00:00', '2026-11-30T23:59:59.000+00:00', 'fa-10', 'EX-10', 'fp-1', 'Badalgama Plant', 'hourly', 'w', 300000, 100, 100, 100, 30000000, 100, 4000000, 34000000, 0.025, 850000, 0.18, 6273000, 41123000, 'DRAFT', 1, 0, 0, '2026-11-12T08:00:00.000+00:00', '2026-11-12T08:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"BillLineItem\" (id, billId, kind, description, quantity, unit, unitRateCents, amountCents, projectId, projectName) VALUES ('fbli-1', 'fb-1', 'RENTAL', 'Rental hours', 100, 'hr', 300000, 30000000, 'fp-1', 'Badalgama Plant')").run();
  fuelDb.prepare("INSERT INTO \"BillRevision\" (id, billId, revision, snapshotJson, subtotalCents, grandTotalCents, reason, createdById, createdAt) VALUES ('fbrev-1', 'fb-1', 1, '{}', 34000000, 41123000, 'Initial draft', 'fu-1', '2026-11-12T08:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"Payment\" (id, billId, amountCents, paidDate, method, reference, note, createdById, createdAt) VALUES ('fpay-1', 'fb-1', 5000000, '2026-11-12T10:00:00.000+00:00', 'BANK', 'REF-1', 'Part payment', 'fu-1', '2026-11-12T10:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"CreditNote\" (id, billId, number, reason, amountCents, status, createdById, createdAt) VALUES ('fcn-1', 'fb-1', 'CN-001', 'Rebate', 100000, 'ISSUED', 'fu-1', '2026-11-12T11:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"Budget\" (id, projectId, year, month, budgetLitres, budgetAmountCents, note, createdById, createdAt, updatedAt) VALUES ('fbud-1', 'fp-1', 2026, 11, 5000, 200000000, 'Nov budget', 'fu-1', '2026-11-01T00:00:00.000+00:00', '2026-11-01T00:00:00.000+00:00')").run();
  fuelDb.prepare("INSERT INTO \"PMTask\" (id, taskCode, intervalHours, description, createdAt) VALUES ('fpm-1', 'EX-250', 250, '250h PM Service', '2026-11-01T00:00:00.000+00:00')").run();
  fuelDb.close();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. --build-fresh performs zero-loss cutover merge from WorkshopOne + Fuel-System-V2 with full rollups & parity', async () => {
  assert.equal(normDateTime(Date.UTC(2026, 10, 12, 9, 15, 0)), '2026-11-12 09:15:00');
  assert.equal(normDateTime('2026-11-10T08:30:00.000+00:00'), '2026-11-10 08:30:00');

  const res = await mergeVpsLiveData({
    buildFresh: true,
    woPath,
    fuelPath,
    targetPath,
    quiet: true,
  });

  assert.equal(res.mode, 'build-fresh');
  assert.equal(res.rollups.integrityCheck, 'ok');
  assert.equal(res.parity.readyForCutover, true);
  assert.equal(res.parity.woRealMissingTotal, 0);
  assert.equal(res.parity.fuelMissingTotal, 0);
  assert.equal(res.parity.fuelValueMismatchTotal, 0);

  const tDb = new Database(targetPath, { readonly: true });
  // Preserved user password & WO records
  const u = tDb.prepare("SELECT password_hash FROM users WHERE username = 'staff1'").get();
  assert.equal(u.password_hash, 'keep-this-exact-hash');
  assert.equal(tDb.prepare('SELECT job_no FROM job_cards WHERE id = 100').get().job_no, '2026/11/R/001');

  // Auto-created Fuel asset & tank with normalized constraints
  const newAsset = tDb.prepare("SELECT id, running_hours FROM assets WHERE code = 'EX-NEW-99'").get();
  assert.ok(newAsset && newAsset.id, 'Missing new Fuel asset must be auto-created');
  assert.equal(newAsset.running_hours, 250);

  const ex10 = tDb.prepare("SELECT running_hours FROM assets WHERE id = 10").get();
  assert.equal(ex10.running_hours, 1200, 'EX-10 running_hours must update from MeterReading 1200');

  const newTank = tDb.prepare("SELECT id, tank_type, current_litres FROM fuel_tanks WHERE name = 'New Colombo Tank'").get();
  assert.ok(newTank && newTank.tank_type === 'FIXED' && newTank.current_litres === 4500);

  // Voided issue mapped properly + active issues rolled up into vehicle_monthly_costs
  const voidedFi = tDb.prepare("SELECT is_voided, voided FROM fuel_issues WHERE id = 'fi-3'").get();
  assert.equal(voidedFi.is_voided, 1);
  assert.equal(voidedFi.voided, 1);

  const vmc = tDb.prepare('SELECT fuel_cost FROM vehicle_monthly_costs WHERE asset_id = 10 AND year = 2026 AND month = 11').get();
  assert.ok(vmc && vmc.fuel_cost >= 40000, 'vehicle_monthly_costs.fuel_cost must backfill from merged Fuel issues');

  // Bulk delivery cost auto-priced via Migration 065
  const del = tDb.prepare("SELECT status, cost_cents FROM fuel_bulk_deliveries WHERE id = 'fbr-1'").get();
  assert.equal(del.status, 'DELIVERED');
  assert.ok(del.cost_cents > 0, 'DELIVERED bulk delivery must be auto-priced from fuel_prices');

  tDb.close();
});

test('2. --dry-run detects deltas untouched, and incremental merge syncs new/voided/updated live rows with backup', async () => {
  // Mutate both live source DBs cleanly to simulate live production activity before cutover
  const woDb = new Database(woPath);
  woDb.prepare("INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, status, requested_at) VALUES (101, '2026/11/R/002', 10, 1, 'repair', 'Live added job', 'IN_WORKSHOP', '2026-11-15')").run();
  woDb.prepare("INSERT INTO mrn (id, mrn_no, asset_id, project_id, req_date, status) VALUES (301, 'MRN-101', 10, 1, '2026-11-15', 'open')").run();
  woDb.close();

  const fuelDb = new Database(fuelPath);
  // New live issue
  fuelDb.prepare("INSERT INTO \"FuelIssue\" (id, fuelKind, litres, meterReading, readingType, pricePerLitre, totalCost, source, issueDate, createdAt, assetId, bulkTankId, voided) VALUES ('fi-4', 'AUTO_DIESEL', 75, 1230, 'HOURS', 40000, 3000000, 'Pump 1', '2026-11-15T10:00:00.000+00:00', '2026-11-15T10:00:00.000+00:00', 'fa-10', 'ft-1', 0)").run();
  // Void fi-1
  fuelDb.prepare("UPDATE \"FuelIssue\" SET voided = 1, voidedAt = '2026-11-15T11:00:00.000+00:00' WHERE id = 'fi-1'").run();
  // Finalize bill & update balance
  fuelDb.prepare("UPDATE \"Bill\" SET status = 'FINAL', invoiceNumber = 'INV-2026-900', paidAmountCents = 41123000, updatedAt = '2026-11-15T12:00:00.000+00:00' WHERE id = 'fb-1'").run();
  fuelDb.prepare("UPDATE \"BulkTank\" SET balance = 4425, updatedAt = '2026-11-15T12:00:00.000+00:00' WHERE id = 'ft-1'").run();
  fuelDb.prepare("UPDATE \"FuelIssueCorrection\" SET status = 'APPROVED', reviewedAt = '2026-11-15T12:05:00.000+00:00', reviewNote = 'Verified' WHERE id = 'fcorr-1'").run();
  fuelDb.close();

  // Dry-run must detect exact gaps and NOT alter targetPath
  const countBefore = new Database(targetPath, { readonly: true }).prepare('SELECT COUNT(*) AS c FROM fuel_issues').get().c;
  const dry = await mergeVpsLiveData({ dryRun: true, woPath, fuelPath, targetPath, quiet: true });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.parity.readyForCutover, false);
  assert.equal(dry.parity.woRealMissingTotal, 2);
  assert.ok(dry.parity.fuelMissingTotal >= 1);
  assert.ok(dry.parity.fuelValueMismatchTotal >= 2);
  const countAfterDry = new Database(targetPath, { readonly: true }).prepare('SELECT COUNT(*) AS c FROM fuel_issues').get().c;
  assert.equal(countAfterDry, countBefore, '--dry-run must never mutate target DB');

  // Run incremental delta merge with backup
  const inc = await mergeVpsLiveData({ buildFresh: false, woPath, fuelPath, targetPath, skipBackup: false, quiet: true });
  assert.equal(inc.mode, 'incremental');
  assert.ok(inc.backupPath && fs.existsSync(inc.backupPath), 'Incremental merge must write pre-merge backup');
  assert.equal(inc.woStats.rowsInserted, 2);
  assert.equal(inc.fuelStats.issuesInserted, 1);
  assert.equal(inc.fuelStats.issuesUpdated, 1);
  assert.equal(inc.fuelStats.billsUpdated, 1);
  assert.equal(inc.fuelStats.tanksUpdated, 1);
  assert.equal(inc.fuelStats.correctionsUpdated, 1);
  assert.equal(inc.parity.readyForCutover, true);

  const tDb = new Database(targetPath, { readonly: true });
  assert.equal(tDb.prepare("SELECT is_voided FROM fuel_issues WHERE id = 'fi-1'").get().is_voided, 1);
  assert.equal(tDb.prepare("SELECT status, paid_amount_cents, invoice_number FROM fleet_bills WHERE id = 'fb-1'").get().status, 'FINAL');
  assert.equal(tDb.prepare("SELECT status FROM fuel_corrections WHERE id = 'fcorr-1'").get().status, 'APPROVED');
  assert.equal(tDb.prepare("SELECT current_litres FROM fuel_tanks WHERE name = 'New Colombo Tank'").get().current_litres, 4425);
  tDb.close();
});

test('3. Merge is idempotent and syncs missing uploads/outsourcing attachments without deleting existing files', async () => {
  const srcUp = path.join(TMP, 'src_uploads');
  const dstUp = path.join(TMP, 'dst_uploads');
  const srcOut = path.join(TMP, 'src_out');
  const dstOut = path.join(TMP, 'dst_out');

  fs.mkdirSync(path.join(srcUp, 'jobs'), { recursive: true });
  fs.mkdirSync(srcOut, { recursive: true });
  fs.mkdirSync(dstOut, { recursive: true });

  fs.writeFileSync(path.join(srcUp, 'jobs', 'photo1.jpg'), 'img-bytes');
  fs.writeFileSync(path.join(srcOut, 'ccom-1.pdf'), 'pdf-bytes');
  fs.writeFileSync(path.join(dstOut, 'keep-me.pdf'), 'existing-file');

  const second = await mergeVpsLiveData({
    buildFresh: false,
    woPath,
    fuelPath,
    targetPath,
    woUploadsDir: srcUp,
    targetUploadsDir: dstUp,
    woOutsourcingDir: srcOut,
    targetOutsourcingDir: dstOut,
    skipBackup: true,
    quiet: true,
  });

  assert.equal(second.woStats.rowsInserted, 0);
  assert.equal(second.fuelStats.issuesInserted, 0);
  assert.equal(second.fuelStats.billsInserted, 0);
  assert.equal(second.filesCopied, 2);
  assert.equal(second.parity.readyForCutover, true);
  assert.equal(fs.readFileSync(path.join(dstUp, 'jobs', 'photo1.jpg'), 'utf8'), 'img-bytes');
  assert.equal(fs.readFileSync(path.join(dstOut, 'ccom-1.pdf'), 'utf8'), 'pdf-bytes');
  assert.equal(fs.readFileSync(path.join(dstOut, 'keep-me.pdf'), 'utf8'), 'existing-file');

  // Standalone --verify-only check
  const ver = getVpsCutoverParityReport({ woPath, fuelPath, targetPath });
  assert.equal(ver.readyForCutover, true);
});
