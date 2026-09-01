'use strict';

// Give tyres and batteries a picklist, and tie the old register to it.
//
// The register has been free text since 2012: 804 spellings of about 170 real tyre sizes, and a
// third of tyre issues (1,467 of 4,283) never reached a price because the words on the line
// matched no price row. The owner's own analysis workbook already did the hard part — it read
// those 804 spellings down to 170 sizes and a fixed type vocabulary — so the catalogue is built
// from the SAME rules, in src/lib/tyre_battery.js, rather than from a second opinion.
//
// Two things happen here, and both are reversible:
//   1. tb_specs is filled with one row per size-and-type (tyre) or rating (battery).
//   2. Every existing issue line is READ ONCE and pointed at the spec it belongs to. No line is
//      edited — only spec_id is set — so the register still says exactly what the storekeeper
//      wrote, and the shelf it belongs to is now known as well.
//
// Prices carry across where the old category_norm had one. A spec that ends up with several
// candidate prices takes the one from the most-used spelling, and says so.
//
//   node scripts/seed_tyre_battery_specs.js            # dry run
//   node scripts/seed_tyre_battery_specs.js --apply

const path = require('path');
const { get, all, run, tx, migrate } = require('../src/db');
const tb = require('../src/lib/tyre_battery');

migrate();

const APPLY = process.argv.includes('--apply');
const WORKBOOK = process.argv.find((a) => a.endsWith('.xlsx'))
  || 'C:/Users/HP/Downloads/TYRE_BATTERY_ISSUE_ANALYSIS.xlsx';

