'use strict';

/**
 * Enrich 9632-Fuel-Merged (:1949) schema & seed Fuel-System-V2 consumption bands,
 * portable rates, allocations, and site fuel budgets.
 *
 * Strictly READ-ONLY on Fuel-System-V2-Ref reference files.
 * Writes ONLY to d:\Master system 1\9632-Fuel-Merged\data\workshopone_merged.db.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

const DB_PATH = path.join(__dirname, '..', 'data', 'workshopone_merged.db');
const XLSX_PATH = path.join(__dirname, '..', '..', 'Fuel-System-V2-Ref', 'scripts', 'data', 'Fleet_Rental_Prices_2026_finalz.xlsx');
const RATE_CARDS_JSON = path.join(__dirname, '..', '..', 'Fuel-System-V2-Ref', 'scripts', 'data', 'rate_cards.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function ensureColumn(table, col, typeDef) {
  const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeDef}`);
    console.log(`  + Added column ${table}.${col}`);
  }
}

async function main() {
  console.log('=== Enriching 9632-Fuel-Merged Schema & Fuel-System-V2 Reference Data ===');

  // 1. Add missing columns to users (for Site Fuel Operators & Scoped Users)
  ensureColumn('users', 'project_id', 'INTEGER');
  ensureColumn('users', 'bulk_tank_id', 'TEXT');
  ensureColumn('users', 'hide_stock', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'fuel_role', 'TEXT');

  // 2. Add missing columns to fleet_rental_rates (Consumption Bands & Portable Tiers)
  ensureColumn('fleet_rental_rates', 'fuel_cons_econ', 'REAL');
  ensureColumn('fleet_rental_rates', 'fuel_cons_typ', 'REAL');
  ensureColumn('fleet_rental_rates', 'fuel_cons_heavy', 'REAL');
  ensureColumn('fleet_rental_rates', 'fuel_cons_basis', 'TEXT');
  ensureColumn('fleet_rental_rates', 'equip_type', "TEXT DEFAULT 'FLEET'");
  ensureColumn('fleet_rental_rates', 'default_basis', "TEXT DEFAULT 'DRY'");
  ensureColumn('fleet_rental_rates', 'fully_wet_rate_cents', 'INTEGER');
  ensureColumn('fleet_rental_rates', 'port_dw_cents', 'INTEGER');
  ensureColumn('fleet_rental_rates', 'port_dd_cents', 'INTEGER');
  ensureColumn('fleet_rental_rates', 'source_label', 'TEXT');

  // 3. Add extra columns to fuel_corrections so both schemas work seamlessly
  ensureColumn('fuel_corrections', 'asset_id', 'INTEGER');
  ensureColumn('fuel_corrections', 'asset_code', 'TEXT');
  ensureColumn('fuel_corrections', 'project_id', 'INTEGER');
  ensureColumn('fuel_corrections', 'project_code', 'TEXT');
  ensureColumn('fuel_corrections', 'project_name', 'TEXT');
  ensureColumn('fuel_corrections', 'orig_fuel_kind', 'TEXT');
  ensureColumn('fuel_corrections', 'new_fuel_kind', 'TEXT');
  ensureColumn('fuel_corrections', 'orig_issue_date', 'TEXT');
  ensureColumn('fuel_corrections', 'new_issue_date', 'TEXT');
  ensureColumn('fuel_corrections', 'review_note', 'TEXT');

  // Backfill asset_code & project info on existing fuel_corrections rows
  db.exec(`
    UPDATE fuel_corrections
       SET asset_code = COALESCE(asset_code, (SELECT asset_code FROM fuel_issues WHERE fuel_issues.id = fuel_corrections.fuel_issue_id)),
           asset_id = COALESCE(asset_id, (SELECT asset_id FROM fuel_issues WHERE fuel_issues.id = fuel_corrections.fuel_issue_id)),
           project_id = COALESCE(project_id, (SELECT COALESCE(target_project_id, project_id, source_project_id) FROM fuel_issues WHERE fuel_issues.id = fuel_corrections.fuel_issue_id)),
           orig_fuel_kind = COALESCE(orig_fuel_kind, (SELECT COALESCE(fuel_type, fuel_kind, 'AUTO_DIESEL') FROM fuel_issues WHERE fuel_issues.id = fuel_corrections.fuel_issue_id)),
           orig_issue_date = COALESCE(orig_issue_date, (SELECT issue_date FROM fuel_issues WHERE fuel_issues.id = fuel_corrections.fuel_issue_id))
     WHERE asset_code IS NULL OR orig_issue_date IS NULL;

    UPDATE fuel_corrections
       SET project_code = COALESCE(project_code, (SELECT code FROM projects WHERE projects.id = fuel_corrections.project_id)),
           project_name = COALESCE(project_name, (SELECT name FROM projects WHERE projects.id = fuel_corrections.project_id))
     WHERE project_id IS NOT NULL;
  `);

  // 4. Create site_fuel_budgets & fleet_bill_payments if not exists
  db.exec(`
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

  // 5. Enrich fleet_rental_rates from rate_cards.json
  const alnum = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const allAssets = db.prepare('SELECT id, code, ec_code, registration, category, type FROM assets').all();
  const byCode = new Map();
  const byReg = new Map();
  for (const a of allAssets) {
    if (a.code) byCode.set(alnum(a.code), a);
    if (a.ec_code) byCode.set(alnum(a.ec_code), a);
    if (a.registration) byReg.set(alnum(a.registration), a);
  }

  if (fs.existsSync(RATE_CARDS_JSON)) {
    const rc = JSON.parse(fs.readFileSync(RATE_CARDS_JSON, 'utf8'));
    const fleetCards = rc.fleet || [];
    let rcUpdated = 0;
    const updStmt = db.prepare(`
      UPDATE fleet_rental_rates
         SET fully_wet_rate_cents = COALESCE(fully_wet_rate_cents, ?),
             wet_rate_cents = COALESCE(wet_rate_cents, ?),
             dry_rate_cents = COALESCE(dry_rate_cents, ?),
             source_label = COALESCE(source_label, ?)
       WHERE asset_id = ?
    `);
    db.transaction(() => {
      for (const c of fleetCards) {
        const asset = byCode.get(alnum(c.ec)) || byReg.get(alnum(c.reg));
        if (!asset || !c.r) continue;
        const tier = c.r.h || c.r.km || c.r.dy;
        if (!tier) continue;
        const fw = tier.fw ? Math.round(tier.fw * 100) : null;
        const w = tier.w ? Math.round(tier.w * 100) : null;
        const d = tier.d ? Math.round(tier.d * 100) : null;
        const res = updStmt.run(fw, w, d, c.label || null, asset.id);
        if (res.changes > 0) rcUpdated++;
      }
    })();
    console.log(`  + Enriched ${rcUpdated} rate cards from rate_cards.json`);
  }

  // 6. Import Standard Consumption Bands (Econ / Typ / Heavy) from Fleet_Rental_Prices_2026_finalz.xlsx
  if (fs.existsSync(XLSX_PATH)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(XLSX_PATH);
    const ws = wb.getWorksheet('Fuel Rates');
    if (ws) {
      let hdrRowIdx = -1;
      const COL = {};
      ws.eachRow((row, rowNumber) => {
        if (hdrRowIdx > 0) return;
        const vals = row.values;
        if (Array.isArray(vals) && vals.some((v) => String(v || '').trim() === 'Cons Typ')) {
          hdrRowIdx = rowNumber;
          vals.forEach((h, i) => {
            const k = String(h || '').trim();
            if (k) COL[k] = i;
          });
        }
      });

      if (hdrRowIdx > 0) {
        let bandUpdated = 0;
        const updBand = db.prepare(`
          UPDATE fleet_rental_rates
             SET fuel_cons_econ = ?,
                 fuel_cons_typ = ?,
                 fuel_cons_heavy = ?,
                 fuel_cons_basis = ?
           WHERE asset_id = ?
        `);
        const insBand = db.prepare(`
          INSERT INTO fleet_rental_rates (id, asset_id, category_name, rate_basis, rate_cents, fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
        `);

        const cellNum = (v) => {
          if (v == null) return null;
          if (typeof v === 'object' && v.result !== undefined) return Number(v.result);
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const cellStr = (v) => {
          if (v == null) return '';
          if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim();
          return String(v).trim();
        };

        db.transaction(() => {
          ws.eachRow((row, rowNumber) => {
            if (rowNumber <= hdrRowIdx) return;
            const ec = cellStr(row.getCell(COL['E&C No']).value);
            const reg = cellStr(row.getCell(COL['Reg No']).value);
            const unit = cellStr(row.getCell(COL['Unit']).value);
            let econ = cellNum(row.getCell(COL['Cons Econ']).value);
            let typ = cellNum(row.getCell(COL['Cons Typ']).value);
            let heavy = cellNum(row.getCell(COL['Cons Heavy']).value);

            if (!ec && !reg) return;
            if (econ == null || typ == null || heavy == null) return;
            if (econ === 0 && typ === 0 && heavy === 0) return;

            let basis = 'hr';
            if (unit === 'km/L') {
              if (econ <= 0 || typ <= 0 || heavy <= 0) return;
              econ = Math.round((1 / econ) * 1e6) / 1e6;
              typ = Math.round((1 / typ) * 1e6) / 1e6;
              heavy = Math.round((1 / heavy) * 1e6) / 1e6;
              basis = 'km';
            } else if (unit === 'L/hr') {
              econ = Math.round(econ * 1e6) / 1e6;
              typ = Math.round(typ * 1e6) / 1e6;
              heavy = Math.round(heavy * 1e6) / 1e6;
              basis = 'hr';
            } else {
              return;
            }

            const asset = byCode.get(alnum(ec)) || byReg.get(alnum(reg));
            if (!asset) return;

            const r = updBand.run(econ, typ, heavy, basis, asset.id);
            if (r.changes > 0) {
              bandUpdated++;
            } else {
              insBand.run(`rate-band-${asset.id}`, asset.id, asset.category || 'Fleet', basis === 'km' ? 'PER_KM' : 'HOURLY', econ, typ, heavy, basis);
              bandUpdated++;
            }
          });
        })();
        console.log(`  + Populated standard consumption bands (Econ/Typ/Heavy) on ${bandUpdated} vehicles from Fuel Rates sheet`);
      }
    }
  }

  // Fallback category-based consumption bands for any remaining rate cards without a band
  db.exec(`
    UPDATE fleet_rental_rates
       SET fuel_cons_basis = CASE WHEN rate_basis IN ('PER_KM', 'KM', 'perkm') THEN 'km' ELSE 'hr' END,
           fuel_cons_econ = CASE WHEN rate_basis IN ('PER_KM', 'KM', 'perkm') THEN 0.16 ELSE 6.5 END,
           fuel_cons_typ = CASE WHEN rate_basis IN ('PER_KM', 'KM', 'perkm') THEN 0.22 ELSE 9.0 END,
           fuel_cons_heavy = CASE WHEN rate_basis IN ('PER_KM', 'KM', 'perkm') THEN 0.28 ELSE 12.2 END
     WHERE fuel_cons_typ IS NULL;
  `);

  // 7. Populate fleet_vehicle_allocations from fleet_asset_assignments if empty
  const allocCnt = db.prepare('SELECT COUNT(*) n FROM fleet_vehicle_allocations').get().n;
  if (allocCnt === 0) {
    const assignments = db.prepare(`
      SELECT fa.*, p.name AS project_name, a.category AS machine_type
        FROM fleet_asset_assignments fa
        LEFT JOIN projects p ON p.id = fa.project_id
        LEFT JOIN assets a ON a.id = fa.asset_id
    `).all();
    const insAlloc = db.prepare(`
      INSERT OR IGNORE INTO fleet_vehicle_allocations (
        id, dedupe_key, asset_id, vehicle_no, project_id, site_name, month, machine_type, owner_code, basis, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'E&C', ?, 1)
    `);
    let insCount = 0;
    db.transaction(() => {
      for (const a of assignments) {
        const month = String(a.start_date || '2026-08').slice(0, 7);
        const siteName = a.project_name || a.project_code || 'Central';
        const vNo = a.asset_code || `ASSET-${a.asset_id}`;
        const dKey = `${siteName}|${month}|${vNo}`;
        const res = insAlloc.run(`alloc-${a.id}`, dKey, a.asset_id, vNo, a.project_id, siteName, month, a.machine_type || 'Plant', a.billing_type || 'DRY');
        if (res.changes > 0) insCount++;
      }
    })();
    console.log(`  + Backfilled ${insCount} rows into fleet_vehicle_allocations from fleet_asset_assignments`);
  }

  // 7.5 Backfill project_id / target_project_id on fuel_issues from fuel_tanks & fleet_asset_assignments
  db.exec(`
    UPDATE fuel_issues
       SET project_id = COALESCE(project_id, target_project_id, source_project_id, (SELECT t.project_id FROM fuel_tanks t WHERE t.id = COALESCE(fuel_issues.source_tank_id, fuel_issues.bulk_tank_id)))
     WHERE project_id IS NULL;

    UPDATE fuel_issues
       SET project_id = COALESCE(project_id, (
         SELECT fa.project_id FROM fleet_asset_assignments fa
          WHERE fa.asset_id = fuel_issues.asset_id
            AND substr(fuel_issues.issue_date, 1, 10) >= substr(fa.start_date, 1, 10)
            AND (fa.end_date IS NULL OR substr(fuel_issues.issue_date, 1, 10) <= substr(fa.end_date, 1, 10))
          ORDER BY fa.start_date DESC LIMIT 1
       ))
     WHERE project_id IS NULL AND asset_id IS NOT NULL;

    UPDATE fuel_issues
       SET target_project_id = COALESCE(target_project_id, project_id),
           source_project_id = COALESCE(source_project_id, project_id)
     WHERE project_id IS NOT NULL;
  `);

  // 8. Seed site_fuel_budgets for active sites based on monthly consumption so Budget Pace bars work immediately
  const budgetCnt = db.prepare('SELECT COUNT(*) n FROM site_fuel_budgets').get().n;
  if (budgetCnt === 0) {
    const siteMonthly = db.prepare(`
      SELECT COALESCE(target_project_id, project_id, source_project_id) AS pid,
             CAST(strftime('%Y', issue_date) AS INTEGER) AS yr,
             CAST(strftime('%m', issue_date) AS INTEGER) AS mo,
             SUM(litres) AS total_litres
        FROM fuel_issues
       WHERE is_voided = 0 AND COALESCE(target_project_id, project_id, source_project_id) IS NOT NULL
       GROUP BY pid, yr, mo
    `).all();
    const insBudget = db.prepare(`
      INSERT OR IGNORE INTO site_fuel_budgets (project_id, year, month, budget_litres, budget_amount_cents, note, created_by)
      VALUES (?, ?, ?, ?, ?, 'Auto-baselined monthly site fuel budget', 1)
    `);
    let bCount = 0;
    db.transaction(() => {
      for (const sm of siteMonthly) {
        if (!sm.pid || !sm.yr || !sm.mo) continue;
        const budgetL = Math.ceil((sm.total_litres * 1.1) / 100) * 100; // 10% buffer rounded to 100L
        const budgetCents = Math.round(budgetL * 34100);
        const r = insBudget.run(sm.pid, sm.yr, sm.mo, budgetL, budgetCents);
        if (r.changes > 0) bCount++;
      }
    })();
    console.log(`  + Seeded ${bCount} monthly site fuel budgets across project sites`);
  }

  console.log('=== Enrichment Complete ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
