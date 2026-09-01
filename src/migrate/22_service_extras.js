'use strict';

// Phase — Service Record: add the remaining data (runs after step 21).
//   • service_oils   — oils used per service (1,316), linked by legacy service id
//   • unmatched vehicles — the ~68 service vehicles not in the fleet become assets
//     (in_register=0) so every service links to a vehicle
//   • cross-ref auto-pricing — use FilterCrossRefs + GenuinePrices to price more of
//     the still-missing filters, and attach cross-references as notes
// Idempotent: skips service_oils if already loaded; asset creation is find-or-create;
// pricing only fills rows that are still missing a price.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');

const clean = (v) => (v == null ? null : String(v).trim() || null);
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

function runStep() {
  const rep = { no_file: false, oils: 0, oils_skipped: false, vehicles_created: 0, jobs_linked: 0, priced_xref: 0, priced_genuine: 0, notes_added: 0 };
  const src = path.join(config.root, 'sources/service/service.db');
  if (!fs.existsSync(src)) { rep.no_file = true; return rep; }
  const sdb = new Database(src, { readonly: true });
  try {
    // legacy ServiceID -> workshopone service_jobs.id
    const svcMap = new Map();
    for (const r of all('SELECT id, legacy_service_id FROM service_jobs WHERE legacy_service_id IS NOT NULL')) svcMap.set(r.legacy_service_id, r.id);

    // ---- 1. service oils ---------------------------------------------------
    if (get('SELECT COUNT(*) c FROM service_oils').c > 0) {
      rep.oils_skipped = true;
    } else {
      tx(() => {
        for (const o of sdb.prepare('SELECT * FROM ServiceOils').all()) {
          const sid = svcMap.get(o.ServiceID);
          if (!sid) continue;
          run('INSERT INTO service_oils (service_id, oil_name, oil_type, action_type, qty, price) VALUES (?, ?, ?, ?, ?, ?)',
            sid, clean(o.OilName), clean(o.OilType), clean(o.ActionType), o.Quantity || 0, o.Price || 0);
          rep.oils++;
        }
      });
    }

    // ---- 2. unmatched vehicles -> assets (in_register=0) -------------------
    const veh = new Map();
    for (const v of sdb.prepare('SELECT * FROM Vehicles').all()) veh.set(v.VehicleID, v);
    const srcJob = new Map();
    for (const j of sdb.prepare('SELECT ServiceID, VehicleID FROM ServiceJobs').all()) srcJob.set(j.ServiceID, j.VehicleID);

    tx(() => {
      for (const job of all('SELECT id, legacy_service_id, vehicle_label FROM service_jobs WHERE asset_id IS NULL')) {
        const v = veh.get(srcJob.get(job.legacy_service_id)) || {};
        const ec = clean(v.ECNumber), reg = clean(v.RegistrationNo);
        const codeRaw = ec || reg || clean(job.vehicle_label);
        const codeNorm = aliases.normalize(codeRaw);
        if (!codeNorm) continue;
        let asset = get('SELECT id FROM assets WHERE code_norm = ?', codeNorm)
          || get('SELECT asset_id AS id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', codeNorm);
        if (!asset) {
          const info = run(
            `INSERT INTO assets (code, code_norm, registration, ec_code, brand, type, asset_class, in_register, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
            codeRaw, codeNorm, reg, ec, clean(v.Brand), clean(v.VehicleType) || clean(v.EquipmentDescription),
            (clean(v.VehicleType) || '').toLowerCase().includes('generator') ? 'generator' : 'vehicle'
          );
          asset = { id: info.lastInsertRowid };
          rep.vehicles_created++;
        }
        run('UPDATE service_jobs SET asset_id = ? WHERE id = ?', asset.id, job.id);
        rep.jobs_linked++;
      }
    });

    // ---- 3. cross-ref auto-pricing for still-missing filters ---------------
    const pmap = new Map();
    for (const r of sdb.prepare('SELECT SupplierFilterCode, UnitPriceLKR FROM FilterPrices WHERE UnitPriceLKR > 0').all()) { const k = normF(r.SupplierFilterCode); if (k && !pmap.has(k)) pmap.set(k, r.UnitPriceLKR); }
    const gmap = new Map();
    for (const r of sdb.prepare('SELECT HIFIEquivalent, SourcingPriceInclVAT, RetailPriceExclVAT FROM GenuinePrices').all()) { const k = normF(r.HIFIEquivalent); const price = r.SourcingPriceInclVAT || r.RetailPriceExclVAT; if (k && price > 0 && !gmap.has(k)) gmap.set(k, price); }
    const pnToFilter = new Map(), filterToPns = new Map();
    for (const r of sdb.prepare('SELECT FilterID, NormalizedPN FROM FilterCrossRefs').all()) {
      const k = normF(r.NormalizedPN); if (!k) continue;
      if (!pnToFilter.has(k)) pnToFilter.set(k, r.FilterID);
      if (!filterToPns.has(r.FilterID)) filterToPns.set(r.FilterID, []);
      filterToPns.get(r.FilterID).push(k);
    }
    // catalogue notes: FilterID -> description + cross-references text
    const fInfo = new Map();
    for (const r of sdb.prepare('SELECT FilterID, Description, CrossReferences FROM Filters').all()) fInfo.set(r.FilterID, r);

    tx(() => {
      for (const m of all('SELECT id, filter_no_norm FROM filter_prices')) {
        const fid = pnToFilter.get(m.filter_no_norm);
        // notes from the catalogue (for any matchable filter)
        if (fid && fInfo.has(fid)) {
          const info = fInfo.get(fid);
          const note = clean(info.CrossReferences) || clean(info.Description);
          if (note) { run('UPDATE filter_prices SET notes = COALESCE(notes, ?) WHERE id = ? AND (notes IS NULL OR notes = \'\')', note, m.id); rep.notes_added++; }
        }
      }
      for (const m of all('SELECT id, filter_no_norm FROM filter_prices WHERE COALESCE(unit_price,0) = 0')) {
        const fid = pnToFilter.get(m.filter_no_norm);
        if (!fid || !filterToPns.has(fid)) continue;
        let price = null, source = null;
        for (const pn of filterToPns.get(fid)) { if (pmap.has(pn)) { price = pmap.get(pn); source = 'xref'; break; } }
        if (price == null) for (const pn of filterToPns.get(fid)) { if (gmap.has(pn)) { price = gmap.get(pn); source = 'genuine'; break; } }
        if (price != null) {
          run('UPDATE filter_prices SET unit_price = ?, source = ?, updated_at = datetime(\'now\') WHERE id = ?', price, source, m.id);
          if (source === 'xref') rep.priced_xref++; else rep.priced_genuine++;
        }
      }
    });
  } finally { sdb.close(); }
  return rep;
}

module.exports = { runStep };