(async () => {
  // ---- 1. the catalogue, from the workbook's own normalisation ------------
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK);
  const cell = (c) => { let v = c.value; if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text || null); return v; };

  const specs = new Map();                       // spec_key -> row
  const addSpec = (row) => { if (row && row.spec_key && !specs.has(row.kind + row.spec_key)) specs.set(row.kind + row.spec_key, row); };

  const ts = wb.getWorksheet('TYRE SPEC SUMMARY');
  for (let r = 4; r <= ts.rowCount; r++) {
    const size = cell(ts.getCell(r, 2)); const type = cell(ts.getCell(r, 3));
    if (!size || String(size).toUpperCase() === 'TOTAL') continue;
    const p = tb.parse('tyre', String(size) + ' ' + String(type || ''));
    // The PARSED size wins over the written one, so the label and the key can never disagree. It
    // matters for the eight workbook sizes that absorbed a quantity — "1100 X 20 X 02" is read as
    // 1100 X 20, and labelling it otherwise would put a tyre nobody sells on the picklist.
    const shown = p.size || String(size).trim();
    addSpec({ kind: 'tyre', size: shown, tyre_type: String(type || 'NOT SPECIFIED').trim() || 'NOT SPECIFIED',
      rating: null, label: shown + (type ? ' · ' + String(type).trim() : ''), spec_key: p.spec_key });
  }
  const bs = wb.getWorksheet('BATTERY SPEC SUMMARY');
  for (let r = 4; r <= bs.rowCount; r++) {
    const rating = cell(bs.getCell(r, 2));
    if (!rating || String(rating).toUpperCase() === 'TOTAL') continue;
    const p = tb.parse('battery', String(rating));
    addSpec({ kind: 'battery', size: null, tyre_type: null, rating: String(rating).trim(),
      label: String(rating).trim(), spec_key: p.spec_key });
  }

  // ---- 2. anything the register knows that the workbook's summary missed --
  // The summary sheets are a rollup; a rare spelling can fall outside them. Nothing in the
  // register should end up with no shelf to stand on, so the leftovers are added too.
  const extra = [];
  for (const row of all(`SELECT kind, category, COUNT(*) n FROM tyre_battery_issues
                          WHERE NULLIF(category,'') IS NOT NULL GROUP BY kind, category`)) {
    const p = tb.parse(row.kind, row.category);
    const k = row.kind + p.spec_key;
    if (specs.has(k)) continue;
    specs.set(k, { kind: row.kind, size: p.size || null, tyre_type: p.tyre_type || null, rating: p.rating || null,
      label: p.label, spec_key: p.spec_key });
    extra.push(row.kind + ' ' + p.label + '  (from ' + row.n + ' line(s) written "' + String(row.category).slice(0, 28) + '")');
  }

  // ---- 2b. a tube and a flap for every tyre size -------------------------
  // The register has been writing these INTO the tyre's description — "750 X 16 TYER /TUBE/COLLER"
  // — because a request could only ever name one thing. They are sized like the tyre they go
  // inside and carry no type: one 750 X 16 tube serves the canvas and the remould alike.
  const tyreSizes = new Set([...specs.values()].filter((s) => s.kind === 'tyre' && s.size).map((s) => s.size));
  for (const size of tyreSizes) {
    for (const kind of ['tube', 'flap']) {
      const p = tb.parse(kind, size);
      addSpec({ kind, size, tyre_type: null, rating: null, label: p.label, spec_key: p.spec_key });
    }
  }

  const list = [...specs.values()];
  console.log(`CATALOGUE — ${list.length} specifications`);
  console.log('   ' + ['tyre', 'tube', 'flap', 'battery']
    .map((k) => k + ' ' + list.filter((s) => s.kind === k).length).join(' · '));
  if (extra.length) {
    console.log(`\n   ${extra.length} the workbook's summary did not carry, taken from the register itself:`);
    for (const e of extra.slice(0, 10)) console.log('      ' + e);
    if (extra.length > 10) console.log(`      … and ${extra.length - 10} more`);
  }

  // ---- 3. what each existing line becomes --------------------------------
  const issues = all(`SELECT id, kind, category, category_norm FROM tyre_battery_issues`);
  const byKey = new Map(list.map((s) => [s.kind + s.spec_key, s]));
  let matched = 0; const unmatched = new Map();
  const assign = new Map();                      // issue id -> spec_key
  for (const i of issues) {
    const p = tb.parse(i.kind, i.category || i.category_norm || '');
    const k = i.kind + p.spec_key;
    if (byKey.has(k)) { matched++; assign.set(i.id, k); }
    else unmatched.set(i.kind + ' ' + (i.category || '(blank)'), (unmatched.get(i.kind + ' ' + (i.category || '(blank)')) || 0) + 1);
  }
  console.log(`\nREGISTER — ${matched} of ${issues.length} lines find their specification`);
  if (unmatched.size) {
    console.log(`   ${unmatched.size} written forms still find none:`);
    for (const [k, n] of [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`      ${String(n).padStart(4)}  ${k.slice(0, 54)}`);
  }

  // ---- 4. prices, carried across from what is already priced -------------
  const priceFor = new Map();
  for (const p of all(`SELECT kind, category, category_norm, unit_price FROM tyre_battery_prices WHERE unit_price IS NOT NULL`)) {
    const k = p.kind + tb.parse(p.kind, p.category || p.category_norm || '').spec_key;
    if (!priceFor.has(k)) priceFor.set(k, []);
    priceFor.get(k).push(p.unit_price);
  }
  // A PRICE IS ONLY CARRIED ACROSS WHEN THE EVIDENCE AGREES. The old price list is keyed by
  // SPELLING, not by tyre, and it contradicts itself: "1000X20 DAG TYRE" is Rs 21,600 while
  // "1000X20 CANVERS DAG TYRE" is Rs 90,860 — the same tyre, four times apart, because the two
  // spellings fell into different clusters when the list was built. Taking the commonest value
  // priced a remould above an original radial, which is nonsense on its face.
  //
  // So where the candidates disagree by more than a rounding, the shelf is left UNPRICED and
  // reported. An unpriced tyre asks the owner for a number; a confidently wrong one does not.
  const TOLERANCE = 0.02;
  let priced = 0; const conflicted = [];
  for (const s of list) {
    const c = priceFor.get(s.kind + s.spec_key);
    if (!c || !c.length) continue;
    const lo = Math.min(...c); const hi = Math.max(...c);
    if (lo > 0 && (hi - lo) / lo > TOLERANCE) {
      conflicted.push({ label: s.kind + ' ' + s.label, lo, hi, n: c.length });
      continue;
    }
    s.unit_price = c[0];
    priced++;
  }
  const coverBefore = get(`SELECT COUNT(*) c FROM tyre_battery_issues i
                            WHERE EXISTS (SELECT 1 FROM tyre_battery_prices p
                                           WHERE p.kind = i.kind AND p.category_norm = i.category_norm
                                             AND p.unit_price IS NOT NULL)`).c;
  const coverAfter = [...assign.values()].filter((k) => byKey.get(k) && byKey.get(k).unit_price != null).length;
  console.log(`\nPRICES — ${priced} of ${list.length} specifications carry one`);
  console.log(`   issue lines that reach a price: ${coverBefore} → ${coverAfter} of ${issues.length}`);
  if (conflicted.length) {
    console.log(`\n   ${conflicted.length} left UNPRICED because the old list disagrees with itself —`);
    console.log('   these need a number from the owner rather than a guess:');
    for (const c of conflicted.sort((a, b) => b.hi / b.lo - a.hi / a.lo).slice(0, 10)) {
      console.log(`      ${c.label.padEnd(38)} Rs ${String(c.lo).padStart(8)} … ${String(c.hi).padStart(8)}  (${c.n} old spellings)`);
    }
    if (conflicted.length > 10) console.log(`      … and ${conflicted.length - 10} more`);
  }

  const stale = { removed: [], kept: [] };
  if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }

  tx(() => {
    for (const s of list) {
      run(`INSERT INTO tb_specs (kind, size, tyre_type, rating, label, spec_key, unit_price, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'workbook')
           -- A price a person has set is never overwritten by a re-run; only a seeded one is.
           ON CONFLICT(kind, spec_key) DO UPDATE SET
             label = excluded.label,
             unit_price = CASE WHEN tb_specs.source = 'workbook' THEN excluded.unit_price
                               ELSE COALESCE(tb_specs.unit_price, excluded.unit_price) END`,
      s.kind, s.size || null, s.tyre_type || null, s.rating || null, s.label, s.spec_key, s.unit_price == null ? null : s.unit_price);
    }
    const idOf = new Map(all('SELECT id, kind, spec_key FROM tb_specs').map((s) => [s.kind + s.spec_key, s.id]));
    for (const [issueId, key] of assign) {
      const id = idOf.get(key);
      if (id) run('UPDATE tyre_battery_issues SET spec_id = ? WHERE id = ?', id, issueId);
    }

    // SWEEP UP WHAT AN EARLIER RUN LEFT BEHIND. This script has been improved since it first ran —
    // the parser used to absorb a quantity into the size and mint "1100 X 20 X 02" — and updating
    // in place never removed those. A shelf the seed no longer produces, that nothing points at
    // and that nobody has priced by hand, was a mistake and is dropped. Anything still referenced
    // stays put: an orphaned issue would be worse than an odd-looking picklist entry.
    const wanted = new Set(list.map((s) => s.kind + s.spec_key));
    for (const s of all(`SELECT id, kind, spec_key, label, source FROM tb_specs`)) {
      if (wanted.has(s.kind + s.spec_key)) continue;
      if (s.source !== 'workbook') { stale.kept.push(s.label + ' (priced by ' + s.source + ')'); continue; }
      const used = get('SELECT COUNT(*) c FROM tyre_battery_issues WHERE spec_id = ?', s.id).c;
      if (used) { stale.kept.push(s.label + ' (' + used + ' issues still point at it)'); continue; }
      run('DELETE FROM tb_specs WHERE id = ?', s.id);
      stale.removed.push(s.label);
    }
  });
  if (stale.removed.length) {
    console.log(`\nSwept up ${stale.removed.length} specifications an earlier run left behind:`);
    for (const l of stale.removed.slice(0, 8)) console.log('   ' + l);
    if (stale.removed.length > 8) console.log(`   … and ${stale.removed.length - 8} more`);
  }
  if (stale.kept.length) {
    console.log(`\n${stale.kept.length} the seed no longer produces were KEPT because something needs them:`);
    for (const l of stale.kept.slice(0, 6)) console.log('   ' + l);
  }
  console.log(`\nAPPLIED — ${list.length} specifications, ${assign.size} register lines tied to one.`);
  console.log('No issue line was edited; only the shelf it belongs to is now recorded.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
