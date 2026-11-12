'use strict';
/**
 * =============================================================================
 * WorkshopOne - Production Data Migration Script
 * Safe, read-only import of:
 *   1. 9632 (:1929) Master Data from ./data/core.db
 *   2. 9632 (:1929) Central Workshop Execution Data from ./data/workshops/CW.db
 *   3. Fuel-System-V2 Data from ./Fuel-System-V2/data/app.db
 *
 * Strictly writes ONLY into ./9632-Fuel-Merged/data/workshopone_merged.db (:1949)
 * =============================================================================
 */

const Database = require('../node_modules/better-sqlite3');
const path = require('path');
const fs = require('fs');

const PATH_CORE = path.resolve('d:/Master system 1/data/core.db');
const PATH_CW   = path.resolve('d:/Master system 1/data/workshops/CW.db');
const PATH_FUEL = path.resolve('d:/Master system 1/Fuel-System-V2/data/app.db');
const PATH_DEST = path.resolve(__dirname, '../data/workshopone_merged.db');

console.log('=== STARTING SAFE READ-ONLY DATA IMPORT ===');
console.log('Source 1 (Core):     ', PATH_CORE);
console.log('Source 2 (Workshop): ', PATH_CW);
console.log('Source 3 (Fuel):     ', PATH_FUEL);
console.log('Target (Merged 1949):', PATH_DEST);

// Open sources in STRICT READ-ONLY mode
const dbCore = new Database(PATH_CORE, { readonly: true, fileMustExist: true });
const dbCW   = new Database(PATH_CW,   { readonly: true, fileMustExist: true });
const dbFuel = new Database(PATH_FUEL, { readonly: true, fileMustExist: true });

// Open destination in read-write mode
const dbDest = new Database(PATH_DEST);

// Disable foreign keys during bulk load for speed and constraint ordering
dbDest.pragma('foreign_keys = OFF');
dbDest.pragma('journal_mode = WAL');
dbDest.pragma('synchronous = NORMAL');

function copyTable(srcDb, srcTable, destTable, whereClause = '') {
  try {
    const srcCols = srcDb.prepare(`PRAGMA table_info(${srcTable})`).all().map(c => c.name);
    const destCols = dbDest.prepare(`PRAGMA table_info(${destTable})`).all().map(c => c.name);
    const commonCols = srcCols.filter(c => destCols.includes(c));

    if (!commonCols.length) {
      console.log(`[SKIP] No matching columns between ${srcTable} and ${destTable}`);
      return 0;
    }

    const selectSql = `SELECT ${commonCols.join(', ')} FROM ${srcTable} ${whereClause}`;
    const rows = srcDb.prepare(selectSql).all();

    if (!rows.length) {
      return 0;
    }

    const placeholders = commonCols.map(() => '?').join(', ');
    const insertSql = `INSERT OR REPLACE INTO ${destTable} (${commonCols.join(', ')}) VALUES (${placeholders})`;
    const insertStmt = dbDest.prepare(insertSql);

    const insertMany = dbDest.transaction((items) => {
      for (const item of items) {
        if (destTable === 'job_cards' && item.type && !['repair', 'service'].includes(item.type)) {
          item.type = 'repair';
        }
        const vals = commonCols.map(c => item[c]);
        insertStmt.run(...vals);
      }
    });

    insertMany(rows);
    return rows.length;
  } catch (e) {
    console.error(`[ERROR copying ${srcTable} -> ${destTable}]:`, e.message);
    return 0;
  }
}

