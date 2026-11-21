'use strict';

/**
 * Backfill Service & Filter Plan Reference Data for 9632-Fuel-Merged:
 *   1. Fuel consumption bands (fuel_cons_econ / typ / heavy / basis) from
 *      Fleet_Rental_Prices_2026_finalz.xlsx ("Fuel Rates" sheet) into fleet_rental_rates.
 *   2. Preventive Maintenance Master tasks (Fleet_PM_Master.xlsx) into pm_tasks.
 *   3. Per-vehicle filter replacement schedules from service_jobs + service_filters.
 *
 * Dry-run by default; pass --apply to write.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { migrate, rawDb } = require('../src/db');
const { backfillVehicleFilterSchedules } = require('../src/migrate/060_service_filter_plan');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');

const RATE_XLSX = process.env.RATE_XLSX
  || path.join(WORKSPACE, 'Fuel-System-V2-Ref', 'scripts', 'data', 'Fleet_Rental_Prices_2026_finalz.xlsx');
const PM_XLSX = process.env.PM_XLSX
  || path.join(WORKSPACE, 'Fuel-System-V2', 'data', 'source-sheets', 'Fleet_PM_Master.xlsx');

const alnum = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const r6 = (v) => (v == null ? null : Math.round(Number(v) * 1e6) / 1e6);

function cellVal(cell) {
  if (cell == null) return null;
  if (typeof cell === 'object' && 'result' in cell) return cell.result;
  return cell;
}

async function backfillFuelConsumption(db) {
  if (!fs.existsSync(RATE_XLSX)) {
    console.log('Rate workbook not found:', RATE_XLSX);
    return { matched: 0, updated: 0, skipped: 0 };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(RATE_XLSX);
  const ws = wb.getWorksheet('Fuel Rates');
  if (!ws) {
    console.log('Sheet "Fuel Rates" not found');
    return { matched: 0, updated: 0, skipped: 0 };
  }

  let hdrRowIdx = -1;
  const col = {};
  ws.eachRow((row, rowNumber) => {
    if (hdrRowIdx > 0) return;
    const vals = row.values;
    for (let i = 1; i < vals.length; i++) {
      if (String(cellVal(vals[i]) || '').trim() === 'Cons Typ') {
        hdrRowIdx = rowNumber;
        for (let j = 1; j < vals.length; j++) {
          const k = String(cellVal(vals[j]) || '').trim();
          if (k) col[k] = j;
        }
        break;
      }
    }
  });
  if (hdrRowIdx < 0) return { matched: 0, updated: 0, skipped: 0 };

  const assets = db.prepare('SELECT id, code, ec_code, registration, type, category FROM assets').all();
  const byCode = new Map();
  const byReg = new Map();
  for (const a of assets) {
    for (const k of [a.ec_code, a.code]) {
      const n = alnum(k);
      if (n && !byCode.has(n)) byCode.set(n, a);
    }
    const r = alnum(a.registration);
    if (r && !byReg.has(r)) byReg.set(r, a);
  }

  const existingRateByAsset = new Map(
    db.prepare('SELECT id, asset_id FROM fleet_rental_rates WHERE asset_id IS NOT NULL')
      .all()
      .map((r) => [r.asset_id, r.id])
  );

  const upd = db.prepare(`
    UPDATE fleet_rental_rates
       SET fuel_cons_econ = ?,
           fuel_cons_typ = ?,
           fuel_cons_heavy = ?,
           fuel_cons_basis = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `);
  const ins = db.prepare(`
    INSERT INTO fleet_rental_rates (
      id, asset_id, category_name, rate_basis, rate_cents,
      fuel_cons_econ, fuel_cons_typ, fuel_cons_heavy, fuel_cons_basis,
      equip_type, default_basis, source_label
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'FLEET', 'DRY', ?)
  `);

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  const applyWrites = [];

  for (let r = hdrRowIdx + 1; r <= ws.rowCount; r++) {
    const vals = ws.getRow(r).values;
    const seq = cellVal(vals[col['#']]);
    if (typeof seq !== 'number') continue;

    const ec = String(cellVal(vals[col['E&C No']]) || '').trim();
    const reg = String(cellVal(vals[col['Reg No']]) || '').trim();
    const cat = String(cellVal(vals[col['Category']]) || '').trim() || 'Fleet';
    const unit = String(cellVal(vals[col['Unit']]) || '').trim();
    const econRaw = Number(cellVal(vals[col['Cons Econ']]));
    const typRaw = Number(cellVal(vals[col['Cons Typ']]));
    const heavyRaw = Number(cellVal(vals[col['Cons Heavy']]));

    if (![econRaw, typRaw, heavyRaw].every(Number.isFinite) || (econRaw === 0 && typRaw === 0 && heavyRaw === 0)) {
      skipped++;
      continue;
    }

    let econ, typ, heavy, basis;
    if (unit === 'L/hr') {
      if (!(econRaw > 0 && econRaw <= typRaw && typRaw <= heavyRaw)) { skipped++; continue; }
      econ = r6(econRaw); typ = r6(typRaw); heavy = r6(heavyRaw); basis = 'hr';
    } else if (unit === 'km/L') {
      if (!(econRaw > 0 && typRaw > 0 && heavyRaw > 0 && econRaw >= typRaw && typRaw >= heavyRaw)) { skipped++; continue; }
      econ = r6(1 / econRaw); typ = r6(1 / typRaw); heavy = r6(1 / heavyRaw); basis = 'km';
    } else {
      skipped++;
      continue;
    }

    const asset = (ec && ec !== '—' ? byCode.get(alnum(ec)) : null)
      || (reg && reg !== '—' ? byReg.get(alnum(reg)) : null)
      || (reg && reg !== '—' ? byCode.get(alnum(reg)) : null);
    if (!asset) { skipped++; continue; }
    matched++;
    applyWrites.push({ asset, cat, econ, typ, heavy, basis, label: `${ec || reg} · ${cat}` });
  }

  if (APPLY) {
    db.transaction(() => {
      for (const w of applyWrites) {
        const rateId = existingRateByAsset.get(w.asset.id);
        if (rateId) {
          upd.run(w.econ, w.typ, w.heavy, w.basis, rateId);
        } else {
          const newId = `rate-cons-${w.asset.id}`;
          ins.run(newId, w.asset.id, w.cat, w.basis === 'km' ? 'PER_KM' : 'HOURLY', w.econ, w.typ, w.heavy, w.basis, w.label);
          existingRateByAsset.set(w.asset.id, newId);
        }
        updated++;
      }
    })();
  } else {
    updated = applyWrites.length;
  }

  return { matched, updated, skipped };
}

async function backfillPmMaster(db) {
  if (!fs.existsSync(PM_XLSX)) {
    console.log('PM Master workbook not found:', PM_XLSX);
    return { sheets: 0, tasks: 0 };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(PM_XLSX);
  const SKIP = new Set(['README', 'Fleet Register', 'PM Matrix Summary', 'General Workshop']);
  const rowsToInsert = [];

  for (const ws of wb.worksheets) {
    if (SKIP.has(ws.name)) continue;
    let sort = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const vals = ws.getRow(r).values;
      const taskCode = String(cellVal(vals[1]) || '').trim();
      const intervalLabel = String(cellVal(vals[2]) || '').trim();
      if (!taskCode || taskCode.startsWith('—') || !intervalLabel) continue;
      const m = intervalLabel.match(/(\d+)\s*h/i);
      if (!m) continue;
      const intervalHours = Number(m[1]);
      const description = String(cellVal(vals[5]) || '').trim();
      if (!description) continue;
      const parts = String(cellVal(vals[6]) || '').trim().replace(/^—$/, '') || null;
      const labor = parseFloat(String(cellVal(vals[8]) || ''));
      rowsToInsert.push({
        category: ws.name,
        task_code: taskCode,
        interval_hours: intervalHours,
        interval_label: intervalLabel,
        system: String(cellVal(vals[3]) || '').trim() || null,
        component: String(cellVal(vals[4]) || '').trim() || null,
        description,
        parts,
        labor_hours: Number.isFinite(labor) ? labor : null,
        sort_order: sort++,
      });
    }
  }

  if (APPLY && rowsToInsert.length > 0) {
    const del = db.prepare('DELETE FROM pm_tasks WHERE task_code IS NOT NULL');
    const ins = db.prepare(`
      INSERT INTO pm_tasks (
        category, task_code, interval_hours, interval_label,
        system, component, description, parts, labor_hours, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      del.run();
      for (const t of rowsToInsert) {
        ins.run(t.category, t.task_code, t.interval_hours, t.interval_label, t.system, t.component, t.description, t.parts, t.labor_hours, t.sort_order);
      }
    })();
  }

  return { sheets: wb.worksheets.length - 4, tasks: rowsToInsert.length };
}

(async () => {
  migrate();
  const cons = await backfillFuelConsumption(rawDb);
  const pm = await backfillPmMaster(rawDb);
  let schedules = 0;
  if (APPLY) {
    schedules = backfillVehicleFilterSchedules(rawDb);
  }
  console.log(JSON.stringify({ apply: APPLY, fuelConsumption: cons, pmMaster: pm, filterSchedules: schedules }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
