'use strict';

// Incremental re-sync of the Service Record export.
//
// 21_service_filters / 22_service_extras are FIRST-LOAD steps — they bail out once
// service_jobs holds anything, so a refreshed export can never be taken in. This step
// merges an updated dump into a system that is already live:
//
//   • services present at source but not here      → inserted (with filters + oils)
//   • services whose header changed at source      → updated in place
//   • filter / oil lines missing here              → inserted
//   • filter numbers new to the price book         → added, priced from the service
//                                                     history or the supplier catalogue
//
// What it never does:
//   • touch a service created IN the app (legacy_service_id IS NULL);
//   • overwrite a price a storekeeper set — filter_prices only gains rows, and only a
//     NULL/0 price is ever filled;
//   • delete anything. A line that exists here but not at source is REPORTED, not
//     removed, because it may have been added deliberately.
//
// Lines are matched as a multiset (see shapeOf), so re-running inserts nothing and a
// line legitimately recorded twice on one service stays twice.
//
// Run:  node src/migrate/run.js --step service-sync                    (dry run)
//       node src/migrate/run.js --step service-sync --apply
//       node src/migrate/run.js --step service-sync --from <path.db>   (another export)

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');

const clean = (v) => (v == null ? null : String(v).trim() || null);
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

const filterShape = (no, cat, act, qty, price) =>
  ['F', normF(no || ''), (cat || '').toLowerCase().trim(), (act || '').toLowerCase().trim(),
    Number(qty) || 1, Math.round((Number(price) || 0) * 100)].join('|');
const oilShape = (name, type, act, qty, price) =>
  ['O', (name || '').toLowerCase().trim(), (type || '').toLowerCase().trim(), (act || '').toLowerCase().trim(),
    Math.round((Number(qty) || 0) * 100), Math.round((Number(price) || 0) * 100)].join('|');

// Header fields the source owns, with how an EMPTY source value is treated:
//
//   'money' — always taken. The source is authoritative for an imported service, and a
//             correction down to 0 is a real correction.
//   'text'  — taken only when it says something. Overwriting a filled field with blank
//             would destroy data the source simply never captured.
//   'rate'  — taken only when > 0. These are percentages the first import never loaded,
//             so every live row still carries the column DEFAULT (20% / 5%). The source
//             holds 0 for most older records, and writing that 0 back would replace a
//             sensible default with a worse one.
const HEADER = [
  ['vehicle_label', (j) => clean(j.VehicleLabel), 'text'],
  ['service_date', (j) => clean(j.ServiceDate), 'text'],
  ['job_no', (j) => clean(j.JobNo), 'text'],
  ['meter_reading', (j) => clean(j.MeterReading), 'text'],
  ['next_service_meter', (j) => clean(j.NextServiceMeter), 'text'],
  ['service_type', (j) => clean(j.ServiceType), 'text'],
  ['site_location', (j) => clean(j.SiteLocation), 'text'],
  ['upkeeping', (j) => clean(j.UpkeepingStatus), 'text'],
  ['repair_details', (j) => clean(j.RepairDetails), 'text'],
  ['parts_subtotal', (j) => money(j.PartsSubtotal), 'money'],
  ['labour_rate', (j) => money(j.LabourRate), 'rate'],
  ['labour_charge', (j) => money(j.LabourCharge), 'money'],
  ['sundry_rate', (j) => money(j.SundryRate), 'rate'],
  ['sundry_amount', (j) => money(j.SundryAmount), 'money'],
  ['grand_total', (j) => money(j.GrandTotal), 'money'],
];

/** Does this source value carry information worth writing? */
function carriesValue(mode, want) {
  if (mode === 'money') return true;
  if (mode === 'rate') return (Number(want) || 0) > 0;
  return want != null && String(want).trim() !== '';
}

function findAsset(ec, reg) {
  for (const cand of [ec, reg]) {
    const c = clean(cand);
    if (!c) continue;
    const n = aliases.normalize(c);
    if (!n) continue;
    const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
    if (a) return a.id;
    const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
    if (al && al.asset_id) return al.asset_id;
  }
  return null;
}

