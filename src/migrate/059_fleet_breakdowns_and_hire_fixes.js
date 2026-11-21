'use strict';

/**
 * Migration 059: Fleet Breakdowns Monitoring, Site Allocator Ranges,
 * DRY_WITH_DRIVER Basis & Rate Card Schema Consistency
 *
 * Idempotent across fresh test databases and live workshopone_merged.db.
 */

const fs = require('fs');
const path = require('path');

function ensureCol(targetDb, tableName, colName, colType) {
  const exists = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!exists) return;
  const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
  if (!cols.includes(colName)) {
    targetDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
  }
}

function widenCheckConstraint(targetDb, tableName, colName, extraValues) {
  const cur = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!cur) return;
  const missing = extraValues.filter((v) => !new RegExp(`'${v}'`).test(cur.sql));
  if (!missing.length) return;

  const listRe = new RegExp(`(CHECK\\s*\\(\\s*${colName}\\s+IN\\s*\\()`, 'i');
  if (!listRe.test(cur.sql)) return;

  const tmpTable = `tmp_${tableName}`;
  const tableRe = new RegExp(`^CREATE TABLE (IF NOT EXISTS )?("?)${tableName}\\2`, 'i');
  const widened = cur.sql
    .replace(tableRe, `CREATE TABLE ${tmpTable}`)
    .replace(listRe, `$1${missing.map((v) => `'${v}'`).join(', ')}, `);

  if (!widened.startsWith(`CREATE TABLE ${tmpTable}`)) {
    throw new Error(`${tableName}: unexpected DDL — could not add ${missing.join(', ')}`);
  }

  const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => `"${c.name}"`).join(', ');
  const indexes = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(tableName);
  const triggers = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(tableName);
  const count = targetDb.prepare(`SELECT COUNT(*) n FROM ${tableName}`).get().n;

  targetDb.pragma('foreign_keys = OFF');
  try {
    targetDb.transaction(() => {
      targetDb.exec(`
        ${widened};
        INSERT INTO ${tmpTable} (${cols}) SELECT ${cols} FROM ${tableName};
        DROP TABLE ${tableName};
        ALTER TABLE ${tmpTable} RENAME TO ${tableName};
      `);
      for (const x of [...indexes, ...triggers]) {
        targetDb.exec(x.sql);
      }
      const afterCount = targetDb.prepare(`SELECT COUNT(*) n FROM ${tableName}`).get().n;
      if (afterCount !== count) {
        throw new Error(`${tableName} rebuild lost rows (${count} -> ${afterCount})`);
      }
    })();
  } finally {
    targetDb.pragma('foreign_keys = ON');
  }
}

function enrichRatesFromJson(targetDb) {
  const rateCardsPath = path.join(__dirname, '..', '..', '..', 'Fuel-System-V2-Ref', 'scripts', 'data', 'rate_cards.json');
  if (!fs.existsSync(rateCardsPath)) return;

  const assetCount = targetDb.prepare('SELECT COUNT(*) n FROM assets').get().n;
  if (assetCount === 0) return;

  const portableCount = targetDb.prepare("SELECT COUNT(*) n FROM fleet_rental_rates WHERE equip_type = 'PORTABLE'").get().n;
  const fwCount = targetDb.prepare('SELECT COUNT(*) n FROM fleet_rental_rates WHERE fully_wet_rate_cents IS NOT NULL').get().n;
  if (portableCount > 0 && fwCount > 0) return;

  let rc;
  try {
    rc = JSON.parse(fs.readFileSync(rateCardsPath, 'utf8'));
  } catch {
    return;
  }

  const alnum = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (fwCount === 0 && Array.isArray(rc.fleet)) {
    const assets = targetDb.prepare('SELECT id, code, ec_code, registration FROM assets').all();
    const byCode = new Map();
    const byReg = new Map();
    for (const a of assets) {
      if (a.code) byCode.set(alnum(a.code), a);
      if (a.ec_code) byCode.set(alnum(a.ec_code), a);
      if (a.registration) byReg.set(alnum(a.registration), a);
    }
    const updStmt = targetDb.prepare(`
      UPDATE fleet_rental_rates
         SET rate_basis = COALESCE(?, rate_basis),
             rate_cents = COALESCE(NULLIF(rate_cents, 0), ?),
             fully_wet_rate_cents = COALESCE(fully_wet_rate_cents, ?),
             wet_rate_cents = COALESCE(wet_rate_cents, ?),
             dry_rate_cents = COALESCE(dry_rate_cents, ?),
             fuel_cons_basis = COALESCE(fuel_cons_basis, ?),
             source_label = COALESCE(source_label, ?)
       WHERE asset_id = ?
    `);
    targetDb.transaction(() => {
      for (const c of rc.fleet) {
        const asset = byCode.get(alnum(c.ec)) || byReg.get(alnum(c.reg)) || byCode.get(alnum(`M-${c.id}`));
        if (!asset || !c.r) continue;
        const isKm = !!(c.km && c.r.km);
        const tier = isKm ? c.r.km : (c.r.h || c.r.km || c.r.dy);
        if (!tier) continue;
        const fw = tier.fw ? Math.round(tier.fw * 100) : null;
        const w = tier.w ? Math.round(tier.w * 100) : null;
        const d = tier.d ? Math.round(tier.d * 100) : null;
        updStmt.run(isKm ? 'KM' : 'HOURLY', d, fw, w, d, isKm ? 'km' : 'hr', c.label || null, asset.id);
      }
    })();
  }

  if (portableCount === 0 && Array.isArray(rc.portable)) {
    const insPort = targetDb.prepare(`
      INSERT OR IGNORE INTO fleet_rental_rates (
        id, asset_id, category_name, rate_basis, rate_cents,
        dry_rate_cents, wet_rate_cents, equip_type, default_basis,
        port_dd_cents, port_dw_cents, source_label, note
      ) VALUES (?, NULL, ?, 'DAILY', ?, ?, ?, 'PORTABLE', 'DRY', ?, ?, ?, ?)
    `);
    targetDb.transaction(() => {
      for (const p of rc.portable) {
        const dd = p.dd ? Math.round(Number(p.dd) * 100) : 0;
        const dw = p.dw ? Math.round(Number(p.dw) * 100) : 0;
        insPort.run(
          `rate-port-${p.id}`,
          p.cat || 'Portable Plant',
          dd,
          dd,
          dw,
          dd,
          dw,
          p.cap || p.label || null,
          p.label || null
        );
      }
    })();
  }
}

