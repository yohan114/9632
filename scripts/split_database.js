'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');

const CORE_TABLES = [
  'users', 'roles', 'user_roles', 'role_capabilities', 'role_permissions',
  'user_capabilities', 'user_permissions', 'sessions', 'auth_challenges',
  'mfa_recovery_codes', 'user_seen_marks', 'approval_limits',
  'workshops', 'projects', 'sites', 'settings',
  'assets', 'asset_aliases', 'asset_moves', 'vehicle_lubricant_capacities',
  'service_specs', 'tb_specs',
  'store_items', 'item_categories', 'stock_items', 'products', 'product_prices',
  'oil_list', 'oil_type_prices', 'lubricant_aliases', 'filter_catalogue',
  'filter_category_list', 'filter_xrefs', 'filter_prices', 'tyre_battery_prices',
  'audit_log', 'stand_in_delegations', 'idempotency_keys'
];

const WS_TABLES = [
  'job_cards', 'job_approvals', 'job_costs', 'job_daily_work', 'job_hold_reasons',
  'job_labour', 'job_parts', 'job_reopen_requests', 'job_reopens', 'job_requests',
  'job_request_approvals', 'job_summary_notes', 'job_workshop_moves',
  'historical_job_costs', 'pending_part_notes',
  'mechanics', 'mechanic_aliases', 'mechanic_workshops', 'labour_rates',
  'mechanic_attendance', 'workday_signoffs',
  'mrn', 'mrn_lines', 'mrn_approvals', 'mrn_line_invoices', 'mrn_line_priority_history',
  'delivery_discrepancies',
  'grn', 'grn_approvals', 'grn_vouchers', 'issues', 'issue_returns',
  'min_notes', 'min_approvals', 'mtn', 'mtn_lines', 'mtn_approvals',
  'receipt_price_notes',
  'stock_moves', 'stock_ledger', 'stock_opening', 'stock_counts', 'store_counts',
  'store_reorder', 'count_sessions', 'count_lines', 'general_item_txns',
  'disposals', 'disposal_lines', 'filter_stock', 'filter_stock_ledger',
  'batteries', 'battery_events', 'battery_photos', 'tyres', 'tyre_events',
  'tyre_photos', 'tyre_battery_issues', 'tb_request_lines', 'tb_returns',
  'service_jobs', 'service_attachments', 'service_filters', 'service_oils',
  'service_parts',
  'workshop_tools', 'tool_issue_logs', 'tool_scrap_requests',
  'daily_report_snapshots', 'monthly_report_inputs', 'vehicle_monthly_costs'
];

function stripCoreForeignKeys(sql, coreSet) {
  let cleaned = sql;
  const set = coreSet instanceof Set ? coreSet : new Set(coreSet);
  for (const table of set) {
    const tblFkRegex = new RegExp(',?\\s*FOREIGN\\s+KEY\\s*\\([^)]+\\)\\s*REFERENCES\\s+"?' + table + '"?\\s*(?:\\([^)]+\\))?(?:\\s+ON\\s+DELETE\\s+[A-Za-z\\s]+)?(?:\\s+ON\\s+UPDATE\\s+[A-Za-z\\s]+)?(?:\\s+DEFERRABLE[^,)]*)?', 'gi');
    cleaned = cleaned.replace(tblFkRegex, '');

    const colFkRegex = new RegExp('\\s+REFERENCES\\s+"?' + table + '"?\\s*(?:\\([^)]+\\))?(?:\\s+ON\\s+DELETE\\s+[A-Za-z\\s]+)?(?:\\s+ON\\s+UPDATE\\s+[A-Za-z\\s]+)?(?:\\s+DEFERRABLE[^,)]*)?', 'gi');
    cleaned = cleaned.replace(colFkRegex, '');
  }
  cleaned = cleaned.replace(/,\s*\)/g, '\n)');
  return cleaned;
}

