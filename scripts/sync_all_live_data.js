'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CORE_DB_PATH = 'd:/Master system 1/data/core.db';
const CW_DB_PATH = 'd:/Master system 1/data/workshops/CW.db';
const MTR_DB_PATH = 'd:/Master system 1/data/workshops/MTR.db';
const MERGED_DB_PATH = path.join(__dirname, '..', 'data', 'workshopone_merged.db');

function runLiveDeltaSync(opts = {}) {
  const quiet = !!opts.quiet;
  const log = (...args) => { if (!quiet) console.log(...args); };

  log('Opening source databases in STRICT READ-ONLY mode...');
  const coreDb = new Database(CORE_DB_PATH, { readonly: true });
  const cwDb = new Database(CW_DB_PATH, { readonly: true });
  const mtrDb = new Database(MTR_DB_PATH, { readonly: true });

  log('Opening target merged database:', MERGED_DB_PATH);
  const mergedDb = new Database(MERGED_DB_PATH);
  mergedDb.pragma('journal_mode = WAL');
  mergedDb.pragma('foreign_keys = OFF');

  const stats = { tablesSynced: 0, rowsSynced: 0, filesCopied: 0 };

  function hasTable(db, table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  }

  function getCols(db, table) {
    if (!hasTable(db, table)) return [];
    return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  }

  function getPkType(db, table) {
    if (!hasTable(db, table)) return null;
    const pk = db.prepare(`PRAGMA table_info("${table}")`).all().find(c => c.pk);
    return pk ? pk.type : null;
  }

  function recreateTableFromSource(srcDb, table) {
    const ddl = srcDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (ddl && ddl.sql) {
      mergedDb.exec(`DROP TABLE IF EXISTS "${table}"`);
      mergedDb.exec(ddl.sql);
      log(`  [+] Recreated table from source DDL: ${table}`);
    }
  }

  function ensureTableFromSource(srcDb, table) {
    if (!hasTable(mergedDb, table)) {
      const ddl = srcDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (ddl && ddl.sql) {
        mergedDb.exec(ddl.sql);
        log(`  [+] Created missing table: ${table}`);
      }
    } else {
      const srcInfo = srcDb.prepare(`PRAGMA table_info("${table}")`).all();
      const mergedCols = new Set(getCols(mergedDb, table));
      for (const col of srcInfo) {
        if (!mergedCols.has(col.name)) {
          const typeDef = col.type || 'TEXT';
          const dflt = col.dflt_value !== null && col.dflt_value !== undefined ? ` DEFAULT ${col.dflt_value}` : '';
          mergedDb.exec(`ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${typeDef}${dflt}`);
          log(`  [+] Added column ${table}.${col.name}`);
        }
      }
    }
  }

  function syncTable(srcDb, srcLabel, table, replaceAll = false) {
    if (!hasTable(srcDb, table)) return 0;
    ensureTableFromSource(srcDb, table);

    const srcCols = getCols(srcDb, table);
    const dstCols = new Set(getCols(mergedDb, table));
    const commonCols = srcCols.filter(c => dstCols.has(c));
    if (!commonCols.length) return 0;

    const rows = srcDb.prepare(`SELECT ${commonCols.map(c => `"${c}"`).join(', ')} FROM "${table}"`).all();
    if (!rows.length) return 0;

    const colList = commonCols.map(c => `"${c}"`).join(', ');
    const placeholders = commonCols.map(c => `@${c}`).join(', ');
    const insertStmt = mergedDb.prepare(`INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`);

    const tx = mergedDb.transaction((items) => {
      if (replaceAll) {
        mergedDb.prepare(`DELETE FROM "${table}"`).run();
      }
      for (const r of items) {
        insertStmt.run(r);
      }
    });
    tx(rows);
    stats.tablesSynced++;
    stats.rowsSynced += rows.length;
    log(`  [✓] Synced ${rows.length} rows from ${srcLabel}.${table}`);
    return rows.length;
  }

  // 1. Ensure fuel_requests, fuel_issues, and fuel_prices have Plan-V2 schema + dual-compatible columns
  log('\n--- Step 1: Syncing fuel_requests, fuel_issues, and fuel_prices ---');
  if (getPkType(mergedDb, 'fuel_requests') !== 'TEXT') {
    recreateTableFromSource(coreDb, 'fuel_requests');
  }
  syncTable(coreDb, 'core.db', 'fuel_requests', false);

  if (getPkType(mergedDb, 'fuel_issues') !== 'TEXT') {
    recreateTableFromSource(coreDb, 'fuel_issues');
  }
  const existingFuelIssueCols = new Set(getCols(mergedDb, 'fuel_issues'));
  const fuelIssueAliasCols = [
    ['bulk_tank_id', ' TEXT'],
    ['project_id', ' INTEGER'],
    ['fuel_kind', " TEXT DEFAULT 'AUTO_DIESEL'"],
    ['unit_price', ' REAL DEFAULT 0'],
    ['total_price', ' REAL DEFAULT 0'],
    ['recipient_name', ' TEXT'],
    ['source', " TEXT DEFAULT 'BOWSER'"],
    ['voided', ' INTEGER DEFAULT 0'],
    ['photo_path', ' TEXT'],
    ['notes', ' TEXT'],
    ['cost_cents', ' INTEGER DEFAULT 0'],
    ['price_per_litre_cents', ' INTEGER DEFAULT 0']
  ];
  for (const [colName, colDef] of fuelIssueAliasCols) {
    if (!existingFuelIssueCols.has(colName)) {
      mergedDb.exec(`ALTER TABLE fuel_issues ADD COLUMN "${colName}"${colDef}`);
    }
  }
  syncTable(coreDb, 'core.db', 'fuel_issues', false);

  mergedDb.exec(`
    UPDATE fuel_issues
       SET fuel_kind = COALESCE(fuel_type, 'AUTO_DIESEL'),
           unit_price = ROUND(COALESCE(fuel_price_cents, 0) / 100.0, 2),
           total_price = ROUND(COALESCE(total_cost_cents, 0) / 100.0, 2),
           cost_cents = COALESCE(total_cost_cents, 0),
           price_per_litre_cents = COALESCE(fuel_price_cents, 0),
           recipient_name = COALESCE(driver_name, recipient_name),
           bulk_tank_id = COALESCE(source_tank_id, bulk_tank_id),
           project_id = COALESCE(target_project_id, source_project_id, project_id),
           voided = COALESCE(is_voided, voided, 0),
           source = COALESCE(station_name, source, 'BOWSER')
  `);

  const existingFuelPriceCols = new Set(getCols(mergedDb, 'fuel_prices'));
  if (!existingFuelPriceCols.has('fuel_type')) {
    recreateTableFromSource(coreDb, 'fuel_prices');
  }
  const updatedFuelPriceCols = new Set(getCols(mergedDb, 'fuel_prices'));
  const fuelPriceAliasCols = [
    ['fuel_kind', " TEXT DEFAULT 'AUTO_DIESEL'"],
    ['price_per_litre', ' REAL DEFAULT 0'],
    ['end_date', ' TEXT'],
    ['source', " TEXT DEFAULT 'Ceypetco'"],
    ['entered_by', ' INTEGER']
  ];
  for (const [colName, colDef] of fuelPriceAliasCols) {
    if (!updatedFuelPriceCols.has(colName)) {
      mergedDb.exec(`ALTER TABLE fuel_prices ADD COLUMN "${colName}"${colDef}`);
    }
  }
  syncTable(coreDb, 'core.db', 'fuel_prices', false);
  mergedDb.exec(`
    UPDATE fuel_prices
       SET fuel_kind = COALESCE(fuel_type, 'AUTO_DIESEL'),
           price_per_litre = ROUND(COALESCE(price_per_litre_cents, 0) / 100.0, 2),
           entered_by = COALESCE(created_by, entered_by),
           source = COALESCE(notes, source, 'Ceypetco')
  `);

  // 2. Sync Plan-V2 Fuel & Fleet tables from core.db (incremental upsert)
  log('\n--- Step 2: Syncing Fuel & Fleet Master Tables from core.db ---');
  const coreTables = [
    'assets',
    'asset_aliases',
    'asset_images',
    'projects',
    'fuel_tanks',
    'fuel_tank_dips',
    'fuel_bulk_deliveries',
    'fuel_meter_readings',
    'fuel_pm_tasks',
    'fuel_corrections',
    'fuel_daily_conditions',
    'fleet_asset_assignments',
    'fleet_bills',
    'fleet_bill_line_items',
    'fleet_bill_revisions',
    'fleet_rental_rates',
    'fleet_financial_events',
    'fleet_identity_mappings',
    'filter_catalogue',
    'filter_category_list',
    'filter_prices',
    'filter_xrefs',
    'item_categories',
    'oil_list',
    'oil_type_prices',
    'products',
    'product_prices',
    'service_specs',
    'stock_items',
    'store_items',
    'tb_specs',
    'tyre_battery_prices',
    'vehicle_doc_types',
    'vehicle_documents',
    'vehicle_holds',
    'vehicle_lubricant_capacities',
    'workshops'
  ];

  for (const t of coreTables) {
    syncTable(coreDb, 'core.db', t, false);
  }

  // 3. Sync Workshop, Store, KPI & C.COM Outsourcing tables from CW.db
  log('\n--- Step 3: Syncing Workshop, C.COM Outsourcing & Store Tables from CW.db ---');
  const cwTables = [
    'outsourcing_requests',
    'outsourcing_request_lines',
    'outsourcing_revisions',
    'outsourcing_events',
    'outsourcing_approvals',
    'outsourcing_documents',
    'outsourcing_email_outbox',
    'outsourcing_vendors',
    'outsourcing_vendor_contacts',
    'job_cards',
    'job_costs',
    'job_approvals',
    'job_requests',
    'job_request_approvals',
    'job_reopen_requests',
    'job_reopens',
    'job_daily_work',
    'job_labour',
    'job_parts',
    'line_evidence_photos',
    'mrn',
    'mrn_lines',
    'mrn_approvals',
    'mrn_line_priority_history',
    'grn',
    'grn_approvals',
    'grn_vouchers',
    'issues',
    'min_approvals',
    'min_notes',
    'mtn',
    'mtn_lines',
    'mtn_approvals',
    'receipt_price_notes',
    'stock_counts',
    'stock_opening',
    'store_reorder',
    'filter_stock',
    'filter_stock_ledger',
    'general_item_txns',
    'fabrication_categories',
    'fabrication_costing_sheets',
    'fabrication_costing_adjustments',
    'service_jobs',
    'service_oils',
    'service_filters',
    'service_attachments',
    'service_parts',
    'batteries',
    'battery_events',
    'tyre_battery_issues',
    'mechanics',
    'mechanic_aliases',
    'mechanic_attendance',
    'mechanic_workshops',
    'monthly_report_inputs',
    'daily_report_snapshots',
    'vehicle_monthly_costs',
    'workshop_tools'
  ];

  for (const t of cwTables) {
    syncTable(cwDb, 'CW.db', t, false);
  }

  // 4. Copy C.COM Outsourcing PDF attachments (read-only copy)
  log('\n--- Step 4: Copying C.COM Outsourcing PDFs ---');
  const srcOutsourcingDir = 'd:/Master system 1/data/outsourcing';
  const dstOutsourcingDir = path.join(__dirname, '..', 'data', 'outsourcing');
  if (fs.existsSync(srcOutsourcingDir)) {
    fs.mkdirSync(dstOutsourcingDir, { recursive: true });
    const files = fs.readdirSync(srcOutsourcingDir);
    for (const f of files) {
      const srcFile = path.join(srcOutsourcingDir, f);
      const dstFile = path.join(dstOutsourcingDir, f);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, dstFile);
        stats.filesCopied++;
        log(`  [✓] Copied outsourcing attachment: ${f}`);
      }
    }
  }

  mergedDb.pragma('foreign_keys = ON');
  coreDb.close();
  cwDb.close();
  mtrDb.close();
  mergedDb.close();
  log('\n=== LIVE DELTA SYNC COMPLETE ===', stats);
  return stats;
}

if (require.main === module) {
  runLiveDeltaSync();
}

module.exports = { runLiveDeltaSync };