function runStep(opts = {}) {
  const apply = !!opts.apply;
  const src = opts.source || path.join(config.root, 'sources/service/service.db');
  const rep = {
    apply, source: src, no_file: false,
    source_services: 0, new_services: [], header_updates: [], new_filter_lines: 0, new_oil_lines: 0,
    extra_lines_here: [], assets_linked: 0, assets_created: [], price_book_added: 0, price_book_filled: 0,
  };
  if (!fs.existsSync(src)) { rep.no_file = true; return rep; }

  const sdb = new Database(src, { readonly: true });
  try {
    const veh = new Map();
    for (const v of sdb.prepare('SELECT VehicleID, ECNumber, RegistrationNo FROM Vehicles').all()) veh.set(v.VehicleID, v);
    const filtersBy = new Map();
    for (const f of sdb.prepare('SELECT * FROM ServiceFilters ORDER BY ServiceFilterID').all()) {
      if (!filtersBy.has(f.ServiceID)) filtersBy.set(f.ServiceID, []);
      filtersBy.get(f.ServiceID).push(f);
    }
    const oilsBy = new Map();
    for (const o of sdb.prepare('SELECT * FROM ServiceOils ORDER BY ServiceOilID').all()) {
      if (!oilsBy.has(o.ServiceID)) oilsBy.set(o.ServiceID, []);
      oilsBy.get(o.ServiceID).push(o);
    }
    // Supplier catalogue, for pricing filter numbers the service history never priced.
    const pmap = new Map();
    for (const r of sdb.prepare('SELECT SupplierFilterCode, UnitPriceLKR FROM FilterPrices WHERE UnitPriceLKR > 0').all()) {
      const k = normF(r.SupplierFilterCode);
      if (k && !pmap.has(k)) pmap.set(k, r.UnitPriceLKR);
    }

    const liveByLegacy = new Map();
    for (const r of all('SELECT * FROM service_jobs WHERE legacy_service_id IS NOT NULL')) liveByLegacy.set(r.legacy_service_id, r);

    const jobs = sdb.prepare('SELECT * FROM ServiceJobs ORDER BY ServiceID').all();
    rep.source_services = jobs.length;

    // ---- plan -------------------------------------------------------------
    const plan = { inserts: [], updates: [], filterAdds: [], oilAdds: [] };
    for (const j of jobs) {
      const live = liveByLegacy.get(j.ServiceID);
      const v = veh.get(j.VehicleID) || {};
      if (!live) {
        plan.inserts.push({ job: j, vehicle: v });
        rep.new_services.push({ legacy_id: j.ServiceID, date: clean(j.ServiceDate), job_no: clean(j.JobNo), vehicle: clean(j.VehicleLabel), total: money(j.GrandTotal) });
        continue;
      }
      const diffs = [];
      for (const [col, pick, mode] of HEADER) {
        const want = pick(j);
        if (!carriesValue(mode, want)) continue; // never blank out what we already hold
        const have = live[col] == null ? null : (mode === 'text' ? String(live[col]) : money(live[col]));
        const w = mode === 'text' ? (want == null ? null : String(want)) : want;
        if (String(have) !== String(w)) diffs.push(col);
      }
      if (diffs.length) {
        plan.updates.push({ id: live.id, job: j, diffs });
        rep.header_updates.push({ legacy_id: j.ServiceID, job_no: clean(j.JobNo), date: clean(j.ServiceDate), fields: diffs.join(', ') });
      }
      // line-level top-up
      const liveF = new Map();
      for (const l of all('SELECT filter_no, category, action_type, qty, price FROM service_filters WHERE service_id = ?', live.id)) {
        const k = filterShape(l.filter_no, l.category, l.action_type, l.qty, l.price);
        liveF.set(k, (liveF.get(k) || 0) + 1);
      }
      for (const f of (filtersBy.get(j.ServiceID) || [])) {
        const k = filterShape(f.FilterNo, f.FilterCategory, f.ActionType, f.Quantity, f.Price);
        const have = liveF.get(k) || 0;
        if (have > 0) { liveF.set(k, have - 1); continue; }
        plan.filterAdds.push({ service_id: live.id, f });
      }
      for (const [k, n] of liveF) if (n > 0) rep.extra_lines_here.push({ legacy_id: j.ServiceID, kind: 'filter', shape: k, count: n });

      const liveO = new Map();
      for (const l of all('SELECT oil_name, oil_type, action_type, qty, price FROM service_oils WHERE service_id = ?', live.id)) {
        const k = oilShape(l.oil_name, l.oil_type, l.action_type, l.qty, l.price);
        liveO.set(k, (liveO.get(k) || 0) + 1);
      }
      for (const o of (oilsBy.get(j.ServiceID) || [])) {
        const k = oilShape(o.OilName, o.OilType, o.ActionType, o.Quantity, o.Price);
        const have = liveO.get(k) || 0;
        if (have > 0) { liveO.set(k, have - 1); continue; }
        plan.oilAdds.push({ service_id: live.id, o });
      }
      for (const [k, n] of liveO) if (n > 0) rep.extra_lines_here.push({ legacy_id: j.ServiceID, kind: 'oil', shape: k, count: n });
    }
    rep.new_filter_lines = plan.filterAdds.length + plan.inserts.reduce((n, p) => n + (filtersBy.get(p.job.ServiceID) || []).length, 0);
    rep.new_oil_lines = plan.oilAdds.length + plan.inserts.reduce((n, p) => n + (oilsBy.get(p.job.ServiceID) || []).length, 0);

    if (!apply) return finish(rep); // the finally below closes the source

    // ---- apply ------------------------------------------------------------
    const seenNumbers = new Map(); // norm -> { filter_no, cat, maxPrice, uses }
    const noteNumber = (fn, cat, price) => {
      const n = fn ? normF(fn) : null;
      if (!n) return;
      const e = seenNumbers.get(n) || { filter_no: fn, cat: null, maxPrice: 0, uses: 0 };
      e.uses++;
      if (cat && !e.cat) e.cat = cat;
      if ((Number(price) || 0) > e.maxPrice) e.maxPrice = Number(price) || 0;
      seenNumbers.set(n, e);
    };

    tx(() => {
      for (const p of plan.inserts) {
        const j = p.job, v = p.vehicle;
        let assetId = findAsset(v.ECNumber, v.RegistrationNo);
        if (assetId) rep.assets_linked++;
        else {
          // No fleet match — mint a usage asset so the service still hangs off a vehicle
          // (mirrors 22_service_extras). in_register = 0 marks it as review-worthy.
          const codeRaw = clean(v.ECNumber) || clean(v.RegistrationNo) || clean(j.VehicleLabel);
          const codeNorm = aliases.normalize(codeRaw || '');
          if (codeNorm) {
            const found = get('SELECT id FROM assets WHERE code_norm = ?', codeNorm);
            if (found) { assetId = found.id; rep.assets_linked++; }
            else {
              assetId = run(
                `INSERT INTO assets (code, code_norm, registration, ec_code, asset_class, in_register)
                 VALUES (?, ?, ?, ?, 'vehicle', 0)`,
                codeRaw, codeNorm, clean(v.RegistrationNo), clean(v.ECNumber)).lastInsertRowid;
              rep.assets_created.push({ id: assetId, code: codeRaw });
            }
          }
        }
        const info = run(
          `INSERT INTO service_jobs (legacy_service_id, vehicle_label, asset_id, service_date, job_no, meter_reading,
                                     next_service_meter, service_type, site_location, upkeeping, repair_details,
                                     parts_subtotal, labour_rate, labour_charge, sundry_rate, sundry_amount, grand_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          j.ServiceID, clean(j.VehicleLabel), assetId, clean(j.ServiceDate), clean(j.JobNo), clean(j.MeterReading),
          clean(j.NextServiceMeter), clean(j.ServiceType), clean(j.SiteLocation), clean(j.UpkeepingStatus), clean(j.RepairDetails),
          money(j.PartsSubtotal), money(j.LabourRate), money(j.LabourCharge), money(j.SundryRate), money(j.SundryAmount), money(j.GrandTotal)
        );
        const sid = info.lastInsertRowid;
        for (const f of (filtersBy.get(j.ServiceID) || [])) {
          const fn = clean(f.FilterNo);
          run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            sid, fn, fn ? normF(fn) : null, clean(f.FilterCategory), clean(f.ActionType), f.Quantity || 1, f.Price || 0);
          noteNumber(fn, clean(f.FilterCategory), f.Price);
        }
        for (const o of (oilsBy.get(j.ServiceID) || [])) {
          run('INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price) VALUES (?, ?, ?, ?, ?, ?)',
            sid, clean(o.OilName), clean(o.OilType), clean(o.ActionType), o.Quantity || 0, o.Price || 0);
        }
      }

      for (const u of plan.updates) {
        const sets = [], params = [];
        for (const col of u.diffs) {
          const pick = HEADER.find(([c]) => c === col)[1];
          sets.push(`${col} = ?`);
          params.push(pick(u.job));
        }
        run(`UPDATE service_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params, u.id);
      }

      for (const a of plan.filterAdds) {
        const fn = clean(a.f.FilterNo);
        run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          a.service_id, fn, fn ? normF(fn) : null, clean(a.f.FilterCategory), clean(a.f.ActionType), a.f.Quantity || 1, a.f.Price || 0);
        noteNumber(fn, clean(a.f.FilterCategory), a.f.Price);
      }
      for (const a of plan.oilAdds) {
        run('INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price) VALUES (?, ?, ?, ?, ?, ?)',
          a.service_id, clean(a.o.OilName), clean(a.o.OilType), clean(a.o.ActionType), a.o.Quantity || 0, a.o.Price || 0);
      }

      // Price book: add numbers we have never seen; fill a price only where none is set.
      // A price a storekeeper typed in the app is never overwritten.
      for (const [norm, e] of seenNumbers) {
        const price = e.maxPrice > 0 ? e.maxPrice : (pmap.get(norm) != null ? pmap.get(norm) : null);
        const existing = get('SELECT id, unit_price FROM filter_prices WHERE filter_no_norm = ?', norm);
        if (!existing) {
          run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source)
               VALUES (?, ?, ?, ?, ?, 'import')`, e.filter_no, norm, e.cat, price, e.uses);
          rep.price_book_added++;
        } else if ((existing.unit_price == null || existing.unit_price === 0) && price != null && price > 0) {
          run('UPDATE filter_prices SET unit_price = ?, updated_at = datetime(\'now\') WHERE id = ?', price, existing.id);
          rep.price_book_filled++;
        }
      }
    });
  } finally { sdb.close(); }
  return finish(rep);
}

function finish(rep) {
  rep.services_now = get('SELECT COUNT(*) c FROM service_jobs').c;
  rep.filter_lines_now = get('SELECT COUNT(*) c FROM service_filters').c;
  rep.oil_lines_now = get('SELECT COUNT(*) c FROM service_oils').c;
  return rep;
}

module.exports = { runStep, filterShape, oilShape, HEADER };