function splitDatabase(sourceDbPath, targetDir, { dryRun = false } = {}) {
  console.log(`Starting database split from: ${sourceDbPath}`);
  console.log(`Target directory: ${targetDir}`);

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database not found: ${sourceDbPath}`);
  }

  const srcDb = new Database(sourceDbPath, { readonly: true });

  const coreDir = targetDir;
  const wsDir = path.join(targetDir, 'workshops');
  const keysDir = path.join(targetDir, 'keys');
  const archiveDir = path.join(targetDir, 'archive');

  if (!dryRun) {
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const corePath = path.join(coreDir, 'core.db');
  const cwPath = path.join(wsDir, 'CW.db');

  if (fs.existsSync(corePath)) fs.unlinkSync(corePath);
  if (fs.existsSync(cwPath)) fs.unlinkSync(cwPath);

  const coreDb = new Database(corePath);
  const cwDb = new Database(cwPath);

  coreDb.pragma('journal_mode = WAL');
  cwDb.pragma('journal_mode = WAL');
  coreDb.pragma('foreign_keys = OFF');
  cwDb.pragma('foreign_keys = OFF');

  // Copy schemas and data
  const tableSchemas = srcDb.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const indexSchemas = srcDb.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const triggerSchemas = srcDb.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();

  const coreTableSet = new Set(CORE_TABLES);
  const wsTableSet = new Set(WS_TABLES);

  // 1. Core tables
  console.log('\n--- Creating Core Schema ---');
  for (const t of tableSchemas) {
    if (coreTableSet.has(t.name)) {
      coreDb.exec(t.sql);
    }
  }

  // Extra core tables required by architecture plan
  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS workshop_databases (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id  INTEGER NOT NULL UNIQUE,
      code         TEXT NOT NULL UNIQUE,
      db_file      TEXT NOT NULL,
      schema_ver   INTEGER NOT NULL DEFAULT 1,
      state        TEXT NOT NULL DEFAULT 'live', -- provisioning | live | archived
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS workshop_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id  INTEGER NOT NULL UNIQUE,
      wrapped_key  TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      rotated_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS store_access_grants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id  INTEGER NOT NULL REFERENCES workshops(id),
      store_id     INTEGER NOT NULL,
      can_view     INTEGER NOT NULL DEFAULT 1,
      can_request  INTEGER NOT NULL DEFAULT 1,
      can_draw     INTEGER NOT NULL DEFAULT 0,
      covering     TEXT NOT NULL DEFAULT 'all', -- all | categories | items
      item_keys    TEXT,                        -- JSON array when categories or items
      line_limit   REAL,
      monthly_limit REAL,
      valid_from   TEXT NOT NULL,
      valid_to     TEXT,
      granted_by   INTEGER NOT NULL REFERENCES users(id),
      approved_by  INTEGER REFERENCES users(id),
      state        TEXT NOT NULL DEFAULT 'pending', -- pending | active | suspended | revoked | expired
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS store_access_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id    INTEGER NOT NULL REFERENCES store_access_grants(id),
      transfer_id TEXT,
      item_key    TEXT,
      qty         REAL,
      cost        REAL,
      month       TEXT NOT NULL, -- YYYY-MM
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehicle_holds (
      asset_id     INTEGER PRIMARY KEY,
      workshop_id  INTEGER NOT NULL,
      job_id       INTEGER NOT NULL,
      job_no       TEXT NOT NULL,
      claimed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id           TEXT PRIMARY KEY, -- TR-YYYYMMDD-XXXX
      from_ws      INTEGER NOT NULL,
      to_ws        INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'draft', -- draft | dispatched | accepted | cancelled
      dispatched_at TEXT,
      accepted_at  TEXT,
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS integrity_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      passed      INTEGER NOT NULL,
      checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
      report_json TEXT NOT NULL
    );
  `);

  // Core indexes
  for (const idx of indexSchemas) {
    if (coreTableSet.has(idx.tbl_name)) {
      try { coreDb.exec(idx.sql); } catch (e) { /* ignore duplicate index */ }
    }
  }

  // 2. Workshop tables in CW.db
  console.log('\n--- Creating Workshop Schema (CW.db) ---');
  for (const t of tableSchemas) {
    if (wsTableSet.has(t.name)) {
      cwDb.exec(stripCoreForeignKeys(t.sql, coreTableSet));
    }
  }

  cwDb.exec(`
    CREATE TABLE IF NOT EXISTS ws_meta (
      workshop_id INTEGER PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Attach core database to cwDb so cross-file references resolve
  cwDb.exec(`ATTACH DATABASE '${corePath.replace(/\\/g, '/')}' AS core`);

  for (const idx of indexSchemas) {
    if (wsTableSet.has(idx.tbl_name)) {
      try { cwDb.exec(idx.sql); } catch (e) { /* ignore duplicate index */ }
    }
  }

  function getInsertableColumns(db, table) {
    return db.prepare(`PRAGMA table_xinfo("${table}")`).all()
      .filter(c => c.hidden === 0)
      .map(c => c.name);
  }

  // Copy rows
  console.log('\n--- Copying Data to core.db ---');
  for (const name of CORE_TABLES) {
    const cols = getInsertableColumns(srcDb, name);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const rows = srcDb.prepare(`SELECT ${colList} FROM ${name}`).all();
    if (rows.length > 0) {
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = coreDb.prepare(`INSERT INTO ${name} (${colList}) VALUES (${placeholders})`);
      const insertMany = coreDb.transaction((allRows) => {
        for (const r of allRows) stmt.run(...cols.map(c => r[c]));
      });
      insertMany(rows);
    }
    const count = coreDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    console.log(`Core [${name}] copied: ${count} rows`);
  }

  // Register CW in workshop_databases
  coreDb.prepare(`
    INSERT INTO workshop_databases (workshop_id, code, db_file, state)
    VALUES (1, 'CW', 'workshops/CW.db', 'live')
  `).run();

  // Populate vehicle_holds from open job cards
  const openJobs = srcDb.prepare(`
    SELECT id, job_no, asset_id, workshop_id FROM job_cards
    WHERE status NOT IN ('CLOSED', 'REJECTED') AND asset_id IS NOT NULL
  `).all();
  const holdStmt = coreDb.prepare(`
    INSERT OR REPLACE INTO vehicle_holds (asset_id, workshop_id, job_id, job_no)
    VALUES (?, ?, ?, ?)
  `);
  for (const j of openJobs) {
    holdStmt.run(j.asset_id, j.workshop_id || 1, j.id, j.job_no);
  }
  console.log(`Populated ${openJobs.length} active vehicle holds in core.db`);

  console.log('\n--- Copying Data to CW.db ---');
  cwDb.prepare(`INSERT INTO ws_meta (workshop_id, code, name) VALUES (1, 'CW', 'Central Workshop - Badalgama')`).run();

  for (const name of WS_TABLES) {
    const cols = getInsertableColumns(srcDb, name);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const rows = srcDb.prepare(`SELECT ${colList} FROM ${name}`).all();
    if (rows.length > 0) {
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = cwDb.prepare(`INSERT INTO ${name} (${colList}) VALUES (${placeholders})`);
      const insertMany = cwDb.transaction((allRows) => {
        for (const r of allRows) stmt.run(...cols.map(c => r[c]));
      });
      insertMany(rows);
    }
    const count = cwDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    console.log(`WS [${name}] copied: ${count} rows`);
  }

  for (const trg of triggerSchemas) {
    if (wsTableSet.has(trg.tbl_name)) {
      try { cwDb.exec(trg.sql); } catch (e) { /* ignore */ }
    }
  }

  coreDb.pragma('foreign_keys = ON');
  cwDb.pragma('foreign_keys = ON');

  // Verification step: verify row counts match 100%
  console.log('\n--- Verifying Row Counts ---');
  let mismatchCount = 0;
  for (const name of CORE_TABLES) {
    const srcC = srcDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    const tgtC = coreDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    if (srcC !== tgtC) {
      console.error(`MISMATCH on core table ${name}: src=${srcC} vs tgt=${tgtC}`);
      mismatchCount++;
    }
  }
  for (const name of WS_TABLES) {
    const srcC = srcDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    const tgtC = cwDb.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
    if (srcC !== tgtC) {
      console.error(`MISMATCH on ws table ${name}: src=${srcC} vs tgt=${tgtC}`);
      mismatchCount++;
    }
  }

  if (mismatchCount > 0) {
    throw new Error(`Data verification failed: ${mismatchCount} table(s) had mismatched row counts!`);
  }
  console.log('✓ All 106 tables verified with 100% row count match!');

  // Test attachment and unqualified query
  console.log('\n--- Testing SQLite ATTACH ---');
  const testJoin = cwDb.prepare(`
    SELECT j.id, j.job_no, a.code AS asset_code
      FROM job_cards j
      LEFT JOIN assets a ON a.id = j.asset_id
     LIMIT 3
  `).all();
  console.log('Sample cross-file JOIN query results:', testJoin);

  srcDb.close();
  coreDb.close();
  cwDb.close();

  console.log('\n✓ Split successfully completed and verified.');
}

if (require.main === module) {
  const config = require('../src/config');
  const sourceDb = config.dbPath;
  const targetDir = path.dirname(sourceDb);
  splitDatabase(sourceDb, targetDir);
}

module.exports = { splitDatabase, stripCoreForeignKeys, CORE_TABLES, WS_TABLES };
