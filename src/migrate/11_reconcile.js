'use strict';

// Phase — Vehicle reconciliation (owner-directed). Merges spelling-variant assets
// into their canonical vehicle, recategorises store-location requests as general
// items, and creates a container job card for a vehicle that has materials but no
// job. Then re-runs the material assignment so everything lands correctly.
// Idempotent (safe to re-run).

const { get, all, run, tx, db } = require('../db');
const aliases = require('../lib/aliases');
const { repointAssetRefs } = require('../lib/asset_repoint');
const norm = aliases.normalize;

// [variant spelling, canonical code]
const MERGES = [
  ['PA-4879 Toyota Crew Cab', 'PA-4879'],
  ['PA-6398 Toyota Crew Cab', 'PA-6398'],
  ['LC-0434 TATA 1613', 'LC-0434'],
  ['PV-6889 TATA 207', 'PV-6889'],
];
const GENERAL_STORES = ['Stores', 'Workshop Stores'];
const CONTAINER_VEHICLES = ['48-8072'];

function assetByCode(code) {
  const n = norm(code);
  if (!n) return null;
  const a = get('SELECT * FROM assets WHERE code_norm = ?', n);
  if (a) return a;
  const al = get('SELECT a.* FROM asset_aliases al JOIN assets a ON a.id = al.asset_id WHERE al.raw_norm = ? AND al.resolved = 1', n);
  return al || null;
}
// Every (table.column) that references assets(id), discovered dynamically.
function assetRefCols() {
  const cols = [];
  for (const t of all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    if (t.name === 'assets') continue;
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all()) {
      if (fk.table === 'assets') cols.push({ table: t.name, col: fk.from });
    }
  }
  return cols;
}
function containerJobNo(startDate) {
  const [y, m] = startDate.split('-');
  const prefix = `${y}/${parseInt(m, 10)}/R/`;
  let max = 0;
  for (const r of all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', prefix + '%')) {
    const s = parseInt(String(r.job_no).split('/').pop(), 10);
    if (Number.isFinite(s) && s > max) max = s;
  }
  return prefix + (max + 1);
}

function runStep() {
  const rep = { merged: 0, refs_repointed: 0, stores_recategorised: 0, container_jobs: 0, skipped: [] };
  const refCols = assetRefCols();

  tx(() => {
    // 1) merge spelling-variant assets into their canonical vehicle
    for (const [variantCode, baseCode] of MERGES) {
      const variant = get('SELECT * FROM assets WHERE code = ?', variantCode) || assetByCode(variantCode);
      const base = assetByCode(baseCode);
      if (!variant || !base || variant.id === base.id) { rep.skipped.push(`merge ${variantCode}→${baseCode}`); continue; }
      // vehicle_monthly_costs is folded (UNIQUE-safe), not blindly moved — see lib/asset_repoint.
      rep.refs_repointed += repointAssetRefs(refCols, variant.id, base.id);
      run(
        `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
           VALUES (?, ?, ?, 1, 0, 'merge')
         ON CONFLICT(raw_norm) DO UPDATE SET asset_id = excluded.asset_id, resolved = 1`,
        variant.code, norm(variant.code), base.id
      );
      run('DELETE FROM assets WHERE id = ?', variant.id);
      rep.merged++;
    }

    // 2) store-location requests → General Items (left unassigned; they're store stock)
    for (const code of GENERAL_STORES) {
      const a = get('SELECT id FROM assets WHERE code = ?', code);
      if (!a) continue;
      rep.stores_recategorised += run(
        "UPDATE mrn_lines SET category = 'General Items' WHERE mrn_id IN (SELECT id FROM mrn WHERE asset_id = ?)",
        a.id
      ).changes;
    }

    // 3) container job card for a vehicle that has materials but no job
    for (const code of CONTAINER_VEHICLES) {
      const a = assetByCode(code);
      if (!a) continue;
      if (get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', a.id).c > 0) { rep.skipped.push(`${code} already has a job`); continue; }
      const rng = get('SELECT MIN(req_date) mn, MAX(req_date) mx FROM mrn WHERE asset_id = ?', a.id);
      if (!rng.mn) { rep.skipped.push(`${code} has no MRNs`); continue; }
      const start = String(rng.mn).slice(0, 10);
      const end = String(rng.mx).slice(0, 10);
      run(
        `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_by,
                                requested_at, completed_at, closed_at, is_historical, synthesized_no)
         VALUES (?, ?, 'repair', ?, 'CLOSED', 'imported', ?, ?, ?, 1, 1)`,
        containerJobNo(start), a.id, `Stores materials for ${a.code} (auto-created container)`, start, end, end
      );
      rep.container_jobs++;
    }
  });

  // 4) re-derive material assignment — merged vehicles' items now reach the real jobs,
  //    and 48-8072's items land on its new container card.
  rep.reassign = require('./09_job_materials').runStep();
  return rep;
}

module.exports = { runStep };
