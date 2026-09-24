'use strict';

// Merge duplicate asset records of the form "ZB-1548(LB-18)" into the real machine.
//
//   node scripts/merge_compound_assets.js          (dry run, default)
//   node scripts/merge_compound_assets.js --apply
//
// The machine was entered once under its registration and once under its fleet code, and a third
// time as the two joined together. Its job cards then split across the records — LB-18's April
// card sat on the compound record while all its cost sat on the real one, so the daily-work
// matcher (which searches within one asset) could never see both.
//
// A record is merged ONLY when its code is literally "X(Y)" and X and Y both resolve to the SAME
// single other asset. That is deliberately strict: codes like "DAH-2230 / DAH-2228" are one MRN
// covering two vehicles, not a duplicate, and merging those would fuse two real machines.

const { get, all, run, tx } = require('../src/db');
const { repointAssetRefs } = require('../src/lib/asset_repoint');

const APPLY = process.argv.includes('--apply');
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const assets = all('SELECT id, code, registration, ec_code FROM assets');
const byIdent = new Map();
for (const a of assets) {
  for (const k of [...new Set([norm(a.code), norm(a.registration), norm(a.ec_code)].filter((x) => x && x.length >= 4))]) {
    if (!byIdent.has(k)) byIdent.set(k, []);
    byIdent.get(k).push(a.id);
  }
}

const pairs = [];
for (const a of assets) {
  const m = String(a.code || '').match(/^\s*([^()[\]]+?)\s*[([]\s*([^()[\]]+?)\s*[)\]]\s*$/);
  if (!m) continue;
  const A = norm(m[1]); const B = norm(m[2]);
  if (!A || !B) continue;
  const common = (byIdent.get(A) || []).filter((i) => (byIdent.get(B) || []).includes(i) && i !== a.id);
  if (common.length !== 1) continue;                       // ambiguous — leave it alone
  const target = get('SELECT id, code, registration FROM assets WHERE id = ?', common[0]);
  pairs.push({ dup: a, target });
}

// Every column in the schema that points at an asset, so nothing is left behind.
const refCols = [];
for (const t of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
  for (const c of all(`PRAGMA table_info("${t.name}")`)) {
    if (/(^|_)asset_id$/.test(c.name) && t.name !== 'assets') refCols.push({ table: t.name, col: c.name });
  }
}

console.log(`compound duplicates found : ${pairs.length}`);
console.log(`asset reference columns   : ${refCols.length}`);
console.log();
for (const p of pairs) {
  const counts = refCols
    .map(({ table, col }) => ({ table, col, n: get(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" = ?`, p.dup.id).c }))
    .filter((x) => x.n > 0);
  console.log(`  #${p.dup.id} ${p.dup.code}  ->  #${p.target.id} ${p.target.code}`);
  if (counts.length) counts.forEach((c) => console.log(`      ${c.table}.${c.col}: ${c.n}`));
  else console.log('      (no references — the record is simply unused)');
}

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

let moved = 0;
tx(() => {
  for (const p of pairs) {
    moved += repointAssetRefs(refCols, p.dup.id, p.target.id);
    // Keep the compound spelling working as an alias so future imports resolve it correctly
    // instead of minting the duplicate all over again.
    const raw = p.dup.code;
    if (!get('SELECT 1 v FROM asset_aliases WHERE raw_norm = ?', norm(raw))) {
      run(`INSERT INTO asset_aliases (raw_text, raw_norm, asset_id, resolved, source)
           VALUES (?, ?, ?, 1, 'compound_merge')`, raw, norm(raw), p.target.id);
    } else {
      run('UPDATE asset_aliases SET asset_id = ?, resolved = 1 WHERE raw_norm = ?', p.target.id, norm(raw));
    }
    run('DELETE FROM assets WHERE id = ?', p.dup.id);
  }
});

console.log(`\nMerged ${pairs.length} record(s); ${moved} reference(s) repointed.`);
for (const p of pairs) {
  console.log(`  ${p.target.code}: ${get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', p.target.id).c} job cards now`);
}
