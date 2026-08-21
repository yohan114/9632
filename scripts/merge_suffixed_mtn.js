'use strict';

// Fold the "-N" transfer numbers back into the single notes they always were.
//
// Before a transfer could hold more than one item, the store gave each item its own number by
// suffixing: 58631, 58631-2 … 58631-5 is ONE paper note with five items. 93 of the first 190
// rows are like that, across 44 base numbers. Now that mtn_lines exists they can be one note
// each, which is what the paper says and what the storekeeper reads.
//
// The awkward ones are why this is a reviewed step rather than part of the migration: within a
// group the lines do not always agree on where they came from, where they went, or why —
//   58601-3 went to a different site than -1 and -2
//   64965 pulled its three filters off three different machines
//   58605 carried a separate invoice value per line
// All of that survives, because a line carries its own from/to/reason and blank means "same as
// the note". Anything the group disagrees on is pushed DOWN onto every line before the header
// is set, so nothing is averaged away. A group that disagrees on its DATE is skipped entirely —
// two dates is two trips, and merging those really would lose something.
//
//   node scripts/merge_suffixed_mtn.js            # dry run, writes nothing
//   node scripts/merge_suffixed_mtn.js --apply    # commit (back up first)

const { get, all, run, tx } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const BASE = "substr(mtn_no,1,CASE WHEN instr(mtn_no,'-')>0 THEN instr(mtn_no,'-')-1 ELSE length(mtn_no) END)";
const HEADER = ['from_location', 'to_location', 'from_asset_id', 'to_asset_id', 'transferred_by', 'received_by', 'reason'];

const groups = all(`SELECT ${BASE} AS base, COUNT(*) n FROM mtn GROUP BY base HAVING COUNT(*) > 1 ORDER BY base`);

let merged = 0; let skipped = 0; let linesMoved = 0; let pushedDown = 0;
const plan = [];

for (const g of groups) {
  const notes = all(`SELECT * FROM mtn WHERE ${BASE} = ? ORDER BY mtn_no`, g.base);
  const keep = notes[0];                       // the un-suffixed number keeps the note
  const dates = [...new Set(notes.map((n) => String(n.txn_date || '').slice(0, 10)))];
  if (dates.length > 1) {
    skipped++;
    plan.push(`  SKIP ${g.base} — ${notes.length} rows across ${dates.length} dates (${dates.join(', ')}); two dates is two trips`);
    continue;
  }
  // A header field only stays on the note when every row agrees on it. Where they differ the
  // value drops onto each line, so the difference is kept rather than flattened.
  const differing = HEADER.filter((f) => new Set(notes.map((n) => (n[f] == null ? '' : String(n[f])))).size > 1);
  const lines = notes.length;
  merged++; linesMoved += lines - 1; pushedDown += differing.length;
  plan.push(`  MERGE ${g.base}  ${lines} rows → 1 note with ${lines} items`
    + (differing.length ? `  · per-item: ${differing.join(', ')}` : '')
    + `\n         ${notes.map((n) => `${n.mtn_no}: ${String(n.description || '').slice(0, 40)} x${n.qty}`).join('\n         ')}`);

  if (!APPLY) continue;
  tx(() => {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const own = {};
      for (const f of differing) own[f] = n[f];
      if (i === 0) {
        // The kept note's own line takes its share of anything now per-item.
        run(`UPDATE mtn_lines SET from_location = ?, to_location = ?, from_asset_id = ?, to_asset_id = ?, reason = ?
              WHERE mtn_id = ?`,
        own.from_location ?? null, own.to_location ?? null, own.from_asset_id ?? null,
        own.to_asset_id ?? null, own.reason ?? null, keep.id);
        continue;
      }
      const nextNo = (get('SELECT MAX(line_no) m FROM mtn_lines WHERE mtn_id = ?', keep.id).m || 0) + 1;
      run(`UPDATE mtn_lines
              SET mtn_id = ?, line_no = ?,
                  from_location = ?, to_location = ?, from_asset_id = ?, to_asset_id = ?, reason = ?
            WHERE mtn_id = ?`,
      keep.id, nextNo,
      own.from_location ?? null, own.to_location ?? null, own.from_asset_id ?? null,
      own.to_asset_id ?? null, own.reason ?? null, n.id);
      run('DELETE FROM mtn WHERE id = ?', n.id);
    }
    // Clear from the note anything that is now per-item, then rebuild its summary.
    if (differing.length) {
      run(`UPDATE mtn SET ${differing.map((f) => `${f} = NULL`).join(', ')} WHERE id = ?`, keep.id);
    }
    const ls = all('SELECT * FROM mtn_lines WHERE mtn_id = ? ORDER BY line_no, id', keep.id);
    const cats = [...new Set(ls.map((l) => l.category).filter(Boolean))];
    run(`UPDATE mtn SET description = ?, qty = ?, store_item_id = ?, category = ?, category_id = ? WHERE id = ?`,
      ls.length === 1 ? ls[0].description : `${ls[0].description || 'Item'} + ${ls.length - 1} more`,
      Math.round(ls.reduce((s, l) => s + (Number(l.qty) || 0), 0) * 1000) / 1000,
      ls.length === 1 ? ls[0].store_item_id : null,
      cats.length === 1 ? cats[0] : (cats.length ? 'Mixed' : null),
      ls.length === 1 ? ls[0].category_id : null,
      keep.id);
  });
}

console.log(plan.join('\n'));
console.log('\n' + '─'.repeat(70));
console.log(`groups found      : ${groups.length}`);
console.log(`would merge       : ${merged}  (${linesMoved} suffixed numbers folded in)`);
console.log(`skipped           : ${skipped}  (more than one date)`);
console.log(`fields pushed down: ${pushedDown}  (kept per-item rather than flattened)`);
console.log(`notes after       : ${get('SELECT COUNT(*) c FROM mtn').c - (APPLY ? 0 : linesMoved)}`);
console.log(`items total       : ${get('SELECT COUNT(*) c FROM mtn_lines').c}  (unchanged either way — nothing is deleted)`);
console.log(APPLY ? '\nAPPLIED.' : '\nDry run — nothing written. Re-run with --apply to commit (back up first).');
