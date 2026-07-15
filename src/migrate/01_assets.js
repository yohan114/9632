'use strict';

// Phase 1 · Step 3 — Asset registry + alias resolver (the glue).
// Builds ONE canonical asset per fleet register row, registers BOTH of its codes
// (ec_code + registration) so either resolves, unions every vehicle code seen in
// Stores + the job sheets, auto-merges exact matches, auto-creates the rest as
// in_register=0 assets (flagged for review), and seeds the pending alias queue
// from the existing oilbook aliases.

const { get, run, tx, db } = require('../db');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const norm = aliases.normalize;
const ALLOWED_CLASS = ['plant', 'vehicle', 'generator', 'tool', 'machine', 'other'];
const ALLOWED_STATUS = ['active', 'idle', 'under_repair', 'decommissioned'];

function upsertAlias(rawText, rawNorm, assetId, resolved, hitCount, source) {
  if (!rawNorm) return;
  run(
    `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(raw_norm) DO UPDATE SET
       asset_id  = COALESCE(asset_aliases.asset_id, excluded.asset_id),
       resolved  = MAX(asset_aliases.resolved, excluded.resolved),
       hit_count = MAX(asset_aliases.hit_count, excluded.hit_count)`,
    rawText, rawNorm, assetId || null, resolved ? 1 : 0, hitCount || 0, source
  );
}

function runStep() {
  const rep = { projects: 0, register_assets: 0, register_norm_set: 0, code_collisions: 0,
    fleet_no_code: 0, dual_code_aliases: 0, usage_distinct: 0, usage_matched_register: 0,
    usage_created: 0, oil_aliases_resolved: 0, oil_aliases_pending: 0 };

  tx(() => {
    // ---- projects ----
    const projects = load('oil/projects.csv');
    for (const p of projects) {
      run('INSERT INTO projects (name, name_norm, location, active) VALUES (?, ?, ?, ?)',
        clean(p.name), clean(p.name_norm) || norm(p.name), clean(p.location) || null, p.active === '0' ? 0 : 1);
    }
    rep.projects = projects.length;

    // ---- the register norm set (ec ∪ registration) — used to classify usage codes ----
    const fleet = load('oil/fleet_assets.csv');
    const registerNorms = new Set();
    for (const f of fleet) {
      const e = norm(f.ec_code), r = norm(f.registration);
      if (e) registerNorms.add(e);
      if (r) registerNorms.add(r);
    }
    rep.register_norm_set = registerNorms.size;

    // ---- one asset per fleet row; register both codes ----
    for (const f of fleet) {
      const ecN = norm(f.ec_code), regN = norm(f.registration);
      let codeNorm = ecN || regN;                 // canonical key = ec_code_norm (per source guidance)
      let codeRaw = clean(f.ec_code) || clean(f.registration);
      if (!codeNorm) { rep.fleet_no_code++; continue; }
      // guarantee a unique canonical code_norm
      if (get('SELECT id FROM assets WHERE code_norm = ?', codeNorm)) {
        if (regN && !get('SELECT id FROM assets WHERE code_norm = ?', regN)) { codeNorm = regN; codeRaw = clean(f.registration); }
        else { codeNorm = codeNorm + 'DUP' + f.id; rep.code_collisions++; }
      }
      const cls = ALLOWED_CLASS.includes(clean(f.asset_class)) ? clean(f.asset_class) : 'other';
      const st = clean(f.status) === 'registered' ? 'active' : (ALLOWED_STATUS.includes(clean(f.status)) ? clean(f.status) : 'active');
      const info = run(
        `INSERT INTO assets (code, code_norm, ec_code, registration, brand, type, model_no, capacity, yom,
            serial_no, chassis_no, engine_no, asset_class, status, in_register, legacy_fleet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        codeRaw, codeNorm, clean(f.ec_code) || null, clean(f.registration) || null, clean(f.brand) || null,
        clean(f.type) || null, clean(f.model_no) || null, clean(f.capacity) || null, clean(f.yom) || null,
        clean(f.serial_no) || null, clean(f.chassis_no) || null, clean(f.engine_no) || null, cls, st, f.id
      );
      const aid = info.lastInsertRowid;
      rep.register_assets++;
      // register the OTHER code as a resolved alias so both spellings resolve
      if (ecN && ecN !== codeNorm) { upsertAlias(clean(f.ec_code), ecN, aid, true, 0, 'fleet'); rep.dual_code_aliases++; }
      if (regN && regN !== codeNorm) { upsertAlias(clean(f.registration), regN, aid, true, 0, 'fleet'); rep.dual_code_aliases++; }
    }

    // ---- union usage codes from Stores + the job sheets ----
    const usageCols = [
      ['stores/items.csv', 'vehicleMachinery'],
      ['stores/issues.csv', 'vehicleMachinery'],
      ['jobs/c_job.csv', 'Vehicle'],
      ['jobs/service.csv', 'Vehicle No'],
      ['jobs/requested_job.csv', 'Vehicle'],
      ['jobs/daily_work.csv', 'Vehicle No'],
    ];
    const usageReps = new Map(); // norm -> first raw text
    for (const [file, col] of usageCols) {
      for (const r of load(file)) {
        const raw = clean(r[col]); if (!raw) continue;
        const n = norm(raw); if (!n) continue;
        if (!usageReps.has(n)) usageReps.set(n, raw);
      }
    }
    rep.usage_distinct = usageReps.size;
    for (const [n, raw] of usageReps) {
      if (registerNorms.has(n) || get('SELECT id FROM assets WHERE code_norm = ?', n)) { rep.usage_matched_register++; continue; }
      run(`INSERT INTO assets (code, code_norm, in_register, status) VALUES (?, ?, 0, 'active')`, raw, n);
      rep.usage_created++;
    }

    // ---- seed the pending alias queue from the existing oilbook aliases ----
    for (const a of load('oil/aliases.csv')) {
      const raw = clean(a.raw_text); const rn = clean(a.raw_norm) || norm(raw);
      if (!rn) continue;
      const hit = parseInt(a.hit_count, 10) || 0;
      const asset = get('SELECT id FROM assets WHERE code_norm = ?', rn) || (() => {
        const ex = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ?', rn);
        return ex && ex.asset_id ? { id: ex.asset_id } : null;
      })();
      if (asset) { upsertAlias(raw, rn, asset.id, true, hit, 'oilbook'); rep.oil_aliases_resolved++; }
      else { upsertAlias(raw, rn, null, false, hit, 'oilbook'); rep.oil_aliases_pending++; }
    }
  });

  // final tallies from the DB
  rep.total_assets = get('SELECT COUNT(*) c FROM assets').c;
  rep.total_aliases = get('SELECT COUNT(*) c FROM asset_aliases').c;
  rep.aliases_pending = get('SELECT COUNT(*) c FROM asset_aliases WHERE resolved = 0').c;
  rep.aliases_resolved = get('SELECT COUNT(*) c FROM asset_aliases WHERE resolved = 1').c;
  return rep;
}

module.exports = { runStep };
