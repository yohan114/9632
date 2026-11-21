'use strict';

/**
 * WorkshopOne Unified VPS Cutover Merger & Reconciliation Tool
 *
 * Safely consolidates live production data from:
 *   1. Live WorkshopOne (single DB `/opt/workshopone/data/workshopone.db` OR split `core.db`/`CW.db`/`MTR.db`)
 *   2. Live Fuel-System-V2 Prisma SQLite DB (`/var/www/fuelsystem/data/app.db`)
 *
 * Strictly opens all source databases in READ-ONLY mode (`readonly: true`).
 * Supports `--build-fresh` (clone live WorkshopOne DB + apply V2 schema migrations + merge live Fuel V2),
 * incremental non-destructive sync with pre-merge SQLite backup, file attachment sync,
 * post-merge cost/pricing rollups (migrations 064/065/066), and `--verify-only` / `--dry-run` parity checks.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const {
  isSyntheticTestRow,
  runLiveDeltaSync,
} = require('./sync_all_live_data');

function collectSyntheticJobIds(srcDb) {
  const ids = new Set();
  if (!srcDb || !hasTable(srcDb, 'job_cards')) return ids;
  for (const r of srcDb.prepare('SELECT * FROM "job_cards"').all()) {
    if (isSyntheticTestRow('job_cards', r) && r.id != null) {
      ids.add(r.id);
      if (Number.isFinite(Number(r.id))) ids.add(Number(r.id));
    }
  }
  return ids;
}

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_CORE_DB = 'd:/Master system 1/data/core.db';
const DEFAULT_CW_DB = 'd:/Master system 1/data/workshops/CW.db';
const DEFAULT_MTR_DB = 'd:/Master system 1/data/workshops/MTR.db';
const DEFAULT_FUEL_DB = 'd:/Master system 1/Fuel-System-V2/data/app.db';
const DEFAULT_TARGET_DB = path.join(ROOT_DIR, 'data', 'workshopone_merged.db');

const FUEL_V2_MANAGED_TARGET_TABLES = new Set([
  'fuel_tanks',
  'fuel_prices',
  'fuel_requests',
  'fuel_issues',
  'fuel_bulk_deliveries',
  'fuel_tank_dips',
  'fuel_corrections',
  'fuel_meter_readings',
  'fuel_daily_conditions',
  'fleet_asset_assignments',
  'fleet_rental_rates',
  'fleet_vehicle_allocations',
  'fleet_bills',
  'fleet_bill_line_items',
  'fleet_bill_revisions',
  'fleet_payments',
  'fleet_credit_notes',
  'site_fuel_budgets',
  'fuel_pm_tasks',
]);

const PROTECTED_TARGET_TABLES = new Set([
  'sessions',
  'user_notification_reads',
  'vehicle_monthly_costs',
  'fleet_financial_events',
]);

const WO_SINGLE_PARITY_TABLES = [
  { table: 'assets', key: 'id' },
  { table: 'projects', key: 'id' },
  { table: 'users', key: 'username' },
  { table: 'job_cards', key: 'id' },
  { table: 'job_requests', key: 'id' },
  { table: 'job_daily_work', key: 'id' },
  { table: 'job_parts', key: 'id' },
  { table: 'service_jobs', key: 'id' },
  { table: 'mrn', key: 'id' },
  { table: 'mrn_lines', key: 'id' },
  { table: 'grn', key: 'id' },
  { table: 'issues', key: 'id' },
  { table: 'min_notes', key: 'id' },
  { table: 'mtn', key: 'id' },
  { table: 'general_item_txns', key: 'id' },
  { table: 'tyre_battery_issues', key: 'id' },
  { table: 'outsourcing_requests', key: 'id' },
  { table: 'vehicle_documents', key: 'id' },
];

const WO_SPLIT_PARITY_TABLES = [
  { dbKey: 'core', source: 'core.db', table: 'assets', key: 'id' },
  { dbKey: 'core', source: 'core.db', table: 'projects', key: 'id' },
  { dbKey: 'core', source: 'core.db', table: 'users', key: 'username' },
  { dbKey: 'core', source: 'core.db', table: 'vehicle_documents', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'job_cards', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'job_requests', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'job_daily_work', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'job_parts', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'service_jobs', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'mrn', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'mrn_lines', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'grn', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'issues', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'min_notes', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'mtn', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'general_item_txns', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'tyre_battery_issues', key: 'id' },
  { dbKey: 'cw', source: 'CW.db', table: 'outsourcing_requests', key: 'id' },
  { dbKey: 'mtr', source: 'MTR.db', table: 'mtn', key: 'mtn_no' },
  { dbKey: 'mtr', source: 'MTR.db', table: 'job_cards', key: 'job_no' },
  { dbKey: 'mtr', source: 'MTR.db', table: 'job_requests', key: 'jr_no', fallbackKey: 'req_no' },
];

function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    woPath: null,
    corePath: null,
    cwPath: null,
    mtrPath: null,
    fuelPath: null,
    targetPath: null,
    woUploadsDir: null,
    woOutsourcingDir: null,
    targetUploadsDir: null,
    targetOutsourcingDir: null,
    buildFresh: false,
    dryRun: false,
    verifyOnly: false,
    syncTankBalances: true,
    skipBackup: false,
    json: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    if (a === '--wo-db') opts.woPath = next();
    else if (a === '--core-db') opts.corePath = next();
    else if (a === '--cw-db') opts.cwPath = next();
    else if (a === '--mtr-db') opts.mtrPath = next();
    else if (a === '--fuel-db') opts.fuelPath = next();
    else if (a === '--target-db') opts.targetPath = next();
    else if (a === '--wo-uploads') opts.woUploadsDir = next();
    else if (a === '--wo-outsourcing') opts.woOutsourcingDir = next();
    else if (a === '--target-uploads') opts.targetUploadsDir = next();
    else if (a === '--target-outsourcing') opts.targetOutsourcingDir = next();
    else if (a === '--build-fresh') opts.buildFresh = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verify-only') opts.verifyOnly = true;
    else if (a === '--no-sync-tank-balances') opts.syncTankBalances = false;
    else if (a === '--skip-backup') opts.skipBackup = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
  }

  return opts;
}

function resolvePaths(opts = {}) {
  const woPath = opts.woPath || process.env.WO_LIVE_DB_PATH || null;
  const targetPath = path.resolve(opts.targetPath || process.env.DB_PATH || DEFAULT_TARGET_DB);
  return {
    woPath: woPath ? path.resolve(woPath) : null,
    corePath: woPath ? null : path.resolve(opts.corePath || process.env.LEGACY_CORE_DB_PATH || DEFAULT_CORE_DB),
    cwPath: woPath ? null : path.resolve(opts.cwPath || process.env.LEGACY_CW_DB_PATH || DEFAULT_CW_DB),
    mtrPath: woPath ? null : path.resolve(opts.mtrPath || process.env.LEGACY_MTR_DB_PATH || DEFAULT_MTR_DB),
    fuelPath: path.resolve(opts.fuelPath || process.env.FUEL_V2_DB_PATH || DEFAULT_FUEL_DB),
    targetPath,
    woUploadsDir: opts.woUploadsDir ? path.resolve(opts.woUploadsDir) : null,
    woOutsourcingDir: opts.woOutsourcingDir ? path.resolve(opts.woOutsourcingDir) : null,
    targetUploadsDir: path.resolve(opts.targetUploadsDir || path.join(path.dirname(targetPath), '..', 'uploads')),
    targetOutsourcingDir: path.resolve(opts.targetOutsourcingDir || path.join(path.dirname(targetPath), 'outsourcing')),
  };
}

function hasTable(db, name) {
  if (!db) return false;
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function getCols(db, table) {
  if (!hasTable(db, table)) return [];
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

function openReadonlyIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

function checkWalWarning(filePath, label, warnings) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const walPath = `${filePath}-wal`;
  if (fs.existsSync(walPath)) {
    const sz = fs.statSync(walPath).size;
    if (sz > 0) {
      warnings.push(
        `Non-empty WAL journal detected for ${label} (${path.basename(walPath)}: ${sz} bytes). Stop the source server before final cutover so all writes are flushed cleanly.`
      );
    }
  }
}

function normDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v).trim())) {
    const rawNum = Number(v);
    if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
    const ms = String(Math.trunc(rawNum)).length <= 10 ? rawNum * 1000 : rawNum;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.slice(0, 19).replace('T', ' ');
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return s.slice(0, 19);
}

function normDate(v) {
  const dt = normDateTime(v);
  return dt ? dt.slice(0, 10) : null;
}

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normCodeNorm(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normTankType(name, rawType) {
  const u = String(rawType || '').trim().toUpperCase();
  if (u === 'FIXED' || u === 'BOWSER' || u === 'BARREL') return u;
  const nm = String(name || '');
  if (/bowser|mobile/i.test(nm)) return 'BOWSER';
  if (/barrel|drum/i.test(nm)) return 'BARREL';
  return 'FIXED';
}

function normMeterType(v) {
  const u = String(v || '').trim().toUpperCase();
  if (u === 'HOURS' || u === 'KM' || u === 'NONE') return u;
  if (u === 'HR' || u === 'HRS' || u === 'H') return 'HOURS';
  return 'HOURS';
}

function normMeterSource(v) {
  const u = String(v || '').trim().toUpperCase();
  if (u === 'MANUAL') return 'MANUAL_ENTRY';
  if (['FUEL_CORRECTION', 'FUEL_ISSUE', 'DAILY_LOG', 'SERVICE', 'MANUAL_ENTRY'].includes(u)) return u;
  return 'FUEL_ISSUE';
}

function normDeliveryStatus(v) {
  const u = String(v || '').trim().toUpperCase();
  if (u === 'APPROVED' || u === 'DELIVERED') return 'DELIVERED';
  if (u === 'REJECTED' || u === 'CANCELLED') return 'CANCELLED';
  if (u === 'ORDERED') return 'ORDERED';
  return 'REQUESTED';
}

function normCorrectionType(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['EDIT', 'RATE', 'LITRES', 'METER', 'VEHICLE', 'PROJECT', 'VOID', 'OTHER'].includes(u)) return u;
  return 'OTHER';
}

function normCorrectionStatus(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['PENDING', 'APPROVED', 'REJECTED'].includes(u)) return u;
  return 'PENDING';
}

function normRequestStatus(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED'].includes(u)) return u;
  return 'PENDING';
}

function normConditionStatus(v) {
  const u = String(v || '').trim().toUpperCase();
  if (u === 'MAINTENANCE') return 'UNDER_MAINTENANCE';
  if (['WORKING', 'IDLE', 'BREAKDOWN', 'UNDER_MAINTENANCE'].includes(u)) return u;
  return 'WORKING';
}

function normBillingType(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['DRY_WITH_DRIVER', 'DRY', 'WET', 'FULLY_WET', 'FUEL_ONLY', 'BILLED_DIRECT', 'FREE_OF_CHARGE'].includes(u)) {
    return u;
  }
  return 'DRY';
}

function normRentalRateBasis(r) {
  if (r.hrWCents || r.hrDCents || r.hrFwCents) return 'HOURLY';
  if (r.dyWCents || r.dyDCents || r.dyFwCents) return 'DAILY';
  if (r.kmWCents || r.kmDCents || r.kmFwCents) return 'KM';
  const b = String(r.defaultBasis || '').trim().toUpperCase();
  if (b === 'KM') return 'KM';
  if (b === 'D' || b === 'DY' || b === 'DAILY') return 'DAILY';
  return 'DAILY';
}

function normBillStatus(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FINAL', 'ISSUED', 'PAID', 'VOID', 'REVISED'].includes(u)) {
    return u;
  }
  return 'DRAFT';
}

function normLineItemType(v) {
  const u = String(v || '').trim().toUpperCase();
  if (['RENTAL', 'FUEL', 'BREAKDOWN_DEDUCT', 'OPERATOR', 'TRANSPORT', 'OTHER'].includes(u)) return u;
  return 'OTHER';
}

function normAssetClass(typeLabel) {
  const t = String(typeLabel || '');
  if (/gen/i.test(t)) return 'generator';
  if (/excav|loader|jcb|backhoe|dozer|grader|roller|crane|paver|compactor|crawler/i.test(t)) return 'plant';
  if (/machine|weld|compress|lathe|mixer/i.test(t)) return 'machine';
  return 'vehicle';
}

function normAssetStatus(s) {
  const u = String(s || '').trim().toUpperCase();
  if (['INACTIVE', 'SCRAPPED', 'SOLD', 'DECOMMISSIONED'].includes(u)) return 'decommissioned';
  if (['MAINTENANCE', 'BREAKDOWN', 'UNDER_REPAIR', 'REPAIR'].includes(u)) return 'under_repair';
  if (u === 'IDLE') return 'idle';
  return 'active';
}

function buildFilteredInserter(targetDb, table, mode = 'INSERT OR IGNORE') {
  const colList = getCols(targetDb, table);
  const colSet = new Set(colList);
  return {
    colSet,
    run(row) {
      const keys = Object.keys(row).filter((k) => colSet.has(k) && row[k] !== undefined);
      if (!keys.length) return { changes: 0 };
      const colsSql = keys.map((k) => `"${k}"`).join(', ');
      const valsSql = keys.map((k) => `@${k}`).join(', ');
      const sql = `${mode} INTO "${table}" (${colsSql}) VALUES (${valsSql})`;
      const payload = {};
      for (const k of keys) payload[k] = row[k];
      return targetDb.prepare(sql).run(payload);
    },
  };
}

function syncMissingFiles(srcDir, dstDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copied += syncMissingFiles(srcPath, dstPath);
    } else if (entry.isFile() && !fs.existsSync(dstPath)) {
      fs.copyFileSync(srcPath, dstPath);
      copied++;
    }
  }
  return copied;
}

function removeStaleSqliteSidecars(dbPath) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch {}
  }
}

function runIsolatedMigrations(targetPath) {
  execFileSync(
    process.execPath,
    ['-e', "const d = require('./src/db'); d.migrate(); try { d.db.close(); } catch {} process.exit(0);"],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_PATH: targetPath,
        MULTIDB: '0',
        BACKUP_INTERVAL_MINUTES: '0',
      },
      stdio: 'pipe',
    }
  );
}

function billShouldSyncFromFuel(src, dst) {
  if (!dst) return true;
  const srcStatus = normBillStatus(src.status);
  const dstStatus = normBillStatus(dst.status);
  const dstIsFinalized = ['FINAL', 'ISSUED', 'PAID'].includes(dstStatus);
  const srcIsDraft = srcStatus === 'DRAFT';
  const srcUpdated = normDateTime(src.updatedAt) || '';
  const dstUpdated = dst.updated_at || '';

  // Never downgrade a bill that was already finalized in WorkshopOne while Fuel still holds an older DRAFT
  if (dstIsFinalized && srcIsDraft && dstUpdated >= srcUpdated) return false;

  if (srcStatus !== dstStatus) return true;
  if (Number(src.grandTotalCents || 0) !== Number(dst.grand_total_cents || 0)) return true;
  if (Number(src.paidAmountCents || 0) !== Number(dst.paid_amount_cents || 0)) return true;
  if (srcUpdated && srcUpdated > dstUpdated) return true;
  return false;
}

function resolveMappingsReadonly(fuelDb, targetDb) {
  const projectMap = new Map(); // Fuel Project.id -> merged projects.id
  const assetMap = new Map();   // Fuel Asset.id -> merged asset row
  const tankMap = new Map();    // Fuel BulkTank.id -> merged tank row

  const existingMaps = hasTable(targetDb, 'fleet_identity_mappings')
    ? targetDb.prepare("SELECT entity_type, source_id, target_id FROM fleet_identity_mappings WHERE source_system = 'fuel_v2'").all()
    : [];
  const projBySrc = new Map();
  const assetBySrc = new Map();
  const tankBySrc = new Map();
  for (const m of existingMaps) {
    if (m.entity_type === 'PROJECT') projBySrc.set(String(m.source_id), Number(m.target_id));
    else if (m.entity_type === 'ASSET') assetBySrc.set(String(m.source_id), Number(m.target_id));
    else if (m.entity_type === 'TANK') tankBySrc.set(String(m.source_id), String(m.target_id));
  }

  const targetProjects = hasTable(targetDb, 'projects')
    ? targetDb.prepare('SELECT id, code, name FROM projects').all()
    : [];
  const pById = new Map(targetProjects.map((p) => [Number(p.id), p]));
  const pByCode = new Map();
  const pByName = new Map();
  for (const p of targetProjects) {
    if (p.code) pByCode.set(p.code.trim().toUpperCase(), p.id);
    if (p.name) pByName.set(p.name.trim().toUpperCase(), p.id);
  }

  if (fuelDb && hasTable(fuelDb, 'Project')) {
    for (const fp of fuelDb.prepare('SELECT * FROM "Project"').all()) {
      let mid = projBySrc.get(String(fp.id));
      if (!mid || !pById.has(mid)) {
        const c = fp.code ? fp.code.trim().toUpperCase() : '';
        const n = fp.name ? fp.name.trim().toUpperCase() : '';
        mid = (c && pByCode.get(c)) || (n && pByName.get(n)) || null;
      }
      if (mid && pById.has(mid)) projectMap.set(fp.id, pById.get(mid));
    }
  }

  const targetAssets = hasTable(targetDb, 'assets')
    ? targetDb.prepare('SELECT id, code, code_norm, registration FROM assets').all()
    : [];
  const aById = new Map(targetAssets.map((a) => [Number(a.id), a]));
  const aByCode = new Map();
  const aByNorm = new Map();
  const aByReg = new Map();
  for (const a of targetAssets) {
    if (a.code) aByCode.set(a.code.trim().toUpperCase(), a.id);
    if (a.code_norm) aByNorm.set(a.code_norm.trim().toUpperCase(), a.id);
    if (a.registration) aByReg.set(normCodeNorm(a.registration), a.id);
  }
  const aliasByNorm = new Map();
  if (hasTable(targetDb, 'asset_aliases')) {
    for (const al of targetDb.prepare('SELECT raw_norm, raw_text, asset_id FROM asset_aliases WHERE resolved = 1 AND asset_id IS NOT NULL').all()) {
      const k = normCodeNorm(al.raw_norm || al.raw_text);
      if (k && !aliasByNorm.has(k)) aliasByNorm.set(k, Number(al.asset_id));
    }
  }

  if (fuelDb && hasTable(fuelDb, 'Asset')) {
    for (const fa of fuelDb.prepare('SELECT * FROM "Asset"').all()) {
      let mid = assetBySrc.get(String(fa.id));
      if (!mid || !aById.has(mid)) {
        const c = fa.code ? fa.code.trim().toUpperCase() : '';
        const cNorm = normCodeNorm(fa.code);
        const rNorm = normCodeNorm(fa.regNo);
        mid = (c && aByCode.get(c))
          || (cNorm && aByNorm.get(cNorm))
          || (rNorm && aByReg.get(rNorm))
          || (rNorm && aByNorm.get(rNorm))
          || (cNorm && aliasByNorm.get(cNorm))
          || null;
      }
      if (mid && aById.has(mid)) assetMap.set(fa.id, aById.get(mid));
    }
  }

  const targetTanks = hasTable(targetDb, 'fuel_tanks')
    ? targetDb.prepare('SELECT id, code, name, current_litres, capacity_litres FROM fuel_tanks').all()
    : [];
  const tById = new Map(targetTanks.map((t) => [String(t.id), t]));
  const tByName = new Map();
  for (const t of targetTanks) {
    if (t.name) tByName.set(t.name.trim().toLowerCase(), t);
  }

  if (fuelDb && hasTable(fuelDb, 'BulkTank')) {
    for (const ft of fuelDb.prepare('SELECT * FROM "BulkTank"').all()) {
      const mappedId = tankBySrc.get(String(ft.id));
      const hit = (mappedId && tById.get(mappedId))
        || tById.get(String(ft.id))
        || (ft.name && tByName.get(ft.name.trim().toLowerCase()))
        || null;
      if (hit) tankMap.set(ft.id, hit);
    }
  }

  return { projectMap, assetMap, tankMap };
}

function getVpsCutoverParityReport(opts = {}) {
  const paths = resolvePaths(opts);
  const warnings = [];
  const syncTankBalances = opts.syncTankBalances !== false;

  let woDb = null;
  let coreDb = null;
  let cwDb = null;
  let mtrDb = null;
  let fuelDb = null;
  let targetDb = null;

  try {
    if (paths.woPath) {
      checkWalWarning(paths.woPath, 'WorkshopOne live DB', warnings);
      woDb = openReadonlyIfExists(paths.woPath);
    } else {
      checkWalWarning(paths.corePath, 'core.db', warnings);
      checkWalWarning(paths.cwPath, 'CW.db', warnings);
      checkWalWarning(paths.mtrPath, 'MTR.db', warnings);
      coreDb = openReadonlyIfExists(paths.corePath);
      cwDb = openReadonlyIfExists(paths.cwPath);
      mtrDb = openReadonlyIfExists(paths.mtrPath);
    }
    if (paths.fuelPath && fs.existsSync(paths.fuelPath)) {
      checkWalWarning(paths.fuelPath, 'Fuel-System-V2 app.db', warnings);
      fuelDb = openReadonlyIfExists(paths.fuelPath);
    }
    targetDb = openReadonlyIfExists(paths.targetPath);

    // 1. WorkshopOne parity
    const woTables = [];
    let woRealMissingTotal = 0;
    let woSyntheticIgnoredTotal = 0;

    if (!targetDb) {
      warnings.push(`Target database not found at ${paths.targetPath}`);
    } else if (woDb) {
      const woSynJobIds = collectSyntheticJobIds(woDb);
      for (const spec of WO_SINGLE_PARITY_TABLES) {
        if (!hasTable(woDb, spec.table)) continue;
        const srcRows = woDb.prepare(`SELECT * FROM "${spec.table}"`).all();
        const dstKeys = new Set(
          hasTable(targetDb, spec.table)
            ? targetDb.prepare(`SELECT "${spec.key}" AS k FROM "${spec.table}"`).all().map((r) => String(r.k))
            : []
        );
        let realSrcCount = 0;
        let synCount = 0;
        let missing = 0;
        for (const r of srcRows) {
          if (isSyntheticTestRow(spec.table, r, woSynJobIds)) {
            synCount++;
            continue;
          }
          realSrcCount++;
          const kVal = r[spec.key];
          if (kVal !== null && kVal !== undefined && !dstKeys.has(String(kVal))) missing++;
        }
        woRealMissingTotal += missing;
        woSyntheticIgnoredTotal += synCount;
        woTables.push({
          source: path.basename(paths.woPath),
          table: spec.table,
          key: spec.key,
          sourceRows: realSrcCount,
          syntheticIgnored: synCount,
          targetRows: hasTable(targetDb, spec.table) ? targetDb.prepare(`SELECT COUNT(*) AS c FROM "${spec.table}"`).get().c : 0,
          missingInTarget: missing,
        });
      }
    } else {
      const splitDbs = { core: coreDb, cw: cwDb, mtr: mtrDb };
      const synByDb = {
        core: new Set(),
        cw: collectSyntheticJobIds(cwDb),
        mtr: collectSyntheticJobIds(mtrDb),
      };
      for (const spec of WO_SPLIT_PARITY_TABLES) {
        const sdb = splitDbs[spec.dbKey];
        if (!sdb || !hasTable(sdb, spec.table)) continue;
        const srcRows = sdb.prepare(`SELECT * FROM "${spec.table}"`).all();
        const dstKeys = new Set();
        if (hasTable(targetDb, spec.table)) {
          for (const r of targetDb.prepare(`SELECT "${spec.key}" AS k FROM "${spec.table}"`).all()) {
            if (r.k !== null && r.k !== undefined && r.k !== '') dstKeys.add(String(r.k));
          }
          if (spec.fallbackKey && getCols(targetDb, spec.table).includes(spec.fallbackKey)) {
            for (const r of targetDb.prepare(`SELECT "${spec.fallbackKey}" AS k FROM "${spec.table}"`).all()) {
              if (r.k !== null && r.k !== undefined && r.k !== '') dstKeys.add(String(r.k));
            }
          }
        }
        let realSrcCount = 0;
        let synCount = 0;
        let missing = 0;
        for (const r of srcRows) {
          if (isSyntheticTestRow(spec.table, r, synByDb[spec.dbKey])) {
            synCount++;
            continue;
          }
          realSrcCount++;
          const kVal = r[spec.key] || (spec.fallbackKey ? r[spec.fallbackKey] : null);
          if (kVal !== null && kVal !== undefined && !dstKeys.has(String(kVal))) missing++;
        }
        woRealMissingTotal += missing;
        woSyntheticIgnoredTotal += synCount;
        woTables.push({
          source: spec.source,
          table: spec.table,
          key: spec.key,
          sourceRows: realSrcCount,
          syntheticIgnored: synCount,
          targetRows: hasTable(targetDb, spec.table) ? targetDb.prepare(`SELECT COUNT(*) AS c FROM "${spec.table}"`).get().c : 0,
          missingInTarget: missing,
        });
      }
    }

    // 2. Fuel-System-V2 parity & financial reconciliation
    const fuelTables = [];
    let fuelMissingTotal = 0;
    let fuelValueMismatchTotal = 0;
    const reconciliation = {
      fuelIssues: { sourceActive: 0, targetActive: 0, sourceVoided: 0, targetVoided: 0, sourceLitres: 0, targetLitres: 0, sourceCostCents: 0, targetCostCents: 0, litreDrift: 0, costCentsDrift: 0, voidedMismatchCount: 0 },
      bills: { sourceCount: 0, targetCount: 0, sourceGrandTotalCents: 0, targetGrandTotalCents: 0, grandTotalCentsDrift: 0, statusSyncNeeded: 0, targetNewerProtected: 0 },
      tanks: { sourceCount: 0, mappedCount: 0, balanceDriftCount: 0 },
    };

    if (fuelDb && targetDb) {
      const { tankMap } = resolveMappingsReadonly(fuelDb, targetDb);

      // BulkTank check
      if (hasTable(fuelDb, 'BulkTank')) {
        const srcTanks = fuelDb.prepare('SELECT id, name, balance FROM "BulkTank"').all();
        reconciliation.tanks.sourceCount = srcTanks.length;
        let missingTanks = 0;
        for (const st of srcTanks) {
          const hit = tankMap.get(st.id);
          if (!hit) missingTanks++;
          else {
            reconciliation.tanks.mappedCount++;
            if (syncTankBalances && Math.abs((Number(st.balance) || 0) - (Number(hit.current_litres) || 0)) > 0.05) {
              reconciliation.tanks.balanceDriftCount++;
            }
          }
        }
        fuelMissingTotal += missingTanks;
        if (syncTankBalances) fuelValueMismatchTotal += reconciliation.tanks.balanceDriftCount;
        fuelTables.push({ source: 'app.db', srcTable: 'BulkTank', dstTable: 'fuel_tanks', sourceRows: srcTanks.length, missingInTarget: missingTanks, valueDrift: syncTankBalances ? reconciliation.tanks.balanceDriftCount : 0 });
      }

      // FuelPrice natural key check
      if (hasTable(fuelDb, 'FuelPrice')) {
        const srcPrices = fuelDb.prepare('SELECT fuelKind, pricePerLitre, effectiveFrom FROM "FuelPrice"').all();
        const dstPrices = hasTable(targetDb, 'fuel_prices')
          ? targetDb.prepare('SELECT COALESCE(fuel_type, fuel_kind) AS fk, effective_date, price_per_litre_cents FROM fuel_prices').all()
          : [];
        const dstPriceSet = new Set(dstPrices.map((p) => `${p.fk}|${p.effective_date}|${p.price_per_litre_cents}`));
        let missing = 0;
        for (const sp of srcPrices) {
          const key = `${sp.fuelKind}|${normDate(sp.effectiveFrom)}|${Number(sp.pricePerLitre) || 0}`;
          if (!dstPriceSet.has(key)) missing++;
        }
        fuelMissingTotal += missing;
        fuelTables.push({ source: 'app.db', srcTable: 'FuelPrice', dstTable: 'fuel_prices', sourceRows: srcPrices.length, missingInTarget: missing, valueDrift: 0 });
      }

      // FuelIssue deep reconciliation
      if (hasTable(fuelDb, 'FuelIssue')) {
        const srcRows = fuelDb.prepare('SELECT id, litres, totalCost, voided FROM "FuelIssue"').all();
        const dstById = new Map(
          hasTable(targetDb, 'fuel_issues')
            ? targetDb.prepare('SELECT id, litres, total_cost_cents, is_voided FROM fuel_issues').all().map((r) => [r.id, r])
            : []
        );
        let missing = 0;
        for (const r of srcRows) {
          const srcVoid = r.voided ? 1 : 0;
          if (srcVoid) reconciliation.fuelIssues.sourceVoided++;
          else {
            reconciliation.fuelIssues.sourceActive++;
            reconciliation.fuelIssues.sourceLitres += Number(r.litres) || 0;
            reconciliation.fuelIssues.sourceCostCents += Number(r.totalCost) || 0;
          }
          const d = dstById.get(r.id);
          if (!d) { missing++; continue; }
          const dstVoid = d.is_voided ? 1 : 0;
          if (dstVoid) reconciliation.fuelIssues.targetVoided++;
          else {
            reconciliation.fuelIssues.targetActive++;
            reconciliation.fuelIssues.targetLitres += Number(d.litres) || 0;
            reconciliation.fuelIssues.targetCostCents += Number(d.total_cost_cents) || 0;
          }
          if (srcVoid !== dstVoid) reconciliation.fuelIssues.voidedMismatchCount++;
        }
        reconciliation.fuelIssues.sourceLitres = Math.round(reconciliation.fuelIssues.sourceLitres * 1000) / 1000;
        reconciliation.fuelIssues.targetLitres = Math.round(reconciliation.fuelIssues.targetLitres * 1000) / 1000;
        reconciliation.fuelIssues.litreDrift = Math.round(Math.abs(reconciliation.fuelIssues.sourceLitres - reconciliation.fuelIssues.targetLitres) * 1000) / 1000;
        reconciliation.fuelIssues.costCentsDrift = Math.abs(reconciliation.fuelIssues.sourceCostCents - reconciliation.fuelIssues.targetCostCents);

        const issueValDrift = reconciliation.fuelIssues.voidedMismatchCount
          + (reconciliation.fuelIssues.litreDrift > 0.05 ? 1 : 0)
          + (reconciliation.fuelIssues.costCentsDrift > 0 ? 1 : 0);
        fuelMissingTotal += missing;
        fuelValueMismatchTotal += issueValDrift;
        fuelTables.push({ source: 'app.db', srcTable: 'FuelIssue', dstTable: 'fuel_issues', sourceRows: srcRows.length, missingInTarget: missing, valueDrift: issueValDrift });
      }

      // Bill deep reconciliation
      if (hasTable(fuelDb, 'Bill')) {
        const srcBills = fuelDb.prepare('SELECT id, status, grandTotalCents, paidAmountCents, updatedAt FROM "Bill"').all();
        const dstBills = new Map(
          hasTable(targetDb, 'fleet_bills')
            ? targetDb.prepare('SELECT id, status, grand_total_cents, paid_amount_cents, updated_at FROM fleet_bills').all().map((r) => [r.id, r])
            : []
        );
        reconciliation.bills.sourceCount = srcBills.length;
        let missing = 0;
        for (const b of srcBills) {
          reconciliation.bills.sourceGrandTotalCents += Number(b.grandTotalCents) || 0;
          const d = dstBills.get(b.id);
          if (!d) { missing++; continue; }
          reconciliation.bills.targetCount++;
          reconciliation.bills.targetGrandTotalCents += Number(d.grand_total_cents) || 0;
          if (billShouldSyncFromFuel(b, d)) reconciliation.bills.statusSyncNeeded++;
          else if (normBillStatus(b.status) !== normBillStatus(d.status)) reconciliation.bills.targetNewerProtected++;
        }
        reconciliation.bills.grandTotalCentsDrift = Math.abs(
          reconciliation.bills.sourceGrandTotalCents - reconciliation.bills.targetGrandTotalCents
        );
        const billDrift = reconciliation.bills.statusSyncNeeded + (reconciliation.bills.grandTotalCentsDrift > 0 ? 1 : 0);
        fuelMissingTotal += missing;
        fuelValueMismatchTotal += billDrift;
        fuelTables.push({ source: 'app.db', srcTable: 'Bill', dstTable: 'fleet_bills', sourceRows: srcBills.length, missingInTarget: missing, valueDrift: billDrift });
      }

      // Standard ID-matched Fuel V2 tables
      const stdFuelMappings = [
        ['BulkRequest', 'fuel_bulk_deliveries'],
        ['TankDip', 'fuel_tank_dips'],
        ['FuelIssueCorrection', 'fuel_corrections'],
        ['FuelRequest', 'fuel_requests'],
        ['MeterReading', 'fuel_meter_readings'],
        ['DailyCondition', 'fuel_daily_conditions'],
        ['AssetAssignment', 'fleet_asset_assignments'],
        ['RentalRate', 'fleet_rental_rates'],
        ['VehicleAllocation', 'fleet_vehicle_allocations'],
        ['BillLineItem', 'fleet_bill_line_items'],
        ['BillRevision', 'fleet_bill_revisions'],
        ['Payment', 'fleet_payments'],
        ['CreditNote', 'fleet_credit_notes'],
        ['PMTask', 'fuel_pm_tasks'],
      ];
      for (const [srcT, dstT] of stdFuelMappings) {
        if (!hasTable(fuelDb, srcT)) continue;
        const srcIds = fuelDb.prepare(`SELECT id FROM "${srcT}"`).all().map((r) => String(r.id));
        const dstIds = new Set(
          hasTable(targetDb, dstT)
            ? targetDb.prepare(`SELECT id FROM "${dstT}"`).all().map((r) => String(r.id))
            : []
        );
        let missing = 0;
        for (const id of srcIds) {
          if (!dstIds.has(id)) missing++;
        }
        fuelMissingTotal += missing;
        fuelTables.push({ source: 'app.db', srcTable: srcT, dstTable: dstT, sourceRows: srcIds.length, missingInTarget: missing, valueDrift: 0 });
      }

      // Budget natural key check
      if (hasTable(fuelDb, 'Budget')) {
        const srcBudgets = fuelDb.prepare('SELECT projectId, year, month FROM "Budget"').all();
        const { projectMap } = resolveMappingsReadonly(fuelDb, targetDb);
        const dstSet = new Set(
          hasTable(targetDb, 'site_fuel_budgets')
            ? targetDb.prepare('SELECT project_id, year, month FROM site_fuel_budgets').all().map((r) => `${r.project_id}|${r.year}|${r.month}`)
            : []
        );
        let missing = 0;
        for (const b of srcBudgets) {
          const p = projectMap.get(b.projectId);
          if (!p || !dstSet.has(`${p.id}|${b.year}|${b.month}`)) missing++;
        }
        fuelMissingTotal += missing;
        fuelTables.push({ source: 'app.db', srcTable: 'Budget', dstTable: 'site_fuel_budgets', sourceRows: srcBudgets.length, missingInTarget: missing, valueDrift: 0 });
      }
    }

    const readyForCutover = !!targetDb && woRealMissingTotal === 0 && fuelMissingTotal === 0 && fuelValueMismatchTotal === 0;
    return {
      readyForCutover,
      woRealMissingTotal,
      woSyntheticIgnoredTotal,
      fuelMissingTotal,
      fuelValueMismatchTotal,
      warnings,
      woTables,
      fuelTables,
      reconciliation,
      paths,
    };
  } finally {
    try { if (woDb) woDb.close(); } catch {}
    try { if (coreDb) coreDb.close(); } catch {}
    try { if (cwDb) cwDb.close(); } catch {}
    try { if (mtrDb) mtrDb.close(); } catch {}
    try { if (fuelDb) fuelDb.close(); } catch {}
    try { if (targetDb) targetDb.close(); } catch {}
  }
}

async function createPreMergeBackup(targetPath, quiet) {
  if (!fs.existsSync(targetPath)) return null;
  const backupDir = path.join(path.dirname(targetPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `pre-vps-cutover-${ts}.db`);
  const src = new Database(targetPath, { readonly: true });
  try {
    await src.backup(backupPath);
  } finally {
    src.close();
  }
  if (!quiet) console.log(`  [✓] Pre-merge backup saved: ${backupPath}`);
  return backupPath;
}

function mergeWorkshopSingleDb(woDb, targetDb, hasFuelSource, log) {
  const synJobIds = collectSyntheticJobIds(woDb);
  const tables = woDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  let tablesSynced = 0;
  let rowsInserted = 0;
  let rowsSkippedExisting = 0;
  let syntheticRowsSkipped = 0;

  for (const table of tables) {
    if (PROTECTED_TARGET_TABLES.has(table) || table === '_prisma_migrations') continue;
    if (hasFuelSource && FUEL_V2_MANAGED_TARGET_TABLES.has(table)) continue;

    if (!hasTable(targetDb, table)) {
      const ddl = woDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (ddl && ddl.sql) targetDb.exec(ddl.sql);
    }

    const srcCols = getCols(woDb, table);
    const dstCols = new Set(getCols(targetDb, table));
    const commonCols = srcCols.filter((c) => dstCols.has(c));
    if (!commonCols.length) continue;

    const rows = woDb.prepare(`SELECT ${commonCols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all();
    if (!rows.length) continue;

    const filtered = [];
    for (const r of rows) {
      if (isSyntheticTestRow(table, r, synJobIds)) syntheticRowsSkipped++;
      else filtered.push(r);
    }
    if (!filtered.length) continue;

    const colsSql = commonCols.map((c) => `"${c}"`).join(', ');
    const valsSql = commonCols.map((c) => `@${c}`).join(', ');
    const stmt = targetDb.prepare(`INSERT OR IGNORE INTO "${table}" (${colsSql}) VALUES (${valsSql})`);

    let ins = 0;
    let skip = 0;
    const tx = targetDb.transaction((items) => {
      for (const r of items) {
        const res = stmt.run(r);
        if (res.changes > 0) ins++;
        else skip++;
      }
    });
    tx(filtered);

    rowsInserted += ins;
    rowsSkippedExisting += skip;
    if (ins > 0) tablesSynced++;
  }

  log(`  [✓] WorkshopOne single-DB merge: ${tablesSynced} tables, +${rowsInserted} inserted, ${rowsSkippedExisting} preserved`);
  return { tablesSynced, rowsInserted, rowsSkippedExisting, syntheticRowsSkipped };
}

function mergeFuelV2Db(fuelDb, targetDb, opts, log) {
  const syncTankBalances = opts.syncTankBalances !== false;
  const stats = {
    projectsCreated: 0,
    assetsCreated: 0,
    tanksCreated: 0,
    tanksUpdated: 0,
    pricesUpserted: 0,
    issuesInserted: 0,
    issuesUpdated: 0,
    deliveriesInserted: 0,
    deliveriesUpdated: 0,
    dipsInserted: 0,
    correctionsInserted: 0,
    correctionsUpdated: 0,
    requestsInserted: 0,
    requestsUpdated: 0,
    meterReadingsInserted: 0,
    conditionsInserted: 0,
    assignmentsInserted: 0,
    assignmentsUpdated: 0,
    ratesInserted: 0,
    ratesUpdated: 0,
    allocationsInserted: 0,
    allocationsUpdated: 0,
    billsInserted: 0,
    billsUpdated: 0,
    lineItemsInserted: 0,
    lineItemsUpdated: 0,
    revisionsInserted: 0,
    paymentsInserted: 0,
    creditNotesInserted: 0,
    budgetsUpserted: 0,
    pmTasksInserted: 0,
  };

  // Helper to persist identity mapping
  const saveIdMap = targetDb.prepare(`
    INSERT OR IGNORE INTO fleet_identity_mappings (entity_type, source_system, source_id, target_id, match_method, source_code, target_code)
    VALUES (?, 'fuel_v2', ?, ?, ?, ?, ?)
  `);

  // 1. Resolve Users by username (read-only on target users, never overwrite passwords)
  const userMap = new Map();
  if (hasTable(fuelDb, 'User') && hasTable(targetDb, 'users')) {
    const tUsers = new Map(targetDb.prepare('SELECT id, username FROM users').all().map((u) => [String(u.username || '').trim().toLowerCase(), Number(u.id)]));
    for (const fu of fuelDb.prepare('SELECT id, username FROM "User"').all()) {
      const hit = tUsers.get(String(fu.username || '').trim().toLowerCase());
      if (hit) userMap.set(fu.id, hit);
    }
  }
  const mapUser = (fid) => (fid && userMap.has(fid) ? userMap.get(fid) : null);

  // 2. Build & persist Project Map (create any new Fuel V2 Project)
  const { projectMap, assetMap, tankMap } = resolveMappingsReadonly(fuelDb, targetDb);
  if (hasTable(fuelDb, 'Project')) {
    const insertProj = buildFilteredInserter(targetDb, 'projects');
    for (const fp of fuelDb.prepare('SELECT * FROM "Project"').all()) {
      let mapped = projectMap.get(fp.id);
      if (!mapped) {
        const cleanCode = cleanStr(fp.code);
        const cleanName = cleanStr(fp.name) || cleanCode || `Project-${fp.id.slice(0, 6)}`;
        insertProj.run({
          code: cleanCode,
          name: cleanName,
          name_norm: normCodeNorm(cleanName),
          active: 1,
          created_at: normDateTime(fp.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        const created = (cleanCode && targetDb.prepare('SELECT id, code, name FROM projects WHERE code = ?').get(cleanCode))
          || targetDb.prepare('SELECT id, code, name FROM projects WHERE name = ? ORDER BY id DESC LIMIT 1').get(cleanName);
        if (created) {
          mapped = created;
          projectMap.set(fp.id, mapped);
          stats.projectsCreated++;
        }
      }
      if (mapped) {
        saveIdMap.run('PROJECT', fp.id, String(mapped.id), 'vps_cutover', fp.code || fp.name || fp.id, mapped.code || mapped.name || '');
      }
    }
  }
  const mapProjectId = (fid) => (fid && projectMap.has(fid) ? Number(projectMap.get(fid).id) : null);

  // 3. Build & persist Asset Map (create any new Fuel V2 Asset so zero issues/bills are skipped)
  if (hasTable(fuelDb, 'Asset')) {
    const insertAsset = buildFilteredInserter(targetDb, 'assets');
    for (const fa of fuelDb.prepare('SELECT * FROM "Asset"').all()) {
      let mapped = assetMap.get(fa.id);
      if (!mapped) {
        const code = cleanStr(fa.code) || cleanStr(fa.regNo) || `FUEL-${fa.id.slice(0, 6).toUpperCase()}`;
        let cNorm = normCodeNorm(code) || normCodeNorm(fa.id);
        const existingNorm = targetDb.prepare('SELECT id, code, code_norm, registration FROM assets WHERE code_norm = ?').get(cNorm);
        if (existingNorm) {
          mapped = existingNorm;
        } else {
          const nowStr = normDateTime(fa.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
          insertAsset.run({
            code,
            code_norm: cNorm,
            registration: cleanStr(fa.regNo),
            brand: cleanStr(fa.brand),
            type: cleanStr(fa.typeLabel),
            model_no: cleanStr(fa.model),
            capacity: cleanStr(fa.capacity),
            yom: fa.yom != null ? String(fa.yom) : null,
            chassis_no: cleanStr(fa.chassisNo),
            engine_no: cleanStr(fa.engineNo),
            serial_no: cleanStr(fa.serialNo),
            asset_class: normAssetClass(fa.typeLabel),
            current_project_id: mapProjectId(fa.projectId),
            status: normAssetStatus(fa.status),
            meter_type: normMeterType(fa.meterType),
            in_register: 1,
            created_at: nowStr,
            updated_at: normDateTime(fa.updatedAt) || nowStr,
          });
          mapped = targetDb.prepare('SELECT id, code, code_norm, registration FROM assets WHERE code_norm = ?').get(cNorm);
          if (mapped) stats.assetsCreated++;
        }
        if (mapped) assetMap.set(fa.id, mapped);
      }
      if (mapped) {
        saveIdMap.run('ASSET', fa.id, String(mapped.id), 'vps_cutover', fa.code || fa.regNo || fa.id, mapped.code || '');
      }
    }
  }
  const mapAsset = (fid) => (fid && assetMap.has(fid) ? assetMap.get(fid) : null);

  // 4. BulkTank -> fuel_tanks (create missing tanks + sync balances)
  if (hasTable(fuelDb, 'BulkTank')) {
    const insertTank = buildFilteredInserter(targetDb, 'fuel_tanks');
    let nextTankSeq = targetDb.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) AS m FROM fuel_tanks WHERE id GLOB '[0-9]*'").get().m + 1;
    const updTank = targetDb.prepare(`
      UPDATE fuel_tanks
         SET current_litres = ?,
             capacity_litres = ?,
             project_id = COALESCE(project_id, ?),
             updated_at = COALESCE(?, updated_at)
       WHERE id = ?
    `);

    for (const ft of fuelDb.prepare('SELECT * FROM "BulkTank"').all()) {
      let mapped = tankMap.get(ft.id);
      const projId = mapProjectId(ft.projectId);
      const updAt = normDateTime(ft.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (!mapped) {
        const newId = String(nextTankSeq++);
        let code = `TANK-${newId}`;
        while (targetDb.prepare('SELECT 1 FROM fuel_tanks WHERE code = ?').get(code)) {
          code = `TANK-${nextTankSeq++}`;
        }
        insertTank.run({
          id: newId,
          code,
          name: ft.name,
          tank_type: normTankType(ft.name, ft.tankType),
          fuel_type: cleanStr(ft.fuelKind) || 'AUTO_DIESEL',
          capacity_litres: Number(ft.capacity) || 0,
          current_litres: Number(ft.balance) || 0,
          project_id: projId,
          active: 1,
          created_at: normDateTime(ft.createdAt) || updAt,
          updated_at: updAt,
        });
        mapped = targetDb.prepare('SELECT id, code, name, current_litres, capacity_litres FROM fuel_tanks WHERE id = ?').get(newId);
        if (mapped) {
          tankMap.set(ft.id, mapped);
          stats.tanksCreated++;
        }
      } else if (syncTankBalances) {
        const curDiff = Math.abs((Number(ft.balance) || 0) - (Number(mapped.current_litres) || 0));
        const capDiff = Math.abs((Number(ft.capacity) || 0) - (Number(mapped.capacity_litres) || 0));
        if (curDiff > 0.001 || capDiff > 0.001) {
          updTank.run(Number(ft.balance) || 0, Number(ft.capacity) || 0, projId, updAt, mapped.id);
          stats.tanksUpdated++;
        }
      }
      if (mapped) {
        saveIdMap.run('TANK', ft.id, String(mapped.id), 'vps_cutover', ft.name || ft.id, mapped.code || mapped.name);
      }
    }
  }
  const mapTankId = (fid) => (fid && tankMap.has(fid) ? String(tankMap.get(fid).id) : null);

  // 5. FuelPrice -> fuel_prices
  if (hasTable(fuelDb, 'FuelPrice') && hasTable(targetDb, 'fuel_prices')) {
    const fpCols = new Set(getCols(targetDb, 'fuel_prices'));
    const upsertPrice = targetDb.prepare(`
      INSERT INTO fuel_prices (fuel_type, price_per_litre_cents, effective_date, notes, created_at${fpCols.has('fuel_kind') ? ', fuel_kind' : ''}${fpCols.has('price_per_litre') ? ', price_per_litre' : ''}${fpCols.has('source') ? ', source' : ''})
      VALUES (?, ?, ?, ?, ?${fpCols.has('fuel_kind') ? ', ?' : ''}${fpCols.has('price_per_litre') ? ', ?' : ''}${fpCols.has('source') ? ', ?' : ''})
      ON CONFLICT(fuel_type, effective_date) DO UPDATE SET
        price_per_litre_cents = excluded.price_per_litre_cents
        ${fpCols.has('price_per_litre') ? ', price_per_litre = excluded.price_per_litre' : ''}
        ${fpCols.has('fuel_kind') ? ', fuel_kind = excluded.fuel_kind' : ''}
        ${fpCols.has('source') ? ', source = COALESCE(excluded.source, fuel_prices.source)' : ''}
    `);
    const rows = fuelDb.prepare('SELECT * FROM "FuelPrice" ORDER BY effectiveFrom ASC, createdAt ASC').all();
    const tx = targetDb.transaction((items) => {
      for (const p of items) {
        const effDate = normDate(p.effectiveFrom);
        const cents = Number(p.pricePerLitre) || 0;
        const lkr = Math.round((cents / 100) * 100) / 100;
        const fk = cleanStr(p.fuelKind) || 'AUTO_DIESEL';
        const args = [fk, cents, effDate, cleanStr(p.note) || cleanStr(p.source), normDateTime(p.createdAt) || effDate + ' 00:00:00'];
        if (fpCols.has('fuel_kind')) args.push(fk);
        if (fpCols.has('price_per_litre')) args.push(lkr);
        if (fpCols.has('source')) args.push(cleanStr(p.note) || cleanStr(p.source) || 'Ceypetco');
        const r = upsertPrice.run(...args);
        if (r.changes > 0) stats.pricesUpserted++;
      }
    });
    tx(rows);
  }

  // 6. FuelRequest -> fuel_requests (before fuel_issues due to optional FK)
  if (hasTable(fuelDb, 'FuelRequest') && hasTable(targetDb, 'fuel_requests')) {
    const insertReq = buildFilteredInserter(targetDb, 'fuel_requests', 'INSERT OR IGNORE');
    const existingIds = new Set(targetDb.prepare('SELECT id FROM fuel_requests').all().map((r) => r.id));
    const updReq = targetDb.prepare(`
      UPDATE fuel_requests
         SET status = ?,
             approved_at = COALESCE(?, approved_at),
             actual_issued_litres = COALESCE(?, actual_issued_litres),
             fulfilled_at = COALESCE(?, fulfilled_at),
             rejection_reason = COALESCE(?, rejection_reason)
       WHERE id = ? AND (status <> ? OR COALESCE(actual_issued_litres, -1) <> COALESCE(?, -1))
    `);
    const rows = fuelDb.prepare('SELECT * FROM "FuelRequest"').all();
    const tx = targetDb.transaction((items) => {
      for (const r of items) {
        const asset = mapAsset(r.assetId);
        const status = normRequestStatus(r.status);
        const reqNo = cleanStr(r.requestNo) || `FREQ-${String(r.id).slice(0, 8)}`;
        if (!existingIds.has(r.id)) {
          const info = insertReq.run({
            id: r.id,
            request_no: reqNo,
            asset_id: asset ? asset.id : null,
            asset_code: asset ? asset.code : null,
            project_id: mapProjectId(r.projectId),
            fuel_type: cleanStr(r.fuelKind) || 'AUTO_DIESEL',
            requested_litres: Number(r.requestedLitres) || 0,
            meter_reading: r.meterReading != null ? Number(r.meterReading) : null,
            reason: cleanStr(r.reason),
            status,
            requested_by: mapUser(r.requestedById),
            requested_at: normDateTime(r.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
            approved_by: status === 'APPROVED' || status === 'FULFILLED' ? mapUser(r.reviewedById) : null,
            approved_at: status === 'APPROVED' || status === 'FULFILLED' ? normDateTime(r.reviewedAt) : null,
            rejection_reason: status === 'REJECTED' ? cleanStr(r.reviewNote) : null,
            target_tank_id: mapTankId(r.targetTankId),
            source_mode: cleanStr(r.sourceMode) || 'TANK',
            station_name: cleanStr(r.stationName),
            running_chart_no: cleanStr(r.runningChartNo),
            driver_name: cleanStr(r.driverName),
            trip_purpose: cleanStr(r.tripPurpose),
            prev_meter_reading: r.prevMeterReading != null ? Number(r.prevMeterReading) : null,
            meter_type: normMeterType(r.readingType),
            approx_km: r.approxKm != null ? Number(r.approxKm) : null,
            consumption_norm: r.consumptionNorm != null ? Number(r.consumptionNorm) : null,
            recommended_litres: r.recommendedLitres != null ? Number(r.recommendedLitres) : null,
            trip_total_fuel: r.tripTotalFuel != null ? Number(r.tripTotalFuel) : null,
            is_full_tank: r.isFullTank ? 1 : 0,
            needs_approval: r.needsApproval ? 1 : 0,
            actual_issued_litres: r.actualIssuedLitres != null ? Number(r.actualIssuedLitres) : null,
            fulfilled_by: mapUser(r.fulfilledById),
            fulfilled_at: normDateTime(r.fulfilledAt),
          });
          if (info.changes > 0) stats.requestsInserted++;
        } else {
          const revAt = normDateTime(r.reviewedAt);
          const fulAt = normDateTime(r.fulfilledAt);
          const actLit = r.actualIssuedLitres != null ? Number(r.actualIssuedLitres) : null;
          const rejNote = status === 'REJECTED' ? cleanStr(r.reviewNote) : null;
          const info = updReq.run(status, revAt, actLit, fulAt, rejNote, r.id, status, actLit);
          if (info.changes > 0) stats.requestsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 7. FuelIssue -> fuel_issues
  if (hasTable(fuelDb, 'FuelIssue') && hasTable(targetDb, 'fuel_issues')) {
    const insertIssue = buildFilteredInserter(targetDb, 'fuel_issues', 'INSERT OR IGNORE');
    const existingById = new Map(
      targetDb.prepare('SELECT id, is_voided, litres, total_cost_cents, fuel_price_cents, meter_reading, cross_check_status FROM fuel_issues').all()
        .map((r) => [r.id, r])
    );
    const fiCols = new Set(getCols(targetDb, 'fuel_issues'));
    const updSets = [
      'is_voided = @is_voided',
      'voided_at = @voided_at',
      'litres = @litres',
      'fuel_price_cents = @fuel_price_cents',
      'total_cost_cents = @total_cost_cents',
      'meter_reading = @meter_reading',
    ];
    if (fiCols.has('voided')) updSets.push('voided = @voided');
    if (fiCols.has('price_per_litre_cents')) updSets.push('price_per_litre_cents = @price_per_litre_cents');
    if (fiCols.has('unit_price')) updSets.push('unit_price = @unit_price');
    if (fiCols.has('cost_cents')) updSets.push('cost_cents = @cost_cents');
    if (fiCols.has('total_price')) updSets.push('total_price = @total_price');
    if (fiCols.has('cross_check_status')) updSets.push('cross_check_status = @cross_check_status');
    const updIssue = targetDb.prepare(`UPDATE fuel_issues SET ${updSets.join(', ')} WHERE id = @id`);

    const rows = fuelDb.prepare('SELECT * FROM "FuelIssue"').all();
    const tx = targetDb.transaction((items) => {
      for (const fi of items) {
        const asset = mapAsset(fi.assetId);
        const assetCode = (asset && asset.code) || 'UNKNOWN';
        const regOrCode = (asset && (asset.registration || asset.code)) || assetCode;
        const tankId = mapTankId(fi.bulkTankId);
        const isVoid = fi.voided ? 1 : 0;
        const priceCents = Number(fi.pricePerLitre) || 0;
        const totalCents = Number(fi.totalCost) || 0;
        const litres = Number(fi.litres) || 0;
        const unitLkr = Math.round((priceCents / 100) * 100) / 100;
        const totalLkr = Math.round((totalCents / 100) * 100) / 100;
        const fk = cleanStr(fi.fuelKind) || 'AUTO_DIESEL';
        const mType = normMeterType(fi.readingType);
        const mRead = fi.meterReading != null ? Number(fi.meterReading) : null;
        const issueDt = normDateTime(fi.issueDate) || normDateTime(fi.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const voidDt = isVoid ? normDateTime(fi.voidedAt) : null;

        const existing = existingById.get(fi.id);
        if (!existing) {
          const info = insertIssue.run({
            id: fi.id,
            asset_id: asset ? asset.id : null,
            asset_code: assetCode,
            vehicle_ref: regOrCode,
            fuel_type: fk,
            fuel_kind: fk,
            litres,
            fuel_price_cents: priceCents,
            price_per_litre_cents: priceCents,
            unit_price: unitLkr,
            total_cost_cents: totalCents,
            cost_cents: totalCents,
            total_price: totalLkr,
            meter_reading: mRead,
            meter_type: mType,
            issue_date: issueDt,
            station_name: cleanStr(fi.source),
            driver_name: cleanStr(fi.issuePerson),
            recipient_name: cleanStr(fi.issuePerson),
            source: cleanStr(fi.source) || 'pump',
            source_tank_id: tankId,
            bulk_tank_id: tankId,
            project_id: asset && asset.current_project_id ? asset.current_project_id : null,
            fuel_request_id: cleanStr(fi.linkedRequestId),
            issued_by: mapUser(fi.issuedById),
            is_voided: isVoid,
            voided: isVoid,
            voided_at: voidDt,
            import_key: cleanStr(fi.importKey),
            running_chart_no: cleanStr(fi.runningChartNo),
            trip_purpose: cleanStr(fi.tripPurpose),
            approx_km_snapshot: fi.approxKmSnapshot != null ? Number(fi.approxKmSnapshot) : null,
            recommended_litres_snapshot: fi.recommendedLitresSnapshot != null ? Number(fi.recommendedLitresSnapshot) : null,
            trip_fuel_snapshot: fi.tripFuelSnapshot != null ? Number(fi.tripFuelSnapshot) : null,
            is_full_tank: fi.isFullTank ? 1 : 0,
            variance_litres: fi.varianceLitres != null ? Number(fi.varianceLitres) : null,
            variance_pct: fi.variancePct != null ? Number(fi.variancePct) : null,
            cross_check_status: cleanStr(fi.crossCheckStatus),
            created_at: normDateTime(fi.createdAt) || issueDt,
          });
          if (info.changes > 0) stats.issuesInserted++;
        } else {
          const changed = Number(existing.is_voided ? 1 : 0) !== isVoid
            || Math.abs((Number(existing.litres) || 0) - litres) > 0.001
            || Number(existing.total_cost_cents || 0) !== totalCents
            || Number(existing.fuel_price_cents || 0) !== priceCents
            || existing.meter_reading !== mRead;
          if (changed) {
            updIssue.run({
              id: fi.id,
              is_voided: isVoid,
              voided: isVoid,
              voided_at: voidDt,
              litres,
              fuel_price_cents: priceCents,
              price_per_litre_cents: priceCents,
              unit_price: unitLkr,
              total_cost_cents: totalCents,
              cost_cents: totalCents,
              total_price: totalLkr,
              meter_reading: mRead,
              cross_check_status: cleanStr(fi.crossCheckStatus),
            });
            stats.issuesUpdated++;
          }
        }
      }
    });
    tx(rows);
  }

  // 8. BulkRequest -> fuel_bulk_deliveries
  if (hasTable(fuelDb, 'BulkRequest') && hasTable(targetDb, 'fuel_bulk_deliveries')) {
    const insertDel = buildFilteredInserter(targetDb, 'fuel_bulk_deliveries', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, status, litres FROM fuel_bulk_deliveries').all().map((r) => [r.id, r]));
    const updDel = targetDb.prepare('UPDATE fuel_bulk_deliveries SET status = ?, litres = ?, note = COALESCE(?, note) WHERE id = ?');
    const rows = fuelDb.prepare('SELECT * FROM "BulkRequest"').all();
    const tx = targetDb.transaction((items) => {
      for (const r of items) {
        const tankId = mapTankId(r.bulkTankId);
        if (!tankId) continue;
        const st = normDeliveryStatus(r.status);
        const lit = Number(r.requestedLitres) || 0;
        const delDate = normDate(r.reviewedAt || r.updatedAt || r.createdAt) || new Date().toISOString().slice(0, 10);
        const existing = existingMap.get(r.id);
        if (!existing) {
          const info = insertDel.run({
            id: r.id,
            tank_id: tankId,
            litres: lit,
            fuel_type: cleanStr(r.fuelKind) || 'AUTO_DIESEL',
            supplier: 'Ceypetco',
            delivery_date: delDate,
            status: st,
            received_by: mapUser(r.reviewedById || r.requestedById),
            note: cleanStr(r.reviewNote) || 'Imported from Fuel-System-V2',
            created_at: normDateTime(r.createdAt) || `${delDate} 00:00:00`,
          });
          if (info.changes > 0) stats.deliveriesInserted++;
        } else if (existing.status !== st || Math.abs((Number(existing.litres) || 0) - lit) > 0.001) {
          updDel.run(st, lit, cleanStr(r.reviewNote), r.id);
          stats.deliveriesUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 9. TankDip -> fuel_tank_dips
  if (hasTable(fuelDb, 'TankDip') && hasTable(targetDb, 'fuel_tank_dips')) {
    const insertDip = buildFilteredInserter(targetDb, 'fuel_tank_dips', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "TankDip"').all();
    const tx = targetDb.transaction((items) => {
      for (const d of items) {
        const tankId = mapTankId(d.bulkTankId);
        if (!tankId) continue;
        const dipDt = normDateTime(d.dipDate) || normDateTime(d.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const info = insertDip.run({
          id: d.id,
          tank_id: tankId,
          dip_litres: Number(d.dipLitres) || 0,
          computed_balance: Number(d.computedBalance) || 0,
          variance_litres: Number(d.variance) || 0,
          dip_date: dipDt,
          note: cleanStr(d.note),
          recorded_by: mapUser(d.recordedById) || 1,
          created_at: normDateTime(d.createdAt) || dipDt,
        });
        if (info.changes > 0) stats.dipsInserted++;
      }
    });
    tx(rows);
  }

  // 10. FuelIssueCorrection -> fuel_corrections
  if (hasTable(fuelDb, 'FuelIssueCorrection') && hasTable(targetDb, 'fuel_corrections')) {
    const insertCorr = buildFilteredInserter(targetDb, 'fuel_corrections', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, status, approved_at FROM fuel_corrections').all().map((r) => [r.id, r]));
    const updCorr = targetDb.prepare('UPDATE fuel_corrections SET status = ?, approved_at = COALESCE(?, approved_at), review_note = COALESCE(?, review_note) WHERE id = ?');
    const rows = fuelDb.prepare('SELECT * FROM "FuelIssueCorrection"').all();
    const tx = targetDb.transaction((items) => {
      for (const c of items) {
        const st = normCorrectionStatus(c.status);
        const origLit = c.origLitres != null ? Number(c.origLitres) : null;
        const afterLit = c.newLitres != null ? Number(c.newLitres) : (c.type === 'VOID' ? 0 : (origLit || 0));
        const revAt = normDateTime(c.reviewedAt);
        const revNote = cleanStr(c.reviewNote);
        const existing = existingMap.get(c.id);
        if (!existing) {
          const asset = mapAsset(c.assetId);
          const info = insertCorr.run({
            id: c.id,
            fuel_issue_id: c.fuelIssueId,
            correction_type: normCorrectionType(c.type),
            before_litres: origLit,
            after_litres: afterLit,
            before_meter: c.origMeterReading != null ? Number(c.origMeterReading) : null,
            after_meter: c.newMeterReading != null ? Number(c.newMeterReading) : null,
            stock_delta_litres: origLit != null ? Math.round((afterLit - origLit) * 1000) / 1000 : 0,
            financial_delta_cents: 0,
            reason: cleanStr(c.reason) || cleanStr(c.type) || 'Correction',
            evidence_file: cleanStr(c.docName),
            status: st,
            requested_by: mapUser(c.requestedById) || 1,
            requested_at: normDateTime(c.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
            approved_by: mapUser(c.reviewedById),
            approved_at: revAt,
            asset_id: asset ? asset.id : null,
            asset_code: cleanStr(c.assetCode) || (asset ? asset.code : null),
            project_id: mapProjectId(c.projectId),
            project_code: cleanStr(c.projectCode),
            project_name: cleanStr(c.projectName),
            orig_fuel_kind: cleanStr(c.origFuelKind),
            new_fuel_kind: cleanStr(c.newFuelKind),
            orig_issue_date: normDateTime(c.origIssueDate),
            new_issue_date: normDateTime(c.newIssueDate),
            review_note: revNote,
          });
          if (info.changes > 0) stats.correctionsInserted++;
        } else if (existing.status !== st || (revAt && !existing.approved_at)) {
          updCorr.run(st, revAt, revNote, c.id);
          stats.correctionsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 11. MeterReading -> fuel_meter_readings
  if (hasTable(fuelDb, 'MeterReading') && hasTable(targetDb, 'fuel_meter_readings')) {
    const insertMeter = buildFilteredInserter(targetDb, 'fuel_meter_readings', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "MeterReading"').all();
    const tx = targetDb.transaction((items) => {
      for (const m of items) {
        const asset = mapAsset(m.assetId);
        const rDate = normDate(m.readingDate) || normDate(m.createdAt) || new Date().toISOString().slice(0, 10);
        const info = insertMeter.run({
          id: m.id,
          asset_id: asset ? asset.id : null,
          asset_code: (asset && asset.code) || 'UNKNOWN',
          meter_reading: Number(m.value) || 0,
          meter_type: normMeterType(m.readingType),
          reading_date: rDate,
          source: normMeterSource(m.source),
          recorded_by: mapUser(m.recordedById),
          created_at: normDateTime(m.createdAt) || `${rDate} 00:00:00`,
        });
        if (info.changes > 0) stats.meterReadingsInserted++;
      }
    });
    tx(rows);
  }

  // 12. DailyCondition -> fuel_daily_conditions
  if (hasTable(fuelDb, 'DailyCondition') && hasTable(targetDb, 'fuel_daily_conditions')) {
    const insertCond = buildFilteredInserter(targetDb, 'fuel_daily_conditions', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "DailyCondition"').all();
    const tx = targetDb.transaction((items) => {
      for (const c of items) {
        const asset = mapAsset(c.assetId);
        const cDate = normDate(c.logDate) || normDate(c.createdAt) || new Date().toISOString().slice(0, 10);
        const info = insertCond.run({
          id: c.id,
          asset_id: asset ? asset.id : null,
          asset_code: (asset && asset.code) || 'UNKNOWN',
          condition_date: cDate,
          working_status: normConditionStatus(c.status),
          breakdown_reason: cleanStr(c.note),
          recorded_by: mapUser(c.recordedById),
          created_at: normDateTime(c.createdAt) || `${cDate} 00:00:00`,
        });
        if (info.changes > 0) stats.conditionsInserted++;
      }
    });
    tx(rows);
  }

  // 13. AssetAssignment -> fleet_asset_assignments
  if (hasTable(fuelDb, 'AssetAssignment') && hasTable(targetDb, 'fleet_asset_assignments')) {
    const insertAssign = buildFilteredInserter(targetDb, 'fleet_asset_assignments', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, end_date, driver_name, billing_type, updated_at FROM fleet_asset_assignments').all().map((r) => [r.id, r]));
    const updAssign = targetDb.prepare('UPDATE fleet_asset_assignments SET project_id = COALESCE(?, project_id), end_date = ?, driver_name = ?, billing_type = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?');
    const rows = fuelDb.prepare('SELECT * FROM "AssetAssignment"').all();
    const tx = targetDb.transaction((items) => {
      for (const a of items) {
        const asset = mapAsset(a.assetId);
        const projId = mapProjectId(a.projectId);
        const startDt = normDate(a.startDate) || normDate(a.createdAt) || new Date().toISOString().slice(0, 10);
        const endDt = normDate(a.endDate);
        const bType = normBillingType(a.billingType);
        const updAt = normDateTime(a.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const existing = existingMap.get(a.id);
        if (!existing) {
          const info = insertAssign.run({
            id: a.id,
            asset_id: asset ? asset.id : null,
            asset_code: (asset && asset.code) || 'UNKNOWN',
            project_id: projId,
            driver_name: cleanStr(a.driverName),
            start_date: startDt,
            end_date: endDt,
            billing_type: bType,
            origin: cleanStr(a.origin) || 'FLEET',
            note: cleanStr(a.note),
            created_by: mapUser(a.createdById),
            created_at: normDateTime(a.createdAt) || `${startDt} 00:00:00`,
            updated_at: updAt,
          });
          if (info.changes > 0) stats.assignmentsInserted++;
        } else if (updAt > (existing.updated_at || '') && ((existing.end_date || null) !== endDt || (existing.driver_name || null) !== cleanStr(a.driverName) || existing.billing_type !== bType)) {
          updAssign.run(projId, endDt, cleanStr(a.driverName), bType, cleanStr(a.note), updAt, a.id);
          stats.assignmentsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 14. RentalRate -> fleet_rental_rates
  if (hasTable(fuelDb, 'RentalRate') && hasTable(targetDb, 'fleet_rental_rates')) {
    const insertRate = buildFilteredInserter(targetDb, 'fleet_rental_rates', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, updated_at, rate_cents, dry_rate_cents, wet_rate_cents FROM fleet_rental_rates').all().map((r) => [r.id, r]));
    const updRate = targetDb.prepare(`
      UPDATE fleet_rental_rates
         SET dry_rate_cents = ?, wet_rate_cents = ?, fully_wet_rate_cents = ?,
             hr_dry_cents = ?, hr_wet_cents = ?, hr_fw_cents = ?,
             dy_dry_cents = ?, dy_wet_cents = ?, dy_fw_cents = ?,
             km_dry_cents = ?, km_wet_cents = ?, km_fw_cents = ?,
             fuel_cons_econ = COALESCE(?, fuel_cons_econ),
             fuel_cons_typ = COALESCE(?, fuel_cons_typ),
             fuel_cons_heavy = COALESCE(?, fuel_cons_heavy),
             updated_at = ?
       WHERE id = ?
    `);
    const rows = fuelDb.prepare('SELECT * FROM "RentalRate"').all();
    const tx = targetDb.transaction((items) => {
      for (const r of items) {
        const asset = mapAsset(r.assetId);
        const basis = normRentalRateBasis(r);
        const dry = r.hrDCents ?? r.dyDCents ?? r.kmDCents ?? 0;
        const wet = r.hrWCents ?? r.dyWCents ?? r.kmWCents ?? 0;
        const fw = r.hrFwCents ?? r.dyFwCents ?? r.kmFwCents ?? 0;
        const primaryRate = dry || wet || fw || 0;
        const updAt = normDateTime(r.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const existing = existingMap.get(r.id);
        if (!existing) {
          const info = insertRate.run({
            id: r.id,
            asset_id: asset ? asset.id : null,
            category_name: cleanStr(r.category),
            rate_basis: basis,
            rate_cents: primaryRate,
            dry_rate_cents: dry,
            wet_rate_cents: wet,
            fully_wet_rate_cents: fw,
            note: cleanStr(r.sourceLabel),
            source_label: cleanStr(r.sourceLabel),
            equip_type: cleanStr(r.equipType) || 'FLEET',
            default_basis: String(r.defaultBasis || '').trim().toUpperCase() === 'W' ? 'WET' : 'DRY',
            fuel_cons_econ: r.fuelConsEcon != null ? Number(r.fuelConsEcon) : null,
            fuel_cons_typ: r.fuelConsTyp != null ? Number(r.fuelConsTyp) : null,
            fuel_cons_heavy: r.fuelConsHeavy != null ? Number(r.fuelConsHeavy) : null,
            fuel_cons_basis: cleanStr(r.fuelConsBasis),
            hr_dry_cents: r.hrDCents,
            hr_wet_cents: r.hrWCents,
            hr_fw_cents: r.hrFwCents,
            dy_dry_cents: r.dyDCents,
            dy_wet_cents: r.dyWCents,
            dy_fw_cents: r.dyFwCents,
            km_dry_cents: r.kmDCents,
            km_wet_cents: r.kmWCents,
            km_fw_cents: r.kmFwCents,
            port_dw_cents: r.portDwCents,
            port_dd_cents: r.portDdCents,
            created_at: normDateTime(r.createdAt) || updAt,
            updated_at: updAt,
          });
          if (info.changes > 0) stats.ratesInserted++;
        } else if (updAt > (existing.updated_at || '') && (existing.dry_rate_cents !== dry || existing.wet_rate_cents !== wet)) {
          updRate.run(dry, wet, fw, r.hrDCents, r.hrWCents, r.hrFwCents, r.dyDCents, r.dyWCents, r.dyFwCents, r.kmDCents, r.kmWCents, r.kmFwCents, r.fuelConsEcon, r.fuelConsTyp, r.fuelConsHeavy, updAt, r.id);
          stats.ratesUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 15. VehicleAllocation -> fleet_vehicle_allocations
  if (hasTable(fuelDb, 'VehicleAllocation') && hasTable(targetDb, 'fleet_vehicle_allocations')) {
    const insertAlloc = buildFilteredInserter(targetDb, 'fleet_vehicle_allocations', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, active, project_id, site_name, basis, updated_at FROM fleet_vehicle_allocations').all().map((r) => [r.id, r]));
    const updAlloc = targetDb.prepare('UPDATE fleet_vehicle_allocations SET active = ?, project_id = COALESCE(?, project_id), site_name = ?, basis = ?, updated_at = ? WHERE id = ?');
    const rows = fuelDb.prepare('SELECT * FROM "VehicleAllocation"').all();
    const tx = targetDb.transaction((items) => {
      for (const a of items) {
        const asset = mapAsset(a.assetId);
        const projId = mapProjectId(a.projectId);
        const act = a.active ? 1 : 0;
        const updAt = normDateTime(a.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const existing = existingMap.get(a.id);
        if (!existing) {
          const info = insertAlloc.run({
            id: a.id,
            dedupe_key: cleanStr(a.dedupeKey) || a.id,
            asset_id: asset ? asset.id : null,
            vehicle_no: cleanStr(a.vehicleNo) || (asset ? asset.code : 'UNKNOWN'),
            project_id: projId,
            site_name: cleanStr(a.siteName) || 'Site',
            month: cleanStr(a.month) || normDate(a.createdAt)?.slice(0, 7) || '2026-01',
            machine_type: cleanStr(a.machineType),
            owner_code: cleanStr(a.ownerCode),
            basis: cleanStr(a.basis),
            active: act,
            source_file: cleanStr(a.sourceFile),
            source_sheet: cleanStr(a.sourceSheet),
            created_at: normDateTime(a.createdAt) || updAt,
            updated_at: updAt,
          });
          if (info.changes > 0) stats.allocationsInserted++;
        } else if (updAt > (existing.updated_at || '') && (existing.active !== act || existing.basis !== cleanStr(a.basis))) {
          updAlloc.run(act, projId, cleanStr(a.siteName) || existing.site_name, cleanStr(a.basis), updAt, a.id);
          stats.allocationsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 16. Bill -> fleet_bills
  if (hasTable(fuelDb, 'Bill') && hasTable(targetDb, 'fleet_bills')) {
    const insertBill = buildFilteredInserter(targetDb, 'fleet_bills', 'INSERT OR IGNORE');
    const existingMap = new Map(
      targetDb.prepare('SELECT id, status, grand_total_cents, paid_amount_cents, updated_at FROM fleet_bills').all().map((r) => [r.id, r])
    );
    const updBill = targetDb.prepare(`
      UPDATE fleet_bills
         SET status = ?,
             invoice_number = COALESCE(?, invoice_number),
             issued_date = COALESCE(?, issued_date),
             due_date = COALESCE(?, due_date),
             paid_date = COALESCE(?, paid_date),
             paid_amount_cents = COALESCE(?, paid_amount_cents),
             payment_ref = COALESCE(?, payment_ref),
             payment_note = COALESCE(?, payment_note),
             rental_amount_cents = ?,
             fuel_litres = ?,
             fuel_cost_cents = ?,
             breakdown_days = ?,
             breakdown_deduct_cents = ?,
             subtotal_cents = ?,
             sscl_cents = ?,
             vat_cents = ?,
             grand_total_cents = ?,
             updated_at = ?
       WHERE id = ?
    `);

    const rows = fuelDb.prepare('SELECT * FROM "Bill"').all();
    const tx = targetDb.transaction((items) => {
      for (const b of items) {
        const asset = mapAsset(b.assetId);
        const projId = mapProjectId(b.projectId);
        const st = normBillStatus(b.status);
        const inv = cleanStr(b.invoiceNumber);
        const issDt = normDate(b.issuedDate);
        const dueDt = normDate(b.dueDate);
        const paidDt = normDate(b.paidDate);
        const paidAmt = b.paidAmountCents != null ? Number(b.paidAmountCents) : null;
        const updAt = normDateTime(b.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const existing = existingMap.get(b.id);

        if (!existing) {
          const pStart = normDate(b.periodStart) || `${b.year}-${String(b.month).padStart(2, '0')}-01`;
          const pEnd = normDate(b.periodEnd) || pStart;
          const info = insertBill.run({
            id: b.id,
            invoice_number: inv,
            year: Number(b.year),
            month: Number(b.month),
            period_key: cleanStr(b.periodKey) || `${b.year}-${String(b.month).padStart(2, '0')}`,
            period_start: pStart,
            period_end: pEnd,
            asset_id: asset ? asset.id : null,
            asset_code: cleanStr(b.assetCode) || (asset ? asset.code : 'UNKNOWN'),
            asset_reg_no: cleanStr(b.assetRegNo),
            asset_label: cleanStr(b.assetLabel),
            driver_name: cleanStr(b.driverName),
            project_id: projId,
            project_name: cleanStr(b.projectName),
            project_code: cleanStr(b.projectCode),
            billing_mode: cleanStr(b.billingMode) || 'hourly',
            rate_basis: cleanStr(b.rateBasis) || 'w',
            rate_cents: Number(b.rateCents) || 0,
            opening_meter: b.openingMeter != null ? Number(b.openingMeter) : null,
            closing_meter: b.closingMeter != null ? Number(b.closingMeter) : null,
            actual_units: Number(b.actualUnits) || 0,
            minimum_units: Number(b.minimumUnits) || 0,
            billable_units: Number(b.billableUnits) || 0,
            rental_amount_cents: Number(b.rentalAmountCents) || 0,
            fuel_litres: Number(b.fuelLitres) || 0,
            fuel_cost_cents: Number(b.fuelCostCents) || 0,
            breakdown_days: Number(b.breakdownDays) || 0,
            breakdown_deduct_cents: Number(b.breakdownDeductCents) || 0,
            subtotal_cents: Number(b.subtotalCents) || 0,
            sscl_rate: b.ssclRate != null ? Number(b.ssclRate) : 0.025,
            sscl_cents: Number(b.ssclCents) || 0,
            vat_rate: b.vatRate != null ? Number(b.vatRate) : 0.18,
            vat_cents: Number(b.vatCents) || 0,
            grand_total_cents: Number(b.grandTotalCents) || 0,
            status: st,
            issued_date: issDt,
            due_date: dueDt,
            paid_date: paidDt,
            paid_amount_cents: paidAmt,
            payment_ref: cleanStr(b.paymentRef),
            payment_note: cleanStr(b.paymentNote),
            notes: cleanStr(b.notes),
            derived_from_fuel: b.derivedFromFuel ? 1 : 0,
            generated_by: mapUser(b.generatedById),
            emailed_at: normDateTime(b.emailedAt),
            emailed_to: cleanStr(b.emailedTo),
            created_at: normDateTime(b.createdAt) || updAt,
            updated_at: updAt,
          });
          if (info.changes > 0) stats.billsInserted++;
        } else if (billShouldSyncFromFuel(b, existing)) {
          updBill.run(
            st,
            inv,
            issDt,
            dueDt,
            paidDt,
            paidAmt,
            cleanStr(b.paymentRef),
            cleanStr(b.paymentNote),
            Number(b.rentalAmountCents) || 0,
            Number(b.fuelLitres) || 0,
            Number(b.fuelCostCents) || 0,
            Number(b.breakdownDays) || 0,
            Number(b.breakdownDeductCents) || 0,
            Number(b.subtotalCents) || 0,
            Number(b.ssclCents) || 0,
            Number(b.vatCents) || 0,
            Number(b.grandTotalCents) || 0,
            updAt,
            b.id
          );
          stats.billsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 17. BillLineItem -> fleet_bill_line_items
  if (hasTable(fuelDb, 'BillLineItem') && hasTable(targetDb, 'fleet_bill_line_items')) {
    const insertLi = buildFilteredInserter(targetDb, 'fleet_bill_line_items', 'INSERT OR IGNORE');
    const existingMap = new Map(targetDb.prepare('SELECT id, quantity, unit_price_cents, amount_cents, description FROM fleet_bill_line_items').all().map((r) => [r.id, r]));
    const updLi = targetDb.prepare('UPDATE fleet_bill_line_items SET quantity = ?, unit_price_cents = ?, amount_cents = ?, description = ? WHERE id = ?');
    const validBillIds = new Set(targetDb.prepare('SELECT id FROM fleet_bills').all().map((r) => r.id));
    const rows = fuelDb.prepare('SELECT * FROM "BillLineItem"').all();
    const tx = targetDb.transaction((items) => {
      for (const li of items) {
        if (!validBillIds.has(li.billId)) continue;
        const itemType = normLineItemType(li.kind);
        const qty = li.quantity != null ? Number(li.quantity) : 1;
        const unitCents = Number(li.unitRateCents) || 0;
        const amtCents = Number(li.amountCents) || 0;
        const desc = cleanStr(li.description) || itemType;
        const existing = existingMap.get(li.id);
        if (!existing) {
          const info = insertLi.run({
            id: li.id,
            bill_id: li.billId,
            item_type: itemType,
            description: desc,
            quantity: qty,
            unit_price_cents: unitCents,
            amount_cents: amtCents,
            is_deduction: itemType === 'BREAKDOWN_DEDUCT' || amtCents < 0 ? 1 : 0,
          });
          if (info.changes > 0) stats.lineItemsInserted++;
        } else if (existing.amount_cents !== amtCents || existing.unit_price_cents !== unitCents || Math.abs((Number(existing.quantity) || 0) - qty) > 0.001 || existing.description !== desc) {
          updLi.run(qty, unitCents, amtCents, desc, li.id);
          stats.lineItemsUpdated++;
        }
      }
    });
    tx(rows);
  }

  // 18. BillRevision -> fleet_bill_revisions
  if (hasTable(fuelDb, 'BillRevision') && hasTable(targetDb, 'fleet_bill_revisions')) {
    const insertRev = buildFilteredInserter(targetDb, 'fleet_bill_revisions', 'INSERT OR IGNORE');
    const validBillIds = new Set(targetDb.prepare('SELECT id FROM fleet_bills').all().map((r) => r.id));
    const rows = fuelDb.prepare('SELECT * FROM "BillRevision"').all();
    const tx = targetDb.transaction((items) => {
      for (const r of items) {
        if (!validBillIds.has(r.billId)) continue;
        const info = insertRev.run({
          id: r.id,
          bill_id: r.billId,
          revision_number: Number(r.revision) || 1,
          change_summary: cleanStr(r.reason) || `Revision ${r.revision || 1}`,
          snapshot_json: r.snapshotJson || '{}',
          grand_total_cents: Number(r.grandTotalCents) || 0,
          created_by: mapUser(r.createdById),
          created_at: normDateTime(r.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        if (info.changes > 0) stats.revisionsInserted++;
      }
    });
    tx(rows);
  }

  // 19. Payment -> fleet_payments & CreditNote -> fleet_credit_notes & Budget -> site_fuel_budgets & PMTask -> fuel_pm_tasks
  if (hasTable(fuelDb, 'Payment') && hasTable(targetDb, 'fleet_payments')) {
    const insertPay = buildFilteredInserter(targetDb, 'fleet_payments', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "Payment"').all();
    const tx = targetDb.transaction((items) => {
      for (const p of items) {
        const info = insertPay.run({
          id: p.id,
          bill_id: p.billId,
          amount_cents: Number(p.amountCents) || 0,
          payment_date: normDate(p.paidDate) || normDate(p.createdAt) || new Date().toISOString().slice(0, 10),
          payment_method: cleanStr(p.method),
          reference_no: cleanStr(p.reference),
          notes: cleanStr(p.note),
          recorded_by: mapUser(p.createdById),
          created_at: normDateTime(p.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        if (info.changes > 0) stats.paymentsInserted++;
      }
    });
    tx(rows);
  }

  if (hasTable(fuelDb, 'CreditNote') && hasTable(targetDb, 'fleet_credit_notes')) {
    const insertCn = buildFilteredInserter(targetDb, 'fleet_credit_notes', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "CreditNote"').all();
    const tx = targetDb.transaction((items) => {
      for (const cn of items) {
        const info = insertCn.run({
          id: cn.id,
          credit_note_no: cleanStr(cn.number) || `CN-${cn.id.slice(0, 8)}`,
          bill_id: cn.billId,
          amount_cents: Number(cn.amountCents) || 0,
          reason: cleanStr(cn.reason) || 'Credit adjustment',
          approved_by: mapUser(cn.createdById),
          created_at: normDateTime(cn.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        if (info.changes > 0) stats.creditNotesInserted++;
      }
    });
    tx(rows);
  }

  if (hasTable(fuelDb, 'Budget') && hasTable(targetDb, 'site_fuel_budgets')) {
    const upsertBudget = targetDb.prepare(`
      INSERT INTO site_fuel_budgets (project_id, year, month, budget_litres, budget_amount_cents, note, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, year, month) DO UPDATE SET
        budget_litres = excluded.budget_litres,
        budget_amount_cents = excluded.budget_amount_cents,
        note = COALESCE(excluded.note, site_fuel_budgets.note),
        updated_at = excluded.updated_at
    `);
    const rows = fuelDb.prepare('SELECT * FROM "Budget"').all();
    const tx = targetDb.transaction((items) => {
      for (const b of items) {
        const pId = mapProjectId(b.projectId);
        if (!pId) continue;
        const updAt = normDateTime(b.updatedAt) || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const info = upsertBudget.run(
          pId,
          Number(b.year),
          Number(b.month),
          b.budgetLitres != null ? Number(b.budgetLitres) : null,
          b.budgetAmountCents != null ? Number(b.budgetAmountCents) : null,
          cleanStr(b.note),
          mapUser(b.createdById),
          normDateTime(b.createdAt) || updAt,
          updAt
        );
        if (info.changes > 0) stats.budgetsUpserted++;
      }
    });
    tx(rows);
  }

  if (hasTable(fuelDb, 'PMTask') && hasTable(targetDb, 'fuel_pm_tasks')) {
    const insertPm = buildFilteredInserter(targetDb, 'fuel_pm_tasks', 'INSERT OR IGNORE');
    const rows = fuelDb.prepare('SELECT * FROM "PMTask"').all();
    const tx = targetDb.transaction((items) => {
      for (const pm of items) {
        const info = insertPm.run({
          id: pm.id,
          asset_id: null,
          task_name: cleanStr(pm.taskCode) || cleanStr(pm.description) || 'PM Task',
          due_meter: pm.intervalHours != null ? Number(pm.intervalHours) : null,
          status: 'PENDING',
          notes: cleanStr(pm.notes) || cleanStr(pm.description),
          created_at: normDateTime(pm.createdAt) || new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        if (info.changes > 0) stats.pmTasksInserted++;
      }
    });
    tx(rows);
  }

  log('  [✓] Fuel-System-V2 merge stats:', JSON.stringify(stats));
  return stats;
}

function runPostMergeRollups(targetDb, log, quiet = false) {
  const rollups = {
    m064: null,
    m065: null,
    m066: null,
    runningHoursUpdated: 0,
    integrityCheck: 'unknown',
  };

  const origLog = console.log;
  if (quiet) console.log = () => {};
  try {
    try {
      rollups.m064 = require('../src/migrate/064_p0_hygiene_indexes_and_fuel_cost_backfill').runMigration(targetDb);
    } catch (e) {
      origLog('  [!] Migration 064 rollup warning:', e.message);
    }
    try {
      rollups.m065 = require('../src/migrate/065_phase3_tanks_allocations_and_delivery_prices').runMigration(targetDb);
    } catch (e) {
      origLog('  [!] Migration 065 rollup warning:', e.message);
      throw e;
    }
    try {
      rollups.m066 = require('../src/migrate/066_phase5_ops_and_data_hygiene').runMigration(targetDb);
    } catch (e) {
      origLog('  [!] Migration 066 rollup warning:', e.message);
    }
  } finally {
    console.log = origLog;
  }

  // Update assets.running_hours to highest meter reading observed
  try {
    const res = targetDb.prepare(`
      UPDATE assets
         SET running_hours = MAX(
           COALESCE(running_hours, 0),
           COALESCE((SELECT MAX(meter_reading) FROM fuel_meter_readings WHERE asset_id = assets.id), 0),
           COALESCE((SELECT MAX(meter_reading) FROM fuel_issues WHERE asset_id = assets.id AND is_voided = 0), 0)
         )
       WHERE EXISTS (SELECT 1 FROM fuel_meter_readings WHERE asset_id = assets.id)
          OR EXISTS (SELECT 1 FROM fuel_issues WHERE asset_id = assets.id AND is_voided = 0 AND meter_reading IS NOT NULL)
    `).run();
    rollups.runningHoursUpdated = res.changes;
  } catch (e) {
    log('  [!] running_hours sync warning:', e.message);
  }

  const integ = targetDb.prepare('PRAGMA integrity_check').get();
  rollups.integrityCheck = integ ? Object.values(integ)[0] : 'error';
  return rollups;
}

async function mergeVpsLiveData(opts = {}) {
  const quiet = !!(opts.quiet || opts.json);
  const log = (...args) => { if (!quiet) console.log(...args); };

  if (opts.verifyOnly || opts.dryRun) {
    const parity = getVpsCutoverParityReport(opts);
    return {
      mode: opts.verifyOnly ? 'verify-only' : 'dry-run',
      parity,
    };
  }

  const paths = resolvePaths(opts);
  const warnings = [];
  let backupPath = null;

  if (paths.woPath) {
    if (!fs.existsSync(paths.woPath)) throw new Error(`WorkshopOne source DB not found: ${paths.woPath}`);
    checkWalWarning(paths.woPath, 'WorkshopOne live DB', warnings);
  } else {
    checkWalWarning(paths.corePath, 'core.db', warnings);
    checkWalWarning(paths.cwPath, 'CW.db', warnings);
    checkWalWarning(paths.mtrPath, 'MTR.db', warnings);
  }
  if (fs.existsSync(paths.fuelPath)) checkWalWarning(paths.fuelPath, 'Fuel-System-V2 app.db', warnings);

  if (!opts.skipBackup && fs.existsSync(paths.targetPath)) {
    backupPath = await createPreMergeBackup(paths.targetPath, quiet);
  }

  // Step 1: Prepare target DB (--build-fresh clones live WorkshopOne DB & runs V2 schema migrations)
  let woStats = null;
  if (opts.buildFresh) {
    fs.mkdirSync(path.dirname(paths.targetPath), { recursive: true });
    if (paths.woPath) {
      log(`Cloning live WorkshopOne DB (${paths.woPath}) -> ${paths.targetPath}...`);
      const stagePath = `${paths.targetPath}.staging`;
      try { fs.unlinkSync(stagePath); } catch {}
      const srcWo = new Database(paths.woPath, { readonly: true, fileMustExist: true });
      try {
        await srcWo.backup(stagePath);
      } finally {
        srcWo.close();
      }
      removeStaleSqliteSidecars(paths.targetPath);
      fs.renameSync(stagePath, paths.targetPath);
    } else {
      removeStaleSqliteSidecars(paths.targetPath);
      try { fs.unlinkSync(paths.targetPath); } catch {}
    }

    log('Applying unified WorkshopOne + Fuel V2 schema migrations to target DB...');
    runIsolatedMigrations(paths.targetPath);

    if (!paths.woPath) {
      woStats = runLiveDeltaSync({
        corePath: paths.corePath,
        cwPath: paths.cwPath,
        mtrPath: paths.mtrPath,
        mergedPath: paths.targetPath,
        srcOutsourcingDir: paths.woOutsourcingDir,
        dstOutsourcingDir: paths.targetOutsourcingDir,
        skipHygieneMigration: true,
        quiet,
      });
    }
  } else if (!paths.woPath) {
    // Incremental WorkshopOne split-DB sync
    woStats = runLiveDeltaSync({
      corePath: paths.corePath,
      cwPath: paths.cwPath,
      mtrPath: paths.mtrPath,
      mergedPath: paths.targetPath,
      srcOutsourcingDir: paths.woOutsourcingDir,
      dstOutsourcingDir: paths.targetOutsourcingDir,
      skipHygieneMigration: true,
      quiet,
    });
  }

  // Step 2: Open target DB & execute single-DB WO merge (if not --build-fresh) + Fuel-System-V2 merge + Rollups
  let woDb = null;
  let fuelDb = null;
  let targetDb = null;
  let fuelStats = null;
  let rollups = null;
  let filesCopied = 0;

  try {
    targetDb = new Database(paths.targetPath);
    targetDb.pragma('journal_mode = WAL');
    targetDb.pragma('foreign_keys = OFF');

    const hasFuel = fs.existsSync(paths.fuelPath);
    if (!opts.buildFresh && paths.woPath) {
      woDb = new Database(paths.woPath, { readonly: true, fileMustExist: true });
      woStats = mergeWorkshopSingleDb(woDb, targetDb, hasFuel, log);
    }

    if (hasFuel) {
      fuelDb = new Database(paths.fuelPath, { readonly: true, fileMustExist: true });
      fuelStats = mergeFuelV2Db(fuelDb, targetDb, opts, log);
    } else {
      warnings.push(`Fuel-System-V2 source DB not found at ${paths.fuelPath}; skipped Fuel V2 merge.`);
    }

    // Sync uploads and outsourcing attachments
    if (paths.woUploadsDir) filesCopied += syncMissingFiles(paths.woUploadsDir, paths.targetUploadsDir);
    if (paths.woOutsourcingDir) filesCopied += syncMissingFiles(paths.woOutsourcingDir, paths.targetOutsourcingDir);

    rollups = runPostMergeRollups(targetDb, log, quiet);
    if (rollups.integrityCheck !== 'ok') {
      throw new Error(`Post-merge SQLite integrity check failed: ${rollups.integrityCheck}`);
    }
    targetDb.pragma('foreign_keys = ON');
  } finally {
    try { if (woDb) woDb.close(); } catch {}
    try { if (fuelDb) fuelDb.close(); } catch {}
    try { if (targetDb) targetDb.close(); } catch {}
  }

  const parity = getVpsCutoverParityReport(opts);
  return {
    mode: opts.buildFresh ? 'build-fresh' : 'incremental',
    backupPath,
    warnings: [...new Set([...warnings, ...(parity.warnings || [])])],
    woStats,
    fuelStats,
    filesCopied,
    rollups,
    parity,
  };
}

if (require.main === module) {
  (async () => {
    const opts = parseCliArgs();
    const res = await mergeVpsLiveData(opts);
    const parity = res.parity || {};
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log('\n===============================================================');
      console.log(`WorkshopOne Unified Cutover Merger (${res.mode})`);
      console.log('===============================================================');
      if (res.backupPath) console.log('Backup created:      ', res.backupPath);
      if (res.warnings && res.warnings.length) {
        console.log('\nWARNINGS:');
        for (const w of res.warnings) console.log('  [!] ' + w);
      }
      console.log('\nParity Summary:');
      console.log('  readyForCutover:       ', parity.readyForCutover);
      console.log('  woRealMissingTotal:    ', parity.woRealMissingTotal);
      console.log('  woSyntheticIgnored:    ', parity.woSyntheticIgnoredTotal);
      console.log('  fuelMissingTotal:      ', parity.fuelMissingTotal);
      console.log('  fuelValueMismatchTotal:', parity.fuelValueMismatchTotal);
      if (parity.reconciliation) {
        console.log('  Fuel Issues (active):  ', parity.reconciliation.fuelIssues.sourceActive, 'src vs', parity.reconciliation.fuelIssues.targetActive, 'dst | litreDrift=', parity.reconciliation.fuelIssues.litreDrift, '| costCentsDrift=', parity.reconciliation.fuelIssues.costCentsDrift);
        console.log('  Bills (grandTotal):    ', parity.reconciliation.bills.sourceGrandTotalCents, 'src vs', parity.reconciliation.bills.targetGrandTotalCents, 'dst | statusSyncNeeded=', parity.reconciliation.bills.statusSyncNeeded, '| targetNewerProtected=', parity.reconciliation.bills.targetNewerProtected);
        console.log('  Tanks (mapped/drift):  ', parity.reconciliation.tanks.mappedCount + '/' + parity.reconciliation.tanks.sourceCount, '| balanceDrift=', parity.reconciliation.tanks.balanceDriftCount);
      }
      if (res.rollups) {
        console.log('  Integrity check:       ', res.rollups.integrityCheck);
      }
      console.log('===============================================================\n');
    }
    if (opts.verifyOnly && !parity.readyForCutover) {
      process.exitCode = 2;
    }
  })().catch((err) => {
    console.error('[vps_cutover_merge] FATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  parseCliArgs,
  resolvePaths,
  normDateTime,
  normDate,
  mergeVpsLiveData,
  getVpsCutoverParityReport,
};
