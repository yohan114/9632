'use strict';

// Phase — Researched cross-references (Sri Lankan market, VIC/Sakura).
// The imported data covered most filters; these Sakura equivalents were researched
// + source-verified for high-usage filters that had none, and are stored tagged
// source='research' so the UI flags them as "researched" (confirm before buying).
// Idempotent: inserts each only if the (filter, part number) pair is absent.

const { get, run } = require('../db');
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

// catalogue_id → the filter's HIFI number (guard against a mismatched re-import).
const FINDINGS = [
  { catalogue_id: 1, hifi: 'SO 10058', brand: 'Sakura', part_number: 'C-57380', confidence: 'medium', source_url: 'https://www.oilfilter-crossreference.com/convert/SAKURA/C57380' },
  { catalogue_id: 2, hifi: 'SN 40541', brand: 'Sakura', part_number: 'SFC-5509-10', confidence: 'high', source_url: 'https://www.sakurafilter.com/products/sak001-sfc-5509-10' },
  { catalogue_id: 3, hifi: 'SO 11080', brand: 'Sakura', part_number: 'C-5106', confidence: 'high', source_url: 'https://www.oilfilter-crossreference.com/convert/HIFI-FILTER/SO11080' },
  { catalogue_id: 4, hifi: 'SN 70299', brand: 'Sakura', part_number: 'FS-4301', confidence: 'high', source_url: 'https://www.fuelfilter-crossreference.com/convert/HIFI-FILTER/SN70299' },
  { catalogue_id: 6, hifi: 'SN 40541', brand: 'Sakura', part_number: 'SFC-5509-10', confidence: 'high', source_url: 'https://www.fuelfilter-crossreference.com/convert/WIX/33604' },
  { catalogue_id: 7, hifi: 'SN 5052', brand: 'Sakura', part_number: 'FC-7903', confidence: 'high', source_url: 'https://www.fuelfilter-crossreference.com/convert/FLEETGUARD/FF5052' },
];

function runStep() {
  const rep = { added: 0, skipped: 0 };
  for (const f of FINDINGS) {
    const cat = get('SELECT id, hifi_pn FROM filter_catalogue WHERE id = ?', f.catalogue_id);
    // Only apply if the catalogue row exists and its HIFI number matches (safety).
    if (!cat || normF(cat.hifi_pn).indexOf(normF(f.hifi)) !== 0) { rep.skipped++; continue; }
    const norm = normF(f.part_number);
    if (get('SELECT id FROM filter_xrefs WHERE catalogue_id = ? AND part_number_norm = ?', f.catalogue_id, norm)) { rep.skipped++; continue; }
    run(`INSERT INTO filter_xrefs (catalogue_id, brand, part_number, part_number_norm, ref_type, source, note)
         VALUES (?, ?, ?, ?, 'cross', 'research', ?)`,
      f.catalogue_id, f.brand, f.part_number, norm, `researched (${f.confidence}) · ${f.source_url}`);
    rep.added++;
  }
  return rep;
}

module.exports = { runStep };