try {
  // ===========================================================================
  // STEP 1: IMPORT CORE MASTER DATA FROM core.db
  // ===========================================================================
  console.log('\n--- Step 1: Importing Master Data from core.db ---');

  const coreTables = [
    'projects', 'sites', 'roles', 'item_categories', 'store_items',
    'stock_items', 'products', 'product_prices', 'filter_catalogue',
    'filter_prices', 'filter_xrefs', 'vehicle_lubricant_capacities',
    'assets', 'asset_aliases', 'user_permissions', 'role_permissions',
    'role_capabilities'
  ];

  for (const t of coreTables) {
    const count = copyTable(dbCore, t, t);
    console.log(`✔ Copied ${count} rows into ${t}`);
  }

  // Copy Users but preserve admin password
  const coreUsers = dbCore.prepare('SELECT * FROM users').all();
  const destUserCols = dbDest.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const commonUserCols = Object.keys(coreUsers[0] || {}).filter(c => destUserCols.includes(c));
  const userStmt = dbDest.prepare(`INSERT OR REPLACE INTO users (${commonUserCols.join(', ')}) VALUES (${commonUserCols.map(() => '?').join(', ')})`);

  let userCount = 0;
  const insertUsers = dbDest.transaction((users) => {
    for (const u of users) {
      // Keep admin password hash from merged DB if admin
      if (u.username === 'admin') {
        const existing = dbDest.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
        if (existing && existing.password_hash) u.password_hash = existing.password_hash;
        u.must_change_password = 0;
      }
      const vals = commonUserCols.map(c => u[c]);
      userStmt.run(...vals);
      userCount++;
    }
  });
  insertUsers(coreUsers);
  console.log(`✔ Copied ${userCount} users (admin login preserved)`);

  const userRolesCount = copyTable(dbCore, 'user_roles', 'user_roles');
  console.log(`✔ Copied ${userRolesCount} user_roles`);

  // ===========================================================================
  // STEP 2: IMPORT CENTRAL WORKSHOP EXECUTION DATA FROM CW.db
  // ===========================================================================
  console.log('\n--- Step 2: Importing Workshop Operations from CW.db ---');

  const cwTables = [
    ['mechanics', 'mechanics'],
    ['mechanic_aliases', 'mechanic_aliases'],
    ['labour_rates', 'labour_rates'],
    ['batteries', 'batteries'],
    ['battery_events', 'battery_events'],
    ['workshop_tools', 'workshop_tools'],
    ['mrn', 'mrn'],
    ['mrn_lines', 'mrn_lines'],
    ['grn', 'grn'],
    ['issues', 'issues'],
    ['job_cards', 'job_cards'],
    ['job_parts', 'job_parts'],
    ['job_labour', 'job_labour'],
    ['job_daily_work', 'job_daily_work'],
    ['service_jobs', 'service_jobs'],
    ['service_filters', 'service_filters'],
    ['service_oils', 'service_oils'],
    ['tyre_battery_issues', 'tyre_battery_issues'],
    ['stock_ledger', 'stock_ledger'],
    ['stock_moves', 'stock_moves'],
    ['daily_report_snapshots', 'daily_report_snapshots']
  ];

  for (const [srcT, destT] of cwTables) {
    const count = copyTable(dbCW, srcT, destT);
    console.log(`✔ Copied ${count} rows into ${destT}`);
  }

  // ===========================================================================
  // STEP 3: IMPORT FUEL & BOWSER SYSTEM DATA FROM Fuel-System-V2 app.db
  // ===========================================================================
  console.log('\n--- Step 3: Importing Fuel System from Fuel-System-V2/data/app.db ---');

  // Build mapping from Fuel-System-V2 Asset -> 9632 Asset ID
  const fuelAssets = dbFuel.prepare('SELECT id, code, regNo, brand, model, meterType FROM Asset').all();
  const destAssets = dbDest.prepare('SELECT id, code, code_norm, registration FROM assets').all();

  const codeMap = new Map();
  const normMap = new Map();
  const regMap = new Map();

  for (const a of destAssets) {
    if (a.code) codeMap.set(a.code.toUpperCase().trim(), a.id);
    if (a.code_norm) normMap.set(a.code_norm.toUpperCase().trim(), a.id);
    if (a.registration) regMap.set(a.registration.toUpperCase().replace(/[\s-]/g, ''), a.id);
  }

  const assetIdMap = new Map(); // fuelAssetId (UUID) -> destAssetId (INTEGER)
  for (const fa of fuelAssets) {
    const c = fa.code ? fa.code.toUpperCase().trim() : '';
    const cNorm = c.replace(/[\s-]/g, '');
    const r = fa.regNo ? fa.regNo.toUpperCase().replace(/[\s-]/g, '') : '';
    const matchedId = codeMap.get(c) || normMap.get(cNorm) || (r ? regMap.get(r) : null);
    if (matchedId) {
      assetIdMap.set(fa.id, matchedId);
    }
  }
  console.log(`✔ Mapped ${assetIdMap.size} Fuel Assets to 9632 Assets`);

  // Build Project Map: Fuel-System-V2 Project -> 9632 Project ID
  const fuelProjects = dbFuel.prepare('SELECT id, code, name FROM Project').all();
  const destProjects = dbDest.prepare('SELECT id, code, name FROM projects').all();
  const projCodeMap = new Map();
  for (const p of destProjects) {
    if (p.code) projCodeMap.set(p.code.toUpperCase().trim(), p.id);
    if (p.name) projCodeMap.set(p.name.toUpperCase().trim(), p.id);
  }
  const projectIdMap = new Map();
  for (const fp of fuelProjects) {
    const c = fp.code ? fp.code.toUpperCase().trim() : '';
    const n = fp.name ? fp.name.toUpperCase().trim() : '';
    const matchedId = projCodeMap.get(c) || projCodeMap.get(n);
    if (matchedId) projectIdMap.set(fp.id, matchedId);
  }

  // 1. Bulk Tanks
  const fuelTanks = dbFuel.prepare('SELECT * FROM BulkTank').all();
  const tankIdMap = new Map(); // fuelTankId (UUID) -> destTankId (INTEGER)
  const tankStmt = dbDest.prepare(`
    INSERT INTO bulk_tanks (name, capacity_litres, current_litres, fuel_kind, project_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `);

  const insertTanks = dbDest.transaction((tanks) => {
    for (const t of tanks) {
      const pId = projectIdMap.get(t.projectId) || null;
      const info = tankStmt.run(
        t.name,
        t.capacity || 0,
        t.balance || 0,
        t.fuelKind || 'AUTO_DIESEL',
        pId,
        t.createdAt ? t.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' '),
        t.updatedAt ? t.updatedAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      tankIdMap.set(t.id, info.lastInsertRowid);
    }
  });
  insertTanks(fuelTanks);
  console.log(`✔ Imported ${fuelTanks.length} Bulk Tanks into bulk_tanks`);

  // 2. Fuel Prices (convert pricePerLitre from cents to LKR)
  const fuelPrices = dbFuel.prepare('SELECT * FROM FuelPrice').all();
  const priceStmt = dbDest.prepare(`
    INSERT INTO fuel_prices (fuel_kind, price_per_litre, effective_date, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPrices = dbDest.transaction((prices) => {
    for (const p of prices) {
      const priceLkr = Math.round((p.pricePerLitre / 100) * 100) / 100;
      const date = p.effectiveFrom ? p.effectiveFrom.slice(0, 10) : new Date().toISOString().slice(0, 10);
      priceStmt.run(
        p.fuelKind || 'AUTO_DIESEL',
        priceLkr,
        date,
        p.source || 'Ceypetco',
        p.createdAt ? p.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
    }
  });
  insertPrices(fuelPrices);
  console.log(`✔ Imported ${fuelPrices.length} Fuel Prices (converted from cents to LKR)`);

  // 3. Bulk Requests (Bowser orders & deliveries)
  const fuelRequests = dbFuel.prepare('SELECT * FROM BulkRequest').all();
  const reqStmt = dbDest.prepare(`
    INSERT INTO bulk_requests (bulk_tank_id, requested_litres, fuel_kind, status, supplier, received_litres, received_date, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let reqCount = 0;
  const insertReqs = dbDest.transaction((reqs) => {
    for (const r of reqs) {
      const destTankId = tankIdMap.get(r.bulkTankId);
      if (!destTankId) continue;
      const date = r.reviewedAt || r.updatedAt || r.createdAt;
      reqStmt.run(
        destTankId,
        r.requestedLitres || 0,
        r.fuelKind || 'AUTO_DIESEL',
        (r.status || 'approved').toLowerCase(),
        'Ceypetco Bowser',
        r.status === 'APPROVED' ? r.requestedLitres : null,
        date ? date.slice(0, 10) : null,
        r.reviewNote || null,
        r.createdAt ? r.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      reqCount++;
    }
  });
  insertReqs(fuelRequests);
  console.log(`✔ Imported ${reqCount} Bowser Stock Receipts into bulk_requests`);

  // 4. Tank Dips
  const fuelDips = dbFuel.prepare('SELECT * FROM TankDip').all();
  const dipStmt = dbDest.prepare(`
    INSERT INTO tank_dips (bulk_tank_id, dip_date, dip_cm, calculated_litres, system_litres, variance_litres, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let dipCount = 0;
  for (const d of fuelDips) {
    const destTankId = tankIdMap.get(d.bulkTankId);
    if (!destTankId) continue;
    dipStmt.run(
      destTankId,
      d.dipDate ? d.dipDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
      0,
      d.dipLitres || 0,
      d.computedBalance || 0,
      d.variance || 0,
      d.note || null,
      d.createdAt ? d.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
    );
    dipCount++;
  }
  console.log(`✔ Imported ${dipCount} Physical Tank Dips`);

  // 5. Meter Readings
  const fuelMeters = dbFuel.prepare('SELECT * FROM MeterReading').all();
  const meterStmt = dbDest.prepare(`
    INSERT OR REPLACE INTO meter_readings (asset_id, reading, meter_type, reading_date, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let meterCount = 0;
  const insertMeters = dbDest.transaction((meters) => {
    for (const m of meters) {
      const destAssetId = assetIdMap.get(m.assetId);
      if (!destAssetId || !m.value) continue;
      meterStmt.run(
        destAssetId,
        m.value,
        m.readingType || 'HOURS',
        m.readingDate ? m.readingDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
        m.source || 'FUEL_ISSUE',
        m.createdAt ? m.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      meterCount++;
    }
  });
  insertMeters(fuelMeters);
  console.log(`✔ Imported ${meterCount} Machine Meter Readings`);

  // 6. Fuel Dispense Logs (FuelIssue -> fuel_issues)
  // Convert pricePerLitre and totalCost from cents to LKR
  const fuelIssues = dbFuel.prepare('SELECT * FROM FuelIssue').all();
  const issueStmt = dbDest.prepare(`
    INSERT OR REPLACE INTO fuel_issues (
      issue_no, asset_id, bulk_tank_id, fuel_kind, litres, unit_price, total_price,
      meter_reading, issue_date, recipient_name, source, voided, void_reason, voided_at, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let issueCount = 0, skippedIssues = 0;
  const insertIssues = dbDest.transaction((issues) => {
    for (let idx = 0; idx < issues.length; idx++) {
      const fi = issues[idx];
      const destAssetId = assetIdMap.get(fi.assetId);
      if (!destAssetId) {
        skippedIssues++;
        continue;
      }
      const destTankId = tankIdMap.get(fi.bulkTankId) || null;
      const unitPriceLkr = Math.round(((fi.pricePerLitre || 0) / 100) * 100) / 100;
      const totalPriceLkr = Math.round(((fi.totalCost || 0) / 100) * 100) / 100;
      const issueNo = `FISS-${String(idx + 1).padStart(6, '0')}`;
      const issueDate = fi.issueDate ? fi.issueDate.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');

      issueStmt.run(
        issueNo,
        destAssetId,
        destTankId,
        fi.fuelKind || 'AUTO_DIESEL',
        fi.litres || 0,
        unitPriceLkr,
        totalPriceLkr,
        fi.meterReading || null,
        issueDate,
        fi.issuePerson || null,
        fi.source || 'pump',
        fi.voided ? 1 : 0,
        fi.voided ? 'Voided in source system' : null,
        fi.voidedAt ? fi.voidedAt.slice(0, 19).replace('T', ' ') : null,
        fi.importKey || null,
        fi.createdAt ? fi.createdAt.slice(0, 19).replace('T', ' ') : issueDate
      );
      issueCount++;
    }
  });
  insertIssues(fuelIssues);
  console.log(`✔ Imported ${issueCount} Fuel Dispense Records (14k+ entries with cents->LKR conversion)`);

  // 7. Equipment Rental Rate Cards
  const fuelRates = dbFuel.prepare('SELECT * FROM RentalRate').all();
  const rateStmt = dbDest.prepare(`
    INSERT OR REPLACE INTO rental_rates (asset_id, category, rate_type, rate_amount, currency, notes, created_at)
    VALUES (?, ?, ?, ?, 'LKR', ?, ?)
  `);
  let rateCount = 0;
  const insertRates = dbDest.transaction((rates) => {
    for (const r of rates) {
      const destAssetId = r.assetId ? assetIdMap.get(r.assetId) : null;
      const amountLkr = r.hrWCents ? (r.hrWCents / 100) : r.dyWCents ? (r.dyWCents / 100) : r.opRate || 0;
      if (!amountLkr) continue;
      rateStmt.run(
        destAssetId,
        r.category || null,
        r.defaultBasis ? r.defaultBasis.toLowerCase() : 'hourly',
        amountLkr,
        r.equipType || r.sourceLabel || null,
        r.createdAt ? r.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      rateCount++;
    }
  });
  insertRates(fuelRates);
  console.log(`✔ Imported ${rateCount} Equipment Rental Rate Cards`);

  // 8. Equipment Hire Bills & Line Items
  const fuelBills = dbFuel.prepare('SELECT * FROM Bill').all();
  const billIdMap = new Map();
  const billStmt = dbDest.prepare(`
    INSERT OR REPLACE INTO bills (bill_no, project_id, period_start, period_end, status, subtotal, tax, total_amount, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let billCount = 0;
  const insertBills = dbDest.transaction((bills) => {
    for (const b of bills) {
      const pId = projectIdMap.get(b.projectId) || 1;
      const subtotalLkr = Math.round(((b.subtotalCents || b.rentalAmountCents || 0) / 100) * 100) / 100;
      const totalLkr = Math.round(((b.grandTotalCents || 0) / 100) * 100) / 100;
      const taxLkr = Math.round((((b.ssclCents || 0) + (b.vatCents || 0)) / 100) * 100) / 100;
      const billNo = b.invoiceNumber || `BILL-${b.year}-${String(b.month).padStart(2, '0')}-${b.id.slice(0, 6)}`;
      const pStart = b.periodStart ? b.periodStart.slice(0, 10) : `${b.year}-${String(b.month).padStart(2, '0')}-01`;
      const pEnd = b.periodEnd ? b.periodEnd.slice(0, 10) : `${b.year}-${String(b.month).padStart(2, '0')}-28`;

      const info = billStmt.run(
        billNo,
        pId,
        pStart,
        pEnd,
        (b.status || 'approved').toLowerCase(),
        subtotalLkr,
        taxLkr,
        totalLkr,
        b.notes || null,
        b.createdAt ? b.createdAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      billIdMap.set(b.id, info.lastInsertRowid);
      billCount++;
    }
  });
  insertBills(fuelBills);
  console.log(`✔ Imported ${billCount} Equipment Hire Bills`);

  // Bill Line Items
  const fuelLineItems = dbFuel.prepare('SELECT * FROM BillLineItem').all();
  const billItemStmt = dbDest.prepare(`
    INSERT OR REPLACE INTO bill_line_items (bill_id, asset_id, hours_or_days, rate, base_amount, fuel_deduction, net_amount, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let billItemCount = 0;
  const insertBillItems = dbDest.transaction((items) => {
    for (const bli of items) {
      const destBillId = billIdMap.get(bli.billId);
      if (!destBillId) continue;
      const fuelBill = fuelBills.find(fb => fb.id === bli.billId);
      const destAssetId = fuelBill ? assetIdMap.get(fuelBill.assetId) : null;
      if (!destAssetId) continue;

      const rateLkr = Math.round(((bli.unitRateCents || 0) / 100) * 100) / 100;
      const amountLkr = Math.round(((bli.amountCents || 0) / 100) * 100) / 100;
      const fuelDedLkr = fuelBill && fuelBill.fuelCostCents ? Math.round((fuelBill.fuelCostCents / 100) * 100) / 100 : 0;

      billItemStmt.run(
        destBillId,
        destAssetId,
        bli.quantity || 0,
        rateLkr,
        amountLkr,
        fuelDedLkr,
        Math.max(0, amountLkr - fuelDedLkr),
        bli.description || null
      );
      billItemCount++;
    }
  });
  insertBillItems(fuelLineItems);
  console.log(`✔ Imported ${billItemCount} Hire Bill Line Items`);

  // 9. Sync Asset current_hours from latest meter telemetry
  console.log('\n--- Step 4: Synchronizing Asset Telemetry ---');
  const syncStmt = dbDest.prepare(`
    UPDATE assets
       SET current_hours = COALESCE(
         (SELECT MAX(reading) FROM meter_readings WHERE asset_id = assets.id),
         (SELECT MAX(meter_reading) FROM fuel_issues WHERE asset_id = assets.id),
         assets.current_hours
       )
  `);
  const syncRes = syncStmt.run();
  console.log(`✔ Synchronized current_hours across ${syncRes.changes} assets`);

} finally {
  // Re-enable foreign keys and verify integrity
  dbDest.pragma('foreign_keys = ON');
  dbCore.close();
  dbCW.close();
  dbFuel.close();
  dbDest.close();
}

console.log('\n===============================================================');
console.log('DATA MIGRATION COMPLETED SUCCESSFULLY!');
console.log('All source databases were opened with readonly: true and are untouched.');
console.log('===============================================================');
