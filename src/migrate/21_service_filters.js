'use strict';

// Phase — Service Record import (filters + prices + service history).
// Reads the standalone Service Record export (sources/service/service.db) and loads:
//   • service_jobs   — 1,571 service records (vehicle resolved to the WorkshopOne fleet)
//   • service_filters — 3,850 filter usages (with normalized filter number)
//   • filter_prices  — the price book: one row per distinct filter number, priced from
//                       the service history (max seen price) else matched from the
//                       supplier FilterPrices catalogue by normalized part number.
// Vehicles are LINKED to existing assets by EC/registration — not duplicated. Idempotent
// (skips if service_jobs already loaded). Missing prices are left NULL for the user to fill.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');

const clean = (v) => (v == null ? null : String(v).trim() || null);
// Normalize a filter number for matching: uppercase, drop parenthetical notes
// like "(2Nos)" / "(VIC Japan)", strip spaces and punctuation.
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

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

function runStep() {
  const rep = { no_file: false, already: false, service_jobs: 0, service_filters: 0, filters: 0, priced: 0, from_service: 0, from_catalogue: 0, assets_linked: 0 };
  const src = path.join(config.root, 'sources/service/service.db');
  if (!fs.existsSync(src)) { rep.no_file = true; return rep; }
  if (get('SELECT COUNT(*) c FROM service_jobs').c > 0) { rep.already = true; return rep; }

  const sdb = new Database(src, { readonly: true });
  try {
    // Supplier price catalogue → normalized part number → unit price.
    const pmap = new Map();
    for (const r of sdb.prepare('SELECT SupplierFilterCode, UnitPriceLKR FROM FilterPrices WHERE UnitPriceLKR > 0').all()) {
      const k = normF(r.SupplierFilterCode);
      if (k && !pmap.has(k)) pmap.set(k, r.UnitPriceLKR);
    }
    // Vehicle id → EC / registration (for asset linking).
    const veh = new Map();
    for (const v of sdb.prepare('SELECT VehicleID, ECNumber, RegistrationNo FROM Vehicles').all()) veh.set(v.VehicleID, v);

    const jobs = sdb.prepare('SELECT * FROM ServiceJobs ORDER BY ServiceID').all();
    const byJob = new Map();
    for (const f of sdb.prepare('SELECT * FROM ServiceFilters ORDER BY ServiceFilterID').all()) {
      if (!byJob.has(f.ServiceID)) byJob.set(f.ServiceID, []);
      byJob.get(f.ServiceID).push(f);
    }

    const catalogue = new Map(); // norm -> { filter_no, cats:Map<cat,count>, uses, maxPrice }

    tx(() => {
      for (const j of jobs) {
        const v = veh.get(j.VehicleID) || {};
        const assetId = findAsset(v.ECNumber, v.RegistrationNo);
        if (assetId) rep.assets_linked++;
        const info = run(
          `INSERT INTO service_jobs (legacy_service_id, vehicle_label, asset_id, service_date, job_no, meter_reading,
                                     next_service_meter, service_type, site_location, repair_details,
                                     parts_subtotal, labour_charge, sundry_amount, grand_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          j.ServiceID, clean(j.VehicleLabel), assetId, clean(j.ServiceDate), clean(j.JobNo), clean(j.MeterReading),
          clean(j.NextServiceMeter), clean(j.ServiceType), clean(j.SiteLocation), clean(j.RepairDetails),
          j.PartsSubtotal || 0, j.LabourCharge || 0, j.SundryAmount || 0, j.GrandTotal || 0
        );
        const sid = info.lastInsertRowid;
        rep.service_jobs++;
        for (const f of (byJob.get(j.ServiceID) || [])) {
          const fn = clean(f.FilterNo);
          if (!fn) continue;
          const norm = normF(fn);
          run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, action_type, qty, price)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            sid, fn, norm, clean(f.FilterCategory), clean(f.ActionType), f.Quantity || 1, f.Price || 0);
          rep.service_filters++;
          if (!norm) continue;
          let e = catalogue.get(norm);
          if (!e) { e = { filter_no: fn, cats: new Map(), uses: 0, maxPrice: 0 }; catalogue.set(norm, e); }
          e.uses++;
          const cat = clean(f.FilterCategory);
          if (cat) e.cats.set(cat, (e.cats.get(cat) || 0) + 1);
          if ((f.Price || 0) > e.maxPrice) e.maxPrice = f.Price;
        }
      }
      // Build the price book from the distinct filter numbers.
      for (const [norm, e] of catalogue) {
        let cat = null, best = -1;
        for (const [c, n] of e.cats) if (n > best) { best = n; cat = c; }
        const price = e.maxPrice > 0 ? e.maxPrice : (pmap.get(norm) != null ? pmap.get(norm) : null);
        run(`INSERT OR IGNORE INTO filter_prices (filter_no, filter_no_norm, category, unit_price, uses, source)
             VALUES (?, ?, ?, ?, ?, 'import')`, e.filter_no, norm, cat, price, e.uses);
        rep.filters++;
        if (price != null && price > 0) { rep.priced++; if (e.maxPrice > 0) rep.from_service++; else rep.from_catalogue++; }
      }
    });
  } finally { sdb.close(); }
  return rep;
}

module.exports = { runStep };
