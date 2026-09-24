'use strict';

// Merge an updated storesdb export into WorkshopOne — ONLY what is new or newly filled in.
//
//   node scripts/sync_stores_2026_08_12.js          (dry run, default)
//   node scripts/sync_stores_2026_08_12.js --apply
//
// Three rules, each learned from a defect on a previous re-sync:
//
//  1. NEVER blank what we already hold. 27 receipts have a price in WorkshopOne that the source
//     no longer carries (Rs 58,000 worth). The office typed those in here; the source going quiet
//     is not an instruction to erase them. Only empty fields are filled.
//  2. Match a receipt on its DELIVERY IDENTITY (line + qty + date), not a per-line count. A count
//     cap is blind to a receipt already stored against the wrong item and silently doubles it.
//  3. Reproduce the original importer's own key for transfers, including its duplicate-MTN
//     suffixing (64993, then 64993-2). Keying on the raw number alone both misses later lines of
//     a multi-line note and re-inserts ones already held. Replaying it accounts for all 112 live
//     rows exactly, which is the proof the key is right.

const path = require('path');
const Database = require('better-sqlite3');
const { get, all, run, tx } = require('../src/db');

const SRC = path.join(__dirname, '..', '.tmp-resync', 'inventory.db');
const APPLY = process.argv.includes('--apply');
const S = new Database(SRC, { readonly: true });

const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isoDate = (...c) => {
  for (const x of c) {
    const s = clean(x) || '';
    let m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
};
const isoOr = (fb, ...c) => isoDate(...c) || fb;
const purchaseSourceNorm = (s) => {
  const t = (clean(s) || '').toLowerCase();
  if (!t) return null;
  if (t.includes('direct') || t.includes('head office')) return 'head_office';
  if (t.includes('local')) return 'local_purchase';
  return 'head_office';
};
const lookupAsset = (v) => {
  const n = norm(v); if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n); if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
};
// The source parks a purchase-source word ("HeadOffice") in the GRN-number field on 136 rows.
// That is not a GRN number and must not land in the column the storekeeper reads.
const realGrnNo = (v) => { const s = clean(v); return s && /[0-9]/.test(s) ? s : null; };

const report = { grn_insert: [], grn_fill: [], mtn_insert: [], skipped_price_erase: [], skipped_junk_grn: 0 };

// ---------------------------------------------------------------- receipts --
const lineByItem = new Map(all('SELECT id, legacy_item_id FROM mrn_lines WHERE legacy_item_id IS NOT NULL')
  .map((r) => [String(r.legacy_item_id), r.id]));

const liveByDelivery = new Map();
for (const r of all('SELECT id, mrn_line_id, qty, unit_price, grn_no, invoice_no, invoice_date, supplier, delivery_date FROM grn')) {
  const k = [r.mrn_line_id, Number(r.qty) || 0, String(r.delivery_date || '').slice(0, 10)].join('|');
  if (!liveByDelivery.has(k)) liveByDelivery.set(k, []);
  liveByDelivery.get(k).push(r);
}

for (const r of S.prepare('SELECT * FROM receipts ORDER BY id').all()) {
  const lineId = lineByItem.get(String(r.itemId));
  if (!lineId) continue;                        // its request line is not in WorkshopOne
  const d = isoDate(r.deliveryDateISO, r.deliveryDate);
  const key = [lineId, Number(r.qty) || 0, d || ''].join('|');
  const match = (liveByDelivery.get(key) || []).find((x) => !x._taken);

  if (!match) {
    report.grn_insert.push({ r, lineId, d });
    continue;
  }
  match._taken = true;

  const sets = [], params = [], shows = [];
  const srcPrice = r.unitPrice == null || r.unitPrice === '' ? null : Number(r.unitPrice);
  if (match.unit_price == null && srcPrice != null) { sets.push('unit_price = ?'); params.push(srcPrice); shows.push(`price ${srcPrice}`); }
  else if (match.unit_price != null && srcPrice == null) {
    report.skipped_price_erase.push({ id: match.id, kept: match.unit_price, qty: r.qty });
  }
  const g = realGrnNo(r.grnNumber);
  if (!match.grn_no && g) { sets.push('grn_no = ?'); params.push(g); shows.push(`grn ${g}`); }
  else if (!match.grn_no && clean(r.grnNumber) && !g) report.skipped_junk_grn++;
  if (!match.invoice_no && clean(r.invoiceNumber)) { sets.push('invoice_no = ?'); params.push(clean(r.invoiceNumber)); shows.push('invoice'); }
  if (!match.invoice_date && isoDate(r.invoiceDate)) { sets.push('invoice_date = ?'); params.push(isoDate(r.invoiceDate)); shows.push('inv date'); }
  if (!match.supplier && clean(r.supplierName)) { sets.push('supplier = ?'); params.push(clean(r.supplierName)); shows.push('supplier'); }

  if (sets.length) report.grn_fill.push({ id: match.id, sets, params, shows });
}

