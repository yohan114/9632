'use strict';

// Phase — Fleet vehicle list (Fuel Rates sheet: E&C No + Reg No + category/model/year).
// Adds new vehicles and enriches existing ones (fills any missing ec_code /
// registration / type / brand / model / year and promotes them to the official
// register), and registers BOTH the E&C No and the Reg No as resolved aliases so
// either code resolves to the vehicle. Non-destructive (COALESCE only). Idempotent.
//
// Source = sources/fleet/fuel_rate_vehicles.csv (from "Fleet_Rental_Prices_2026 finalz.xlsx").

const { get, all, run, tx } = require('../db');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const norm = aliases.normalize;

function classify(category) {
  const c = clean(category).toLowerCase();
  if (!c) return 'plant';
  if (/generator|genset/.test(c)) return 'generator';
  if (/trailer/.test(c)) return 'other';
  if (/car|cab|lorry|truck|van|bus|jeep|pickup|pick-up|bowser|tipper|prime mover|motorcycle|motor cycle|\bbike\b|scooter|double cab|crew cab/.test(c)) return 'vehicle';
  return 'plant'; // most E&C fleet are plant / machinery
}
const brandOf = (model) => { const m = clean(model); return m ? m.split(/\s+/)[0] : null; };

function runStep() {
  const rep = { rows: 0, created: 0, enriched: 0, aliases_added: 0, reg_linked: 0, no_change: 0 };

  // Index every existing code (canonical, ec_code, registration) + resolved aliases → asset id.
  const index = new Map();
  const addIndex = (key, id) => { if (key && !index.has(key)) index.set(key, id); };
  for (const a of all('SELECT id, code_norm, ec_code, registration FROM assets')) {
    addIndex(a.code_norm, a.id); addIndex(norm(a.ec_code), a.id); addIndex(norm(a.registration), a.id);
  }
  for (const al of all('SELECT raw_norm, asset_id FROM asset_aliases WHERE resolved = 1 AND asset_id IS NOT NULL')) addIndex(al.raw_norm, al.asset_id);

  function upsertAlias(rawText, assetId) {
    const rn = norm(rawText);
    if (!rn || !assetId) return false;
    run(
      `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
         VALUES (?, ?, ?, 1, 0, 'fuel_rates')
       ON CONFLICT(raw_norm) DO UPDATE SET
         asset_id = COALESCE(asset_aliases.asset_id, excluded.asset_id),
         resolved = MAX(asset_aliases.resolved, excluded.resolved)`,
      rawText, rn, assetId
    );
    addIndex(rn, assetId);
    return true;
  }

  tx(() => {
    for (const r of load('fleet/fuel_rate_vehicles.csv')) {
      const ec = clean(r.ec_no);
      if (!ec) continue;
      rep.rows++;
      const reg = clean(r.reg_no) || null;
      const category = clean(r.category) || null;
      const model = clean(r.model) || null;
      const brand = brandOf(model);
      const year = /^\d{4}$/.test(clean(r.year)) ? clean(r.year) : null;

      const existingId = index.get(norm(ec)) || (reg ? index.get(norm(reg)) : null) || null;

      if (existingId) {
        const before = get('SELECT ec_code, registration, type, brand, model_no, yom, in_register, code_norm FROM assets WHERE id = ?', existingId);
        run(
          `UPDATE assets SET
             ec_code = COALESCE(ec_code, ?),
             registration = COALESCE(registration, ?),
             type = COALESCE(type, ?),
             brand = COALESCE(brand, ?),
             model_no = COALESCE(model_no, ?),
             yom = COALESCE(yom, ?),
             in_register = 1,
             updated_at = datetime('now')
           WHERE id = ?`,
          ec, reg, category, brand, model, year, existingId
        );
        const after = get('SELECT ec_code, registration, type, brand, model_no, yom, in_register FROM assets WHERE id = ?', existingId);
        const changed = JSON.stringify(before) !== JSON.stringify({ ...after, code_norm: before.code_norm });
        if (changed) rep.enriched++; else rep.no_change++;
        // register both codes as aliases so either resolves
        if (norm(ec) !== before.code_norm && upsertAlias(ec, existingId)) rep.aliases_added++;
        if (reg && norm(reg) !== before.code_norm && upsertAlias(reg, existingId)) { rep.aliases_added++; rep.reg_linked++; }
      } else {
        const info = run(
          `INSERT INTO assets (code, code_norm, ec_code, registration, brand, type, model_no, yom, asset_class, status, in_register)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`,
          ec, norm(ec), ec, reg, brand, category, model, year, classify(category)
        );
        const id = info.lastInsertRowid;
        addIndex(norm(ec), id);
        rep.created++;
        if (reg && norm(reg) !== norm(ec) && upsertAlias(reg, id)) { rep.aliases_added++; rep.reg_linked++; }
      }
    }
  });

  rep.total_assets = get('SELECT COUNT(*) c FROM assets').c;
  rep.in_register = get('SELECT COUNT(*) c FROM assets WHERE in_register = 1').c;
  rep.with_ec = get('SELECT COUNT(*) c FROM assets WHERE ec_code IS NOT NULL').c;
  rep.with_reg = get('SELECT COUNT(*) c FROM assets WHERE registration IS NOT NULL').c;
  return rep;
}

module.exports = { runStep };
