'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_CORE_DB_PATH = 'd:/Master system 1/data/core.db';
const DEFAULT_CW_DB_PATH = 'd:/Master system 1/data/workshops/CW.db';
const DEFAULT_MTR_DB_PATH = 'd:/Master system 1/data/workshops/MTR.db';
const DEFAULT_MERGED_DB_PATH = path.join(__dirname, '..', 'data', 'workshopone_merged.db');
const DEFAULT_SRC_OUTSOURCING_DIR = 'd:/Master system 1/data/outsourcing';
const DEFAULT_DST_OUTSOURCING_DIR = path.join(__dirname, '..', 'data', 'outsourcing');

const JOB_CHILD_TABLES = new Set([
  'job_parts',
  'job_costs',
  'job_labour',
  'job_approvals',
  'job_reopens',
  'job_reopen_requests',
]);

const PARITY_TABLES = [
  { source: 'core.db', dbKey: 'core', table: 'assets', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'fuel_issues', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'fuel_requests', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'fleet_bills', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'fuel_bulk_deliveries', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'fuel_tank_dips', key: 'id' },
  { source: 'core.db', dbKey: 'core', table: 'vehicle_documents', key: 'id' },

  { source: 'CW.db', dbKey: 'cw', table: 'job_cards', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'job_requests', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'job_daily_work', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'job_parts', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'service_jobs', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'mrn', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'mrn_lines', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'grn', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'issues', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'min_notes', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'mtn', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'general_item_txns', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'tyre_battery_issues', key: 'id' },
  { source: 'CW.db', dbKey: 'cw', table: 'outsourcing_requests', key: 'id' },

  { source: 'MTR.db', dbKey: 'mtr', table: 'mtn', key: 'mtn_no' },
  { source: 'MTR.db', dbKey: 'mtr', table: 'job_cards', key: 'job_no' },
  { source: 'MTR.db', dbKey: 'mtr', table: 'job_requests', key: 'jr_no', fallbackKey: 'req_no' },
];

function resolvePaths(opts = {}) {
  return {
    corePath: opts.corePath || process.env.LEGACY_CORE_DB_PATH || DEFAULT_CORE_DB_PATH,
    cwPath: opts.cwPath || process.env.LEGACY_CW_DB_PATH || DEFAULT_CW_DB_PATH,
    mtrPath: opts.mtrPath || process.env.LEGACY_MTR_DB_PATH || DEFAULT_MTR_DB_PATH,
    mergedPath: opts.mergedPath || process.env.DB_PATH || DEFAULT_MERGED_DB_PATH,
    srcOutsourcingDir: opts.srcOutsourcingDir || DEFAULT_SRC_OUTSOURCING_DIR,
    dstOutsourcingDir: opts.dstOutsourcingDir || DEFAULT_DST_OUTSOURCING_DIR,
  };
}

function openReadonlyIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return new Database(filePath, { readonly: true });
}

