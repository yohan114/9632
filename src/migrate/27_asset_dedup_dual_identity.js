'use strict';

// De-duplicate vehicles that carry TWO identities — the gap 18_asset_merge leaves.
//
// A registered vehicle has an E&C number in `code` (DC-10) AND a number plate in
// `registration` (28-4314). 18_asset_merge groups by plateOf(), which takes the FIRST
// identity that yields a code — so the canonical lands in group "DC10" while every
// usage-created variant ("28-4314 Double cab", "28-4314 Nissan D20") lands in group
// "284314". The groups never meet, so the vehicle stays split in three.
//
// This step indexes EVERY identity a registered vehicle has (code, registration,
// ec_code) and folds usage-created variants (in_register = 0) onto the canonical that
// claims their plate under any of them.
//
// It keeps 18_asset_merge's safety rules exactly:
//   * only in_register = 0 rows are ever folded — a registered vehicle is never touched;
//   * an identity claimed by TWO registered vehicles is ambiguous → skipped;
//   * a variant naming a SECOND distinct plate ("LP-1579 / LP-1581") is ambiguous → skipped.
// Everything skipped is reported for manual review rather than guessed at.
//
// Folding repoints every assets-FK (vehicle_monthly_costs is summed, not blindly moved,
// so total = Σ components survives), keeps the variant's code as a resolved alias so the
// old spelling still resolves, then deletes the variant row.
//
// Idempotent: once folded there is no variant left to match.
//
// Run:  node src/migrate/run.js --step asset-dedup          (dry run — reports only)
//       node src/migrate/run.js --step asset-dedup --apply  (performs the merge)

const { get, all, run, tx, db } = require('../db');
const aliases = require('../lib/aliases');
const { repointAssetRefs } = require('../lib/asset_repoint');

const norm = aliases.normalize;

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

/** Every normalised identity this row answers to. */
function identitiesOf(a) {
  const out = new Set();
  for (const v of [a.code, a.registration, a.ec_code]) {
    if (!v) continue;
    const c = aliases.extractCode(v);
    if (c) out.add(norm(c));
  }
  return [...out];
}

/** The one plate a usage-created variant is about (its leading code). */
function variantPlate(a) {
  const c = aliases.extractCode(a.code);
  if (c) return norm(c);
  const t = String(a.code || '').trim().split(/\s+/)[0];
  return /^[A-Z]{1,4}-?\d|^\d{2,3}-?\d/i.test(t) ? norm(t) : null;
}

// Same rule as 18_asset_merge: a code naming a SECOND real plate is ambiguous. Model
// numbers ("SL50", "3DX") must not count, only the hyphenated plate forms.
function namesSecondPlate(code, groupPlate) {
  const found = (String(code || '').toUpperCase().match(/\b[A-Z]{1,4}-\d{2,4}\b|\b\d{2,3}-\d{3,4}\b/g) || [])
    .map((x) => x.replace(/[^A-Z0-9]/g, ''));
  return [...new Set(found)].some((p) => p !== groupPlate);
}

function usageCounts(refCols, id) {
  const out = {};
  let total = 0;
  for (const { table, col } of refCols) {
    const n = get(`SELECT COUNT(*) c FROM ${table} WHERE ${col} = ?`, id).c;
    if (n) { out[table] = n; total += n; }
  }
  return { detail: out, total };
}

function runStep(opts = {}) {
  const apply = !!opts.apply;
  const rep = {
    apply,
    registered: 0, variants: 0,
    folds: [], folded: 0, refs_repointed: 0,
    skipped_no_canonical: 0, skipped_second_plate: [], skipped_shared_identity: [],
  };
  const refCols = assetRefCols();
  const rows = all('SELECT id, code, code_norm, registration, ec_code, in_register FROM assets');

  // Index every identity of every REGISTERED vehicle. An identity claimed by two
  // registered vehicles is poisoned — we cannot tell which one a variant means.
  const index = new Map();
  const contested = new Set();
  for (const a of rows) {
    if (!a.in_register) continue;
    rep.registered++;
    for (const ident of identitiesOf(a)) {
      const owner = index.get(ident);
      if (owner && owner.id !== a.id) { contested.add(ident); continue; }
      index.set(ident, a);
    }
  }

  for (const v of rows) {
    if (v.in_register) continue;
    rep.variants++;
    const plate = variantPlate(v);
    if (!plate) { rep.skipped_no_canonical++; continue; }
    if (contested.has(plate)) {
      rep.skipped_shared_identity.push({ variant_id: v.id, code: v.code, plate });
      continue;
    }
    const canonical = index.get(plate);
    if (!canonical) { rep.skipped_no_canonical++; continue; }
    // Already grouped the same way by 18_asset_merge — leave that step's work alone.
    if (identitiesOf(canonical)[0] === plate) { rep.skipped_no_canonical++; continue; }
    if (namesSecondPlate(v.code, plate)) {
      rep.skipped_second_plate.push({ variant_id: v.id, code: v.code, plate, canonical_id: canonical.id, canonical_code: canonical.code });
      continue;
    }
    const use = usageCounts(refCols, v.id);
    rep.folds.push({
      variant_id: v.id, variant_code: v.code, plate,
      canonical_id: canonical.id, canonical_code: canonical.code, canonical_reg: canonical.registration,
      records: use.total, detail: use.detail,
    });
  }

  if (apply && rep.folds.length) {
    tx(() => {
      for (const f of rep.folds) {
        rep.refs_repointed += repointAssetRefs(refCols, f.variant_id, f.canonical_id);
        if (f.variant_code && norm(f.variant_code)) {
          run(
            `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
               VALUES (?, ?, ?, 1, 0, 'merge-dual-identity')
             ON CONFLICT(raw_norm) DO UPDATE SET asset_id = excluded.asset_id, resolved = 1`,
            f.variant_code, norm(f.variant_code), f.canonical_id
          );
        }
        run('DELETE FROM assets WHERE id = ?', f.variant_id);
        rep.folded++;
      }
    });
  }

  rep.assets_now = get('SELECT COUNT(*) c FROM assets').c;
  return rep;
}

module.exports = { runStep, identitiesOf, variantPlate, namesSecondPlate };
