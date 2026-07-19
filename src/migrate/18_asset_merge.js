'use strict';

// Phase 3 (init 10) — Conservative asset de-duplication. 01_assets minted duplicate
// vehicles (a registered canonical plus usage-created variants like "LB-01 3DX JCB").
// This step folds ONLY the unambiguous groups — those with exactly ONE in_register
// canonical and no variant naming a second distinct plate — into their canonical:
// every assets-FK is repointed, the variant's code is kept as a resolved alias, and
// the variant row is deleted. Ambiguous groups (no/two canonicals, or "TM-12 / TM-17"
// style dual names) are left for manual review (asset_merge_candidates.csv).
// Idempotent: once folded, the group has a single asset and is skipped.

const { get, all, run, tx, db } = require('../db');
const aliases = require('../lib/aliases');
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

function plateOf(a) {
  for (const v of [a.code, a.registration, a.ec_code]) { if (!v) continue; const c = aliases.extractCode(v); if (c) return norm(c); }
  const t = String(a.code || '').trim().split(/\s+/)[0];
  return /^[A-Z]{1,4}-?\d|^\d{2,3}-?\d/i.test(t) ? norm(t) : null;
}
// A variant whose code names a SECOND distinct plate (e.g. "TM-12 / TM-17") is ambiguous.
// A real plate has the hyphen form (AB-1234 or 12-3456); model numbers like "SL50" or
// "3DX" must NOT count, or every "LD-08 (Shantui SL50)" would be wrongly flagged.
function namesSecondPlate(code, groupPlate) {
  const found = (String(code || '').toUpperCase().match(/\b[A-Z]{1,4}-\d{2,4}\b|\b\d{2,3}-\d{3,4}\b/g) || [])
    .map((x) => x.replace(/[^A-Z0-9]/g, ''));
  return [...new Set(found)].some((p) => p !== groupPlate);
}

function runStep() {
  const rep = { groups_total: 0, merged_groups: 0, variants_folded: 0, refs_repointed: 0, skipped_ambiguous: 0 };
  const refCols = assetRefCols();

  const groups = new Map();
  for (const a of all('SELECT id, code, registration, ec_code, in_register FROM assets')) {
    const p = plateOf(a); if (!p) continue;
    if (!groups.has(p)) groups.set(p, []); groups.get(p).push(a);
  }

  tx(() => {
    for (const [plate, members] of groups) {
      if (members.length < 2) continue;
      rep.groups_total++;
      const canon = members.filter((a) => a.in_register === 1);
      const ambiguous = canon.length !== 1 || members.some((a) => namesSecondPlate(a.code, plate));
      if (ambiguous) { rep.skipped_ambiguous++; continue; }
      const base = canon[0];
      for (const v of members) {
        if (v.id === base.id) continue;
        for (const { table, col } of refCols) {
          rep.refs_repointed += run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, base.id, v.id).changes;
        }
        if (v.code && norm(v.code)) {
          run(
            `INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, hit_count, source)
               VALUES (?, ?, ?, 1, 0, 'merge')
             ON CONFLICT(raw_norm) DO UPDATE SET asset_id = excluded.asset_id, resolved = 1`,
            v.code, norm(v.code), base.id
          );
        }
        run('DELETE FROM assets WHERE id = ?', v.id);
        rep.variants_folded++;
      }
      rep.merged_groups++;
    }
  });

  rep.assets_now = get('SELECT COUNT(*) c FROM assets').c;
  return rep;
}

module.exports = { runStep };