function hasTable(db, table) {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function getCols(db, table) {
  if (!hasTable(db, table)) return [];
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

function getPkType(db, table) {
  if (!hasTable(db, table)) return null;
  const pk = db.prepare(`PRAGMA table_info("${table}")`).all().find((c) => c.pk);
  return pk ? pk.type : null;
}

function getRowCount(db, table) {
  if (!hasTable(db, table)) return 0;
  const r = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get();
  return r ? Number(r.c) || 0 : 0;
}

function isSyntheticTestRow(table, row, syntheticJobIds = new Set()) {
  if (!row) return false;

  if (table === 'job_cards') {
    const jno = String(row.job_no || '').trim();
    const dt = String(row.requested_at || row.date_in || '').slice(0, 10);
    const txt = `${row.description || ''} ${row.work_desc || ''} ${row.reported_fault || ''}`;
    return (
      /^(DC\/TEST\/|TEST\/R\/|JC-TEST-)/i.test(jno) ||
      dt === '2099-11-15' ||
      /Test Mechanic 01|TEST JOB|Test Daily Cost/i.test(txt)
    );
  }

  if (table === 'job_requests') {
    const jr = String(row.jr_no || row.req_no || '').trim();
    const desc = String(row.description || '').trim();
    return /^JR-TEST-/i.test(jr) || /^fewwfw$/i.test(desc);
  }

  if (table === 'job_daily_work') {
    const dt = String(row.work_date || '').slice(0, 10);
    const txt = `${row.mechanic || row.mechanic_name || ''} ${row.description || row.work_done || ''}`;
    const hasSynJob = row.job_id != null && (syntheticJobIds.has(row.job_id) || syntheticJobIds.has(Number(row.job_id)));
    return dt === '2099-11-15' || /Test Mechanic 01/i.test(txt) || hasSynJob;
  }

  if (table === 'issues') {
    const desc = String(row.description || '').trim();
    const minNo = String(row.min_no || '').trim();
    const hasSynJob = row.job_id != null && (syntheticJobIds.has(row.job_id) || syntheticJobIds.has(Number(row.job_id)));
    return /^Test Brake Shoe$/i.test(desc) || /^TEST[-/]/i.test(minNo) || hasSynJob;
  }

  if (JOB_CHILD_TABLES.has(table)) {
    return row.job_id != null && (syntheticJobIds.has(row.job_id) || syntheticJobIds.has(Number(row.job_id)));
  }

  return false;
}

function collectSyntheticJobIds(srcDb) {
  const ids = new Set();
  if (!srcDb || !hasTable(srcDb, 'job_cards')) return ids;
  const rows = srcDb.prepare('SELECT * FROM "job_cards"').all();
  for (const r of rows) {
    if (isSyntheticTestRow('job_cards', r) && r.id != null) {
      ids.add(r.id);
      if (Number.isFinite(Number(r.id))) ids.add(Number(r.id));
    }
  }
  return ids;
}

function getCutoverParityReport(opts = {}) {
  const paths = resolvePaths(opts);
  const dbs = {};
  let mergedDb = null;

  try {
    dbs.core = openReadonlyIfExists(paths.corePath);
    dbs.cw = openReadonlyIfExists(paths.cwPath);
    dbs.mtr = openReadonlyIfExists(paths.mtrPath);
    mergedDb = openReadonlyIfExists(paths.mergedPath);

    const synBySource = {
      core: new Set(),
      cw: collectSyntheticJobIds(dbs.cw),
      mtr: collectSyntheticJobIds(dbs.mtr),
    };

    const tables = [];
    let realMissingTotal = 0;
    let syntheticTestIgnoredTotal = 0;

    for (const spec of PARITY_TABLES) {
      const srcDb = dbs[spec.dbKey];
      if (!srcDb || !hasTable(srcDb, spec.table)) continue;

      const srcCols = new Set(getCols(srcDb, spec.table));
      const keyCol = srcCols.has(spec.key)
        ? spec.key
        : (spec.fallbackKey && srcCols.has(spec.fallbackKey) ? spec.fallbackKey : null);
      if (!keyCol) continue;

      const srcRows = srcDb.prepare(`SELECT * FROM "${spec.table}"`).all();
      const sourceCount = srcRows.length;

      let mergedCount = 0;
      const mergedKeys = new Set();
      if (mergedDb && hasTable(mergedDb, spec.table)) {
        mergedCount = getRowCount(mergedDb, spec.table);
        const dstCols = new Set(getCols(mergedDb, spec.table));
        const dstKeyCol = dstCols.has(keyCol)
          ? keyCol
          : (spec.fallbackKey && dstCols.has(spec.fallbackKey) ? spec.fallbackKey : null);
        if (dstKeyCol) {
          const dstRows = mergedDb.prepare(`SELECT "${dstKeyCol}" AS k FROM "${spec.table}" WHERE "${dstKeyCol}" IS NOT NULL`).all();
          for (const dr of dstRows) {
            mergedKeys.add(String(dr.k).trim());
          }
        }
      }

      const synJobIds = synBySource[spec.dbKey] || new Set();
      let missingRealCount = 0;
      let syntheticIgnoredCount = 0;
      const missingSampleIds = [];

      for (const row of srcRows) {
        const rawKey = row[keyCol];
        const normKey = rawKey != null ? String(rawKey).trim() : null;
        if (normKey !== null && mergedKeys.has(normKey)) continue;

        if (isSyntheticTestRow(spec.table, row, synJobIds)) {
          syntheticIgnoredCount++;
        } else {
          missingRealCount++;
          if (missingSampleIds.length < 5) missingSampleIds.push(normKey !== null ? normKey : '(null)');
        }
      }

      realMissingTotal += missingRealCount;
      syntheticTestIgnoredTotal += syntheticIgnoredCount;

      tables.push({
        source: spec.source,
        table: spec.table,
        matchKey: keyCol,
        sourceCount,
        mergedCount,
        mergedAheadBy: Math.max(0, mergedCount - sourceCount),
        missingRealCount,
        syntheticTestIgnoredCount: syntheticIgnoredCount,
        missingSampleIds,
        status: missingRealCount === 0 ? 'SYNCED' : 'MISSING_IN_1949',
      });
    }

    return {
      checkedAt: new Date().toISOString(),
      readyForCutover: realMissingTotal === 0,
      realMissingTotal,
      syntheticTestIgnoredTotal,
      sourceExists: {
        core: Boolean(dbs.core),
        cw: Boolean(dbs.cw),
        mtr: Boolean(dbs.mtr),
      },
      tables,
    };
  } finally {
    try { if (dbs.core) dbs.core.close(); } catch (_) {}
    try { if (dbs.cw) dbs.cw.close(); } catch (_) {}
    try { if (dbs.mtr) dbs.mtr.close(); } catch (_) {}
    try { if (mergedDb) mergedDb.close(); } catch (_) {}
  }
}

function runLiveDeltaSync(opts = {}) {
  const quiet = !!opts.quiet;
  const log = (...args) => { if (!quiet) console.log(...args); };

  if (opts.dryRun) {
    return { dryRun: true, parity: getCutoverParityReport(opts) };
  }

  const paths = resolvePaths(opts);
  const hasAnySource = fs.existsSync(paths.corePath) || fs.existsSync(paths.cwPath) || fs.existsSync(paths.mtrPath);
  if (!hasAnySource) {
    return {
      skipped: true,
      reason: 'Legacy :1929 source databases not found',
      tablesSynced: 0,
      rowsSynced: 0,
      rowsInserted: 0,
      rowsSkippedExisting: 0,
      syntheticRowsSkipped: 0,
      filesCopied: 0,
      protectedTablesSkipped: [],
    };
  }

  log('Opening source databases in STRICT READ-ONLY mode...');
  let coreDb = null;
  let cwDb = null;
  let mtrDb = null;
  let mergedDb = null;

  const stats = {
    tablesSynced: 0,
    rowsSynced: 0,
    rowsInserted: 0,
    rowsSkippedExisting: 0,
    syntheticRowsSkipped: 0,
    filesCopied: 0,
    protectedTablesSkipped: [],
  };

  try {
    coreDb = openReadonlyIfExists(paths.corePath);
    cwDb = openReadonlyIfExists(paths.cwPath);
    mtrDb = openReadonlyIfExists(paths.mtrPath);

    log('Opening target merged database:', paths.mergedPath);
    mergedDb = new Database(paths.mergedPath);
    mergedDb.pragma('journal_mode = WAL');
    mergedDb.pragma('foreign_keys = OFF');

    const cwSyntheticJobIds = collectSyntheticJobIds(cwDb);

    function recreateTableIfEmpty(srcDb, table) {
      if (!srcDb || !hasTable(srcDb, table)) return;
      if (hasTable(mergedDb, table) && getRowCount(mergedDb, table) > 0) return;
      const ddl = srcDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (ddl && ddl.sql) {
        mergedDb.exec(`DROP TABLE IF EXISTS "${table}"`);
        mergedDb.exec(ddl.sql);
        log(`  [+] Initialized table from source DDL: ${table}`);
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

    function syncTable(srcDb, srcLabel, table, synJobIds = new Set()) {
      if (!srcDb || !hasTable(srcDb, table)) return 0;
      ensureTableFromSource(srcDb, table);

      const srcCols = getCols(srcDb, table);
      const dstCols = new Set(getCols(mergedDb, table));
      const commonCols = srcCols.filter((c) => dstCols.has(c));
      if (!commonCols.length) return 0;

      const rows = srcDb.prepare(`SELECT ${commonCols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all();
      if (!rows.length) return 0;

      const filteredRows = [];
      for (const r of rows) {
        if (isSyntheticTestRow(table, r, synJobIds)) {
          stats.syntheticRowsSkipped++;
        } else {
          filteredRows.push(r);
        }
      }
      if (!filteredRows.length) return 0;

      const colList = commonCols.map((c) => `"${c}"`).join(', ');
      const placeholders = commonCols.map((c) => `@${c}`).join(', ');
      const insertStmt = mergedDb.prepare(`INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${placeholders})`);

      let inserted = 0;
      let skippedExisting = 0;
      const tx = mergedDb.transaction((items) => {
        for (const r of items) {
          const info = insertStmt.run(r);
          if (info.changes > 0) inserted++;
          else skippedExisting++;
        }
      });
      tx(filteredRows);

      stats.rowsInserted += inserted;
      stats.rowsSynced += inserted;
      stats.rowsSkippedExisting += skippedExisting;
      if (inserted > 0) stats.tablesSynced++;
      log(`  [✓] ${srcLabel}.${table}: inserted ${inserted}, preserved ${skippedExisting}`);
      return inserted;
    }

    // 1. Ensure fuel_requests, fuel_issues, and fuel_prices (never DROP non-empty target tables)
    if (coreDb) {
      log('\n--- Step 1: Syncing fuel_requests, fuel_issues, and fuel_prices (INSERT OR IGNORE) ---');
      if (!hasTable(mergedDb, 'fuel_requests') || (getRowCount(mergedDb, 'fuel_requests') === 0 && getPkType(mergedDb, 'fuel_requests') !== 'TEXT')) {
        recreateTableIfEmpty(coreDb, 'fuel_requests');
      }
      syncTable(coreDb, 'core.db', 'fuel_requests');

      if (!hasTable(mergedDb, 'fuel_issues') || (getRowCount(mergedDb, 'fuel_issues') === 0 && getPkType(mergedDb, 'fuel_issues') !== 'TEXT')) {
        recreateTableIfEmpty(coreDb, 'fuel_issues');
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
        ['price_per_litre_cents', ' INTEGER DEFAULT 0'],
      ];
      for (const [colName, colDef] of fuelIssueAliasCols) {
        if (!existingFuelIssueCols.has(colName)) {
          mergedDb.exec(`ALTER TABLE fuel_issues ADD COLUMN "${colName}"${colDef}`);
        }
      }
      const fuelIssuesInserted = syncTable(coreDb, 'core.db', 'fuel_issues');
      if (fuelIssuesInserted > 0) {
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
           WHERE fuel_kind IS NULL OR (COALESCE(unit_price, 0) = 0 AND COALESCE(fuel_price_cents, 0) > 0)
        `);
      }

      const existingFuelPriceCols = new Set(getCols(mergedDb, 'fuel_prices'));
      if ((!hasTable(mergedDb, 'fuel_prices') || getRowCount(mergedDb, 'fuel_prices') === 0) && !existingFuelPriceCols.has('fuel_type')) {
        recreateTableIfEmpty(coreDb, 'fuel_prices');
      }
      const updatedFuelPriceCols = new Set(getCols(mergedDb, 'fuel_prices'));
      const fuelPriceAliasCols = [
        ['fuel_kind', " TEXT DEFAULT 'AUTO_DIESEL'"],
        ['price_per_litre', ' REAL DEFAULT 0'],
        ['end_date', ' TEXT'],
        ['source', " TEXT DEFAULT 'Ceypetco'"],
        ['entered_by', ' INTEGER'],
      ];
      for (const [colName, colDef] of fuelPriceAliasCols) {
        if (!updatedFuelPriceCols.has(colName)) {
          mergedDb.exec(`ALTER TABLE fuel_prices ADD COLUMN "${colName}"${colDef}`);
        }
      }
      const fuelPricesInserted = syncTable(coreDb, 'core.db', 'fuel_prices');
      if (fuelPricesInserted > 0) {
        mergedDb.exec(`
          UPDATE fuel_prices
             SET fuel_kind = COALESCE(fuel_type, 'AUTO_DIESEL'),
                 price_per_litre = ROUND(COALESCE(price_per_litre_cents, 0) / 100.0, 2),
                 entered_by = COALESCE(created_by, entered_by),
                 source = COALESCE(notes, source, 'Ceypetco')
           WHERE fuel_kind IS NULL OR (COALESCE(price_per_litre, 0) = 0 AND COALESCE(price_per_litre_cents, 0) > 0)
        `);
      }

      // 2. Sync Fuel & Fleet Master Tables from core.db (non-destructive INSERT OR IGNORE)
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
        'workshops',
      ];
      for (const t of coreTables) {
        syncTable(coreDb, 'core.db', t);
      }
    }

    // 3. Sync Workshop, Store, KPI & C.COM Outsourcing tables from CW.db (excluding synthetic test rows & :1949-mastered rollups)
    if (cwDb) {
      log('\n--- Step 3: Syncing Workshop, C.COM Outsourcing & Store Tables from CW.db ---');
      stats.protectedTablesSkipped.push('vehicle_monthly_costs');
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
        'workshop_tools',
      ];
      for (const t of cwTables) {
        syncTable(cwDb, 'CW.db', t, cwSyntheticJobIds);
      }
    }

    // 4. Copy missing C.COM Outsourcing PDF attachments (never overwrite existing files)
    log('\n--- Step 4: Copying Missing C.COM Outsourcing PDFs ---');
    if (paths.srcOutsourcingDir && fs.existsSync(paths.srcOutsourcingDir)) {
      fs.mkdirSync(paths.dstOutsourcingDir, { recursive: true });
      for (const f of fs.readdirSync(paths.srcOutsourcingDir)) {
        const srcFile = path.join(paths.srcOutsourcingDir, f);
        const dstFile = path.join(paths.dstOutsourcingDir, f);
        if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
          fs.copyFileSync(srcFile, dstFile);
          stats.filesCopied++;
          log(`  [✓] Copied new outsourcing attachment: ${f}`);
        }
      }
    }

    // 5. Post-sync idempotent guards (tanks, site projects, delivery pricing, allocations)
    try {
      const { deduplicateTanksAndActivateSites } = require('../src/migrate/063_fuel_site_rbac_and_tank_cleanup');
      const cleanupStats = deduplicateTanksAndActivateSites(mergedDb);
      log('  [✓] Verified canonical fuel tanks & active site projects:', cleanupStats);
    } catch (err) {
      log('  [!] Tank dedup post-sync warning:', err.message);
    }

    try {
      const m065 = require('../src/migrate/065_phase3_tanks_allocations_and_delivery_prices');
      const p3Stats = m065.runMigration(mergedDb);
      log('  [✓] Verified Phase 3 tank mapping & delivery prices:', p3Stats);
    } catch (err) {
      log('  [!] Phase 3 post-sync guard warning:', err.message);
    }

    if (!opts.skipHygieneMigration && stats.rowsInserted > 0) {
      try {
        const m066 = require('../src/migrate/066_phase5_ops_and_data_hygiene');
        const p5Stats = m066.runMigration(mergedDb);
        log('  [✓] Applied Phase 5A data hygiene guard:', p5Stats);
      } catch (err) {
        log('  [!] Phase 5A post-sync guard warning:', err.message);
      }
    }

    mergedDb.pragma('foreign_keys = ON');
    log('\n=== NON-DESTRUCTIVE LIVE DELTA SYNC COMPLETE ===', stats);
    return stats;
  } finally {
    try { if (coreDb) coreDb.close(); } catch (_) {}
    try { if (cwDb) cwDb.close(); } catch (_) {}
    try { if (mtrDb) mtrDb.close(); } catch (_) {}
    try { if (mergedDb) mergedDb.close(); } catch (_) {}
  }
}

if (require.main === module) {
  runLiveDeltaSync();
}

module.exports = {
  runLiveDeltaSync,
  getCutoverParityReport,
  isSyntheticTestRow,
};
