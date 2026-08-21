'use strict';

// Give every imported handover its MR number back.
//
// The storekeeper writes an MR number against every single issue in the tracker — all 299 rows in
// sources/stores/issues.csv carry one. src/migrate/08_stores.js dropped it, and flattened the item
// into free text at the same time:
//
//   desc = itemName + (' — ' + itemDesc) + (' (to ' + issuedTo + ')')
//
// itemKey() strips brackets, so "(to Anura)" falls away harmlessly — but the " — <itemDesc>" tail
// survives into the key, and itemDesc is the SITE or the VEHICLE, not the item ("Mellawagedara" is
// a bridge site; "DAH-2228" is a lorry). So "AC-Belt (45) — Mellawagedara" is keyed apart from the
// receipt of the very same belt, and the item reads minus one while its receipt sits in another row.
//
// This puts the number back on the rows already imported. It changes NO description — the
// recipient's name and the site are information the storekeeper wrote down on purpose, and the
// receipt does not carry them. The link is what was missing, not the words.
//
// Matching is exact and conservative: the description the importer would have built, the same
// issue date, the same quantity. A row that does not match exactly is reported and left alone.
//
//   node scripts/relink_issues_to_mrn.js            # dry run
//   node scripts/relink_issues_to_mrn.js --apply

const fs = require('fs');
const path = require('path');
const { get, all, run, tx, migrate } = require('../src/db');

migrate();   // issues.mrn_no is added by the schema ensure step, which a plain require does not run

const APPLY = process.argv.includes('--apply');
const CSV = path.join(__dirname, '..', 'sources', 'stores', 'issues.csv');

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
const clean = (v) => (v == null ? '' : String(v).trim());

const lines = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
const head = parseLine(lines[0]);
const rows = lines.slice(1).filter(Boolean).map((l) => {
  const v = parseLine(l); const o = {}; head.forEach((h, i) => { o[h] = v[i]; }); return o;
});

// Exactly the string src/migrate/08_stores.js builds, so the row can be found again.
const descOf = (i) => clean(i.itemName)
  + (clean(i.itemDesc) ? ' — ' + clean(i.itemDesc) : '')
  + (clean(i.issuedTo) ? ' (to ' + clean(i.issuedTo) + ')' : '');

const plan = []; const noRef = []; const noMatch = []; const ambiguous = []; const already = [];
for (const i of rows) {
  const mrnNo = clean(i.mrnNum);
  if (!mrnNo) { noRef.push(i); continue; }
  const desc = descOf(i) || '(item)';
  const date = clean(i.issueDateISO) || clean(i.issueDate);
  const qty = Number(i.qty) || 1;
  const hits = all(`SELECT id, mrn_no FROM issues WHERE description = ? AND issue_date = ? AND ABS(qty - ?) < 0.001`,
    desc, date, qty);
  if (!hits.length) { noMatch.push({ i, desc, date, qty }); continue; }
  if (hits.length > 1) {
    // Same item, same day, same quantity, twice — that is the double-entry itself. Both rows are
    // the same handover, so both get the same number; deciding which to keep is a separate call.
    ambiguous.push({ i, desc, hits });
  }
  for (const h of hits) {
    if (clean(h.mrn_no) === mrnNo) { already.push(h.id); continue; }
    plan.push({ id: h.id, desc, date, mrnNo });
  }
}

// Does the number actually reach a receipt? That is the whole point of putting it back.
let resolves = 0; let danglers = 0;
for (const p of plan) {
  const m = get('SELECT id FROM mrn WHERE mrn_no = ?', p.mrnNo);
  if (!m) { danglers++; continue; }
  const g = get(`SELECT COUNT(*) c FROM grn g JOIN mrn_lines ml ON ml.id = g.mrn_line_id WHERE ml.mrn_id = ?`, m.id).c;
  if (g > 0) resolves++;
}

console.log(`TRACKER ISSUES — ${rows.length} rows in the source file`);
console.log(`   ${plan.length} to relink · ${already.length} already carry their number · ${noRef.length} have none`);
console.log(`   of those relinked, ${resolves} reach a recorded receipt, ${danglers} name an MRN this system does not hold`);
if (ambiguous.length) {
  console.log(`\n   ${ambiguous.length} matched MORE THAN ONE issue row — the same handover written twice:`);
  for (const a of ambiguous.slice(0, 8)) console.log(`      ${a.hits.map((h) => '#' + h.id).join(' + ')}  ${a.desc}`);
}
if (noMatch.length) {
  console.log(`\n   ${noMatch.length} source rows matched no issue and are LEFT ALONE:`);
  for (const n of noMatch.slice(0, 8)) console.log(`      ${n.date}  ${String(n.qty).padStart(5)}  ${n.desc.slice(0, 54)}`);
  if (noMatch.length > 8) console.log(`      … and ${noMatch.length - 8} more`);
}

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

tx(() => { for (const p of plan) run('UPDATE issues SET mrn_no = ? WHERE id = ?', p.mrnNo, p.id); });
console.log(`\nAPPLIED — ${plan.length} issues relinked to the MR number the storekeeper wrote.`);
console.log('No description was changed. Next: rebuild the stock so each handover keys to its receipt.');
