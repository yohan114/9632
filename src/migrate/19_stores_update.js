'use strict';

// Phase — Stores update from the tracker backup JSON (sources/stores/tracker_backup.json).
// The base stores load (08_stores) reads the legacy inventory.db; this step adds the
// NEWER MRN item lines + their receipts that appeared after that export. Each JSON item
// carries its tracker id -> mrn_lines.legacy_item_id, so we import only ids not already
// present (idempotent). MRN headers are found-or-created by mrn_no; receipts become GRN
// rows priced from unitPrice. Vehicles resolve read-only against the registry.
// Run 09 (materials) + reconcile-costs afterwards to allocate + cost the new lines.

const fs = require('fs');
const path = require('path');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');

const clean = (v) => String(v == null ? '' : v).trim();
const isoDate = (...cands) => { for (const c of cands) { const m = clean(c).match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; } return null; };
function purchaseSourceNorm(s) {
  s = clean(s).toLowerCase();
  if (!s) return null;
  if (s.includes('direct') || s.includes('head office')) return 'head_office';
  if (s.includes('local')) return 'local_purchase';
  return 'head_office';
}
const lookupAsset = (v) => {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
};

function runStep() {
  const rep = { json_items: 0, already: 0, new_lines: 0, mrn_created: 0, mrn_reused: 0, grn: 0, no_file: false };
  const file = path.join(config.root, 'sources/stores/tracker_backup.json');
  if (!fs.existsSync(file)) { rep.no_file = true; return rep; }
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  rep.json_items = items.length;

  const existing = new Set(all('SELECT legacy_item_id FROM mrn_lines WHERE legacy_item_id IS NOT NULL').map((r) => r.legacy_item_id));

  // Group the NEW items by their MRN number.
  const groups = new Map();
  for (const it of items) {
    if (existing.has(it.id)) { rep.already++; continue; }
    const key = clean(it.mrnNum) || ('NOMRN-' + it.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  tx(() => {
    for (const [mrnNo, rows] of groups) {
      const first = rows[0];
      let mrnId;
      const existingMrn = get('SELECT id FROM mrn WHERE mrn_no = ?', mrnNo);
      if (existingMrn) { mrnId = existingMrn.id; rep.mrn_reused++; }
      else {
        const info = run(
          `INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES (?, ?, ?, 'open')`,
          mrnNo, isoDate(first.reqDateISO, first.reqDate, first.createdAt) || '2020-01-01', lookupAsset(first.vehicleMachinery)
        );
        mrnId = info.lastInsertRowid; rep.mrn_created++;
      }
      for (const it of rows) {
        const desc = clean(it.itemName) + (clean(it.itemDesc) ? ' — ' + clean(it.itemDesc) : '');
        const li = run(
          `INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received, legacy_item_id, category)
           VALUES (?, ?, ?, 'nos', 0, ?, ?)`,
          mrnId, desc || '(item)', Number(it.reqQty) || 0, it.id, clean(it.category) || null
        );
        const lineId = li.lastInsertRowid;
        rep.new_lines++;
        let recv = 0;
        for (const r of (it.receipts || [])) {
          run(
            `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, supplier,
                              invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            clean(r.grnNumber) || null, mrnId, lineId, clean(it.itemName) || null, Number(r.qty) || 0,
            r.unitPrice == null ? null : Number(r.unitPrice), clean(r.supplierName) || null,
            clean(r.invoiceNumber) || null, isoDate(r.invoiceDate), isoDate(r.deliveryDateISO, r.deliveryDate),
            purchaseSourceNorm(r.purchaseSource), purchaseSourceNorm(r.purchaseSource)
          );
          rep.grn++;
          recv += Number(r.qty) || 0;
        }
        if (recv) run('UPDATE mrn_lines SET qty_received = ? WHERE id = ?', recv, lineId);
      }
      // Derive the header status from actual line coverage (never assume 'received').
      const cov = get('SELECT COALESCE(SUM(qty),0) req, COALESCE(SUM(qty_received),0) rec FROM mrn_lines WHERE mrn_id = ?', mrnId);
      const status = (cov.rec <= 0) ? 'open' : (cov.rec < cov.req ? 'partially_received' : 'received');
      run('UPDATE mrn SET status = ? WHERE id = ?', status, mrnId);
    }
  });

  rep.total_mrn_lines = get('SELECT COUNT(*) c FROM mrn_lines').c;
  return rep;
}

module.exports = { runStep };