// ------------------------------------------------------------- transfers ---
const liveMtnNos = new Set(all('SELECT mtn_no FROM mtn').map((r) => String(r.mtn_no)));
const seenMtn = new Map();
for (const m of S.prepare('SELECT * FROM material_transfers ORDER BY id').all()) {
  const base = clean(m.mtnNum) || ('MTN-' + m.id);
  const n = (seenMtn.get(base) || 0) + 1;
  seenMtn.set(base, n);
  const mtnNo = n === 1 ? base : `${base}-${n}`;
  if (!liveMtnNos.has(mtnNo)) report.mtn_insert.push({ m, mtnNo });
}

// ------------------------------------------------------------------ report --
const money = (n) => 'Rs ' + Math.round(n).toLocaleString();
console.log('RECEIPTS');
console.log('  new receipts to insert      :', report.grn_insert.length);
report.grn_insert.forEach((x) => console.log(`     item ${x.r.itemId} · qty ${x.r.qty} · ${x.r.unitPrice} · ${x.d} · grn ${x.r.grnNumber || '-'}`));
console.log('  existing receipts to fill in:', report.grn_fill.length);
const fieldTally = {};
report.grn_fill.forEach((f) => f.shows.forEach((s) => { const k = s.split(' ')[0]; fieldTally[k] = (fieldTally[k] || 0) + 1; }));
console.log('     fields being filled       :', JSON.stringify(fieldTally));
console.log('  prices KEPT (source blank)  :', report.skipped_price_erase.length,
  '=', money(report.skipped_price_erase.reduce((s, x) => s + x.kept * (Number(x.qty) || 0), 0)), 'protected');
console.log('  "HeadOffice"-style grn refs ignored:', report.skipped_junk_grn);
console.log();
console.log('MATERIAL TRANSFERS');
console.log('  new transfer lines to insert:', report.mtn_insert.length);
const byMonth = {};
report.mtn_insert.forEach((x) => { const k = (isoDate(x.m.transferDateISO, x.m.transferDate) || '?').slice(0, 7); byMonth[k] = (byMonth[k] || 0) + 1; });
console.log('     by month                 :', JSON.stringify(byMonth));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

// ------------------------------------------------------------------- apply --
const touchedLines = new Set();
tx(() => {
  for (const f of report.grn_fill) run(`UPDATE grn SET ${f.sets.join(', ')} WHERE id = ?`, ...f.params, f.id);

  for (const x of report.grn_insert) {
    const line = get('SELECT mrn_id, description FROM mrn_lines WHERE id = ?', x.lineId);
    const src = purchaseSourceNorm(x.r.purchaseSource);
    run(
      `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, supplier,
                        invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      realGrnNo(x.r.grnNumber), line.mrn_id, x.lineId, line.description || null, Number(x.r.qty) || 0,
      x.r.unitPrice == null || x.r.unitPrice === '' ? null : Number(x.r.unitPrice),
      clean(x.r.supplierName), clean(x.r.invoiceNumber), isoDate(x.r.invoiceDate), x.d, src, src);
    run('UPDATE mrn_lines SET qty_received = COALESCE(qty_received,0) + ? WHERE id = ?', Number(x.r.qty) || 0, x.lineId);
    touchedLines.add(x.lineId);
  }

  // Re-derive the header status of every MRN whose lines moved.
  const mrnIds = new Set([...touchedLines].map((id) => get('SELECT mrn_id FROM mrn_lines WHERE id = ?', id).mrn_id));
  for (const mid of mrnIds) {
    const open = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND COALESCE(qty_received,0) < qty', mid).c;
    const any = get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ? AND COALESCE(qty_received,0) > 0', mid).c;
    run('UPDATE mrn SET status = ? WHERE id = ?', open === 0 ? 'received' : (any > 0 ? 'partially_received' : 'open'), mid);
  }

  for (const x of report.mtn_insert) {
    const m = x.m;
    const desc = (clean(m.itemName) || '') + (clean(m.itemDesc) ? ' — ' + clean(m.itemDesc) : '');
    run(
      `INSERT INTO mtn (mtn_no, txn_date, description, qty, from_location, to_location,
                        from_asset_id, to_asset_id, transferred_by, received_by, reason, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      x.mtnNo, isoOr('2020-01-01', m.transferDateISO, m.transferDate), desc || null, Number(m.qty) || 0,
      clean(m.fromLocation), clean(m.toLocation), lookupAsset(m.fromLocation), lookupAsset(m.toLocation),
      clean(m.transferredBy), clean(m.receivedBy), clean(m.notes), clean(m.category));
  }
});

console.log('\nApplied.');
console.log('  grn rows now :', get('SELECT COUNT(*) c FROM grn').c);
console.log('  mtn rows now :', get('SELECT COUNT(*) c FROM mtn').c);
console.log('  unpriced grn :', get('SELECT COUNT(*) c FROM grn WHERE unit_price IS NULL').c);