function runMigration(targetDb) {
  if (!targetDb) return;

  // 1. Ensure fleet_rental_rates consumption & tier columns exist
  ensureCol(targetDb, 'fleet_rental_rates', 'fuel_cons_econ', 'REAL');
  ensureCol(targetDb, 'fleet_rental_rates', 'fuel_cons_typ', 'REAL');
  ensureCol(targetDb, 'fleet_rental_rates', 'fuel_cons_heavy', 'REAL');
  ensureCol(targetDb, 'fleet_rental_rates', 'fuel_cons_basis', 'TEXT');
  ensureCol(targetDb, 'fleet_rental_rates', 'equip_type', "TEXT DEFAULT 'FLEET'");
  ensureCol(targetDb, 'fleet_rental_rates', 'default_basis', "TEXT DEFAULT 'DRY'");
  ensureCol(targetDb, 'fleet_rental_rates', 'fully_wet_rate_cents', 'INTEGER');
  ensureCol(targetDb, 'fleet_rental_rates', 'port_dw_cents', 'INTEGER');
  ensureCol(targetDb, 'fleet_rental_rates', 'port_dd_cents', 'INTEGER');
  ensureCol(targetDb, 'fleet_rental_rates', 'source_label', 'TEXT');

  // 1b. Harmonize Fuel V2 columns, site budgets & correction types across fresh 055 schemas and workshopone_merged.db
  for (const [col, def] of [
    ['fuel_kind', 'TEXT'],
    ['price_per_litre', 'REAL'],
    ['end_date', 'TEXT'],
    ['source', 'TEXT'],
    ['entered_by', 'TEXT'],
  ]) ensureCol(targetDb, 'fuel_prices', col, def);

  for (const [col, def] of [
    ['project_id', 'INTEGER'],
    ['bulk_tank_id', 'TEXT'],
    ['fuel_kind', 'TEXT'],
    ['unit_price', 'REAL'],
    ['total_price', 'REAL'],
    ['recipient_name', 'TEXT'],
    ['source', 'TEXT'],
    ['voided', 'INTEGER DEFAULT 0'],
    ['photo_path', 'TEXT'],
    ['notes', 'TEXT'],
    ['cost_cents', 'INTEGER'],
    ['price_per_litre_cents', 'INTEGER'],
  ]) ensureCol(targetDb, 'fuel_issues', col, def);

  for (const [col, def] of [
    ['asset_id', 'INTEGER'],
    ['asset_code', 'TEXT'],
    ['project_id', 'INTEGER'],
    ['project_code', 'TEXT'],
    ['project_name', 'TEXT'],
    ['orig_fuel_kind', 'TEXT'],
    ['new_fuel_kind', 'TEXT'],
    ['orig_issue_date', 'TEXT'],
    ['new_issue_date', 'TEXT'],
    ['review_note', 'TEXT'],
    ['before_price_cents', 'INTEGER'],
    ['after_price_cents', 'INTEGER'],
  ]) ensureCol(targetDb, 'fuel_corrections', col, def);

  for (const [col, def] of [
    ['category', 'TEXT'],
    ['meter_type', 'TEXT'],
    ['current_hours', 'REAL DEFAULT 0'],
    ['project_id', 'INTEGER'],
  ]) ensureCol(targetDb, 'assets', col, def);

  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS site_fuel_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      budget_litres REAL,
      budget_amount_cents INTEGER,
      note TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, year, month)
    );

    CREATE TABLE IF NOT EXISTS meter_readings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id      INTEGER NOT NULL REFERENCES assets(id),
      reading       REAL NOT NULL,
      meter_type    TEXT NOT NULL DEFAULT 'HOURS',
      reading_date  TEXT NOT NULL DEFAULT (date('now')),
      recorded_by   INTEGER REFERENCES users(id),
      source        TEXT DEFAULT 'manual',
      photo_path    TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  widenCheckConstraint(targetDb, 'fuel_corrections', 'correction_type', ['EDIT', 'RATE']);
  widenCheckConstraint(targetDb, 'fuel_meter_readings', 'source', ['FUEL_CORRECTION']);

  // 2. Ensure fleet_bill_payments table exists
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS fleet_bill_payments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      paid_date TEXT NOT NULL,
      method TEXT,
      reference TEXT,
      note TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 3. Extend fleet_vehicle_allocations for From–To (date/month/year) / Current, driver, notes
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'month_from', 'TEXT');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'month_to', 'TEXT');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'date_from', 'TEXT');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'date_to', 'TEXT');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'is_current', 'INTEGER NOT NULL DEFAULT 0');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'driver_name', 'TEXT');
  ensureCol(targetDb, 'fleet_vehicle_allocations', 'notes', 'TEXT');
  const hasAlloc = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_vehicle_allocations'").get();
  if (hasAlloc) {
    targetDb.exec(`
      UPDATE fleet_vehicle_allocations
         SET month_from = COALESCE(month_from, month),
             month_to = COALESCE(month_to, month),
             date_from = COALESCE(date_from,
               CASE WHEN COALESCE(month_from, month) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                    THEN COALESCE(month_from, month) || '-01' ELSE NULL END),
             date_to = COALESCE(date_to,
               CASE WHEN is_current = 1 THEN NULL
                    WHEN COALESCE(month_to, month) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
                    THEN date(COALESCE(month_to, month) || '-01', '+1 month', '-1 day')
                    ELSE NULL END)
       WHERE month_from IS NULL
          OR month_to IS NULL
          OR date_from IS NULL
          OR (date_to IS NULL AND is_current = 0);
    `);
  }

  // 4. Widen fleet_asset_assignments.billing_type CHECK to allow DRY_WITH_DRIVER
  widenCheckConstraint(targetDb, 'fleet_asset_assignments', 'billing_type', ['DRY_WITH_DRIVER']);

  // 5. Create fleet_breakdowns table (and ensure columns if an older partial table exists)
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS fleet_breakdowns (
      id               TEXT PRIMARY KEY,
      asset_id         INTEGER,
      asset_code       TEXT NOT NULL,
      project_id       INTEGER,
      site_name        TEXT,
      source_type      TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source_type IN ('JOB_CARD', 'JOB_REQUEST', 'DAILY_CONDITION', 'MANUAL')),
      job_card_id      INTEGER,
      job_no           TEXT,
      job_request_id   INTEGER,
      jr_no            TEXT,
      breakdown_start  TEXT NOT NULL,
      breakdown_end    TEXT,
      orig_start_date  TEXT,
      orig_end_date    TEXT,
      total_days       REAL,
      reason           TEXT,
      status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'RECORDED', 'WAIVED')),
      adjusted_by      INTEGER,
      adjusted_at      TEXT,
      adjustment_note  TEXT,
      reported_by      INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureCol(targetDb, 'fleet_breakdowns', 'site_name', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'source_type', "TEXT NOT NULL DEFAULT 'MANUAL'");
  ensureCol(targetDb, 'fleet_breakdowns', 'job_card_id', 'INTEGER');
  ensureCol(targetDb, 'fleet_breakdowns', 'job_no', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'job_request_id', 'INTEGER');
  ensureCol(targetDb, 'fleet_breakdowns', 'jr_no', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'orig_start_date', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'orig_end_date', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'adjustment_note', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'adjusted_by', 'INTEGER');
  ensureCol(targetDb, 'fleet_breakdowns', 'adjusted_at', 'TEXT');
  ensureCol(targetDb, 'fleet_breakdowns', 'updated_at', 'TEXT');

  targetDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_fleet_breakdowns_asset ON fleet_breakdowns(asset_id, breakdown_start);
    CREATE INDEX IF NOT EXISTS idx_fleet_breakdowns_status ON fleet_breakdowns(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_breakdowns_job_card ON fleet_breakdowns(job_card_id) WHERE job_card_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_breakdowns_job_req ON fleet_breakdowns(job_request_id) WHERE job_request_id IS NOT NULL AND job_card_id IS NULL;
  `);

  // 6. Seed portable plant rates & fully_wet tiers from rate_cards.json where missing
  enrichRatesFromJson(targetDb);
}

module.exports = { runMigration };
