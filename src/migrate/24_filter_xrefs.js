'use strict';

// Phase — Filter cross-reference graph. Imports the Filters catalogue (1,139) and
// FilterCrossRefs (3,678) from the Service Record export into filter_catalogue +
// filter_xrefs, giving a per-filter set of equivalent part numbers across the
// brands stocked in the Sri Lankan market (OEM, HIFI, VIC, Sakura, Fleetguard,
// Donaldson, Baldwin, …). Idempotent — skips if already loaded.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { get, run, tx } = require('../db');
const config = require('../config');

const clean = (v) => (v == null ? null : String(v).trim() || null);
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');
// Tidy brand casing (source has "Vic", "vic", "Sakura", "HIFI", "Sf Filter"…).
function brandLabel(b) {
  const t = clean(b);
  if (!t) return null;
  const map = { VIC: 'VIC', SAKURA: 'Sakura', HIFI: 'HIFI', FLEETGUARD: 'Fleetguard', DONALDSON: 'Donaldson', BALDWIN: 'Baldwin', BOSCH: 'Bosch', MANN: 'Mann', 'SF FILTER': 'SF Filter', 'GENUINE PARTS': 'Genuine' };
  return map[t.toUpperCase()] || t;
}

function runStep() {
  const rep = { no_file: false, already: false, catalogue: 0, xrefs: 0, by_brand: {} };
  const src = path.join(config.root, 'sources/service/service.db');
  if (!fs.existsSync(src)) { rep.no_file = true; return rep; }
  if (get('SELECT COUNT(*) c FROM filter_catalogue').c > 0) { rep.already = true; return rep; }
  const sdb = new Database(src, { readonly: true });
  try {
    tx(() => {
      for (const f of sdb.prepare('SELECT * FROM Filters').all()) {
        run(`INSERT OR IGNORE INTO filter_catalogue (id, category, oem_pn, oem_pn_norm, hifi_pn, hifi_pn_norm, description, top_vehicle, fleet_types, uses, cross_refs_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          f.FilterID, clean(f.FilterCategory), clean(f.OEMPartNumber), normF(f.OEMPartNumber),
          clean(f.HIFIPartNumber), normF(f.HIFIPartNumber), clean(f.Description), clean(f.TopVehicleMatch),
          clean(f.CompatibleFleetTypes), f.TotalServiceCount || 0, clean(f.CrossReferences));
        rep.catalogue++;
      }
      for (const x of sdb.prepare('SELECT * FROM FilterCrossRefs').all()) {
        const pn = clean(x.PartNumber);
        if (!pn) continue;
        const brand = brandLabel(x.Brand);
        run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source, note)
             VALUES (?, ?, ?, ?, ?, 'import', ?)`,
          x.FilterID, brand, pn, normF(x.NormalizedPN || pn), clean(x.RefType) || 'cross', clean(x.Note));
        rep.xrefs++;
        if (brand) rep.by_brand[brand] = (rep.by_brand[brand] || 0) + 1;
      }
    });
  } finally { sdb.close(); }
  return rep;
}

module.exports = { runStep };
