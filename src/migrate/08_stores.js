'use strict';

// Phase — Stores data import. Loads the legacy Stores database (a full multi-table
// SQLite export: sources/stores/inventory.db) into WorkshopOne's stores schema:
//
//   general_items            -> store_items (is_general=1) + running balance
//   general_item_transactions-> general_item_txns
//   items (MRN request lines)-> mrn + mrn_lines           (grouped by mrnNum)
//   receipts                 -> grn                        (bridged via items.id)
//   issues                   -> issues
//   material_transfers       -> mtn
//   batteries                -> batteries
//   battery_movements        -> battery_events
//
// Vehicle codes resolve to assets through the master registry (read-only), exactly
// like the jobs import. The whole import runs in ONE transaction (all-or-nothing)
// and is guarded so it will not double-import.

const path = require('path');
const Database = require('better-sqlite3');
const { get, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');

const SRC = process.env.STORES_DB || path.resolve(config.root, 'sources/stores/inventory.db');

const clean = (s) => String(s == null ? '' : s).trim();
function isoDate(...cands) {
  for (const c of cands) {
    const s = clean(c);
    let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}
const isoOr = (fallback, ...cands) => isoDate(...cands) || fallback; // for NOT NULL date columns

function purchaseSourceNorm(s) {
  s = clean(s).toLowerCase();
  if (!s) return null;
  // Two consolidated buckets: Head Office (incl. direct purchase) and Local Purchase (incl. local store).
  if (s.includes('direct') || s.includes('head office')) return 'head_office';
  if (s.includes('local')) return 'local_purchase';
  return 'head_office';
}
function batteryStateNorm(s) {
  s = clean(s).toLowerCase();
  if (s === 'installed') return 'installed';
  if (s === 'in store') return 'in_store';
  if (s === 'disposed') return 'decommissioned';
  if (s.includes('hand')) return 'handed_over';
  return s.replace(/[^a-z0-9]+/g, '_') || null;
}
function capacityAh(name) {
  const m = clean(name).match(/(\d+(?:\.\d+)?)\s*(?:ah|amp)/i);
  return m ? parseFloat(m[1]) : null;
}

function runStep() {
  const rep = { skipped: false, store_items: 0, general_txns: 0, mrn: 0, mrn_lines: 0,
    grn: 0, issues: 0, mtn: 0, batteries: 0, battery_events: 0, mtn_no_suffixed: 0 };

  if (get('SELECT COUNT(*) c FROM mrn').c > 0 || get("SELECT COUNT(*) c FROM store_items WHERE is_general = 1").c > 0) {
    rep.skipped = true;
    return rep; // already imported — don't duplicate
  }

  const src = new Database(SRC, { readonly: true, fileMustExist: true });
  const S = (q) => src.prepare(q).all();

  const norm = aliases.normalize;
  const lookupAsset = (v) => {
    const n = norm(v);
    if (!n) return null;
    const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
    if (a) return a.id;
    const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
    return al ? al.asset_id : null;
  };

  try {
    tx(() => {
      // 1) store_items (general catalogue) + running balance from its transactions
      const balByItem = new Map();
      for (const b of S('SELECT itemId, balance FROM general_item_transactions ORDER BY id')) balByItem.set(b.itemId, b.balance); // last wins
      const giMap = new Map(); // src general_items.id -> store_item id
      for (const g of S('SELECT * FROM general_items')) {
        const info = run(
          `INSERT INTO store_items (name, part_number, category, unit, rack, min_stock, is_general, balance)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          clean(g.itemName) || '(unnamed)', clean(g.partNumber) || null, clean(g.category) || null,
          clean(g.unit) || 'nos', clean(g.rackNumber) || null, Number(g.minStock) || 0,
          balByItem.has(g.id) ? (Number(balByItem.get(g.id)) || 0) : 0
        );
        giMap.set(g.id, info.lastInsertRowid);
        rep.store_items++;
      }

      // 2) general_item_txns
      for (const t of S('SELECT * FROM general_item_transactions ORDER BY id')) {
        const sid = giMap.get(t.itemId);
        if (!sid) continue;
        const opening = clean(t.vehicleMachinery).toLowerCase() === 'opening balance';
        const type = opening ? 'opening' : (clean(t.txType).toLowerCase() === 'receive' ? 'receipt' : 'issue');
        const q = Math.abs(Number(t.qty) || 0);
        run(
          `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, unit_price, ref, txn_date)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
          sid, type, type === 'issue' ? -q : q, Number(t.balance) || 0,
          opening ? null : lookupAsset(t.vehicleMachinery),
          clean(t.mrnNum) || clean(t.grnNum) || null, isoOr('2020-01-01', t.txDateISO, t.txDate)
        );
        rep.general_txns++;
      }

      // 3) items -> mrn (grouped by mrnNum) + mrn_lines
      const groups = new Map();
      for (const it of S('SELECT * FROM items ORDER BY id')) {
        const key = clean(it.mrnNum) || ('NOMRN-' + it.id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      const lineByItemId = new Map(); // items.id -> { lineId, mrnId, name }
      const mrnIds = [];
      for (const [mrnNo, rows] of groups) {
        const first = rows[0];
        const info = run(
          `INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES (?, ?, ?, 'received')`,
          mrnNo, isoOr('2020-01-01', first.reqDateISO, first.reqDate, first.createdAt), lookupAsset(first.vehicleMachinery)
        );
        const mrnId = info.lastInsertRowid;
        mrnIds.push(mrnId);
        rep.mrn++;
        for (const it of rows) {
          const desc = clean(it.itemName) + (clean(it.itemDesc) ? ' — ' + clean(it.itemDesc) : '');
          const li = run(
            `INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received, legacy_item_id, category)
             VALUES (?, ?, ?, 'nos', 0, ?, ?)`,
            mrnId, desc || '(item)', Number(it.reqQty) || 0, it.id, clean(it.category) || null
          );
          lineByItemId.set(it.id, { lineId: li.lastInsertRowid, mrnId, name: clean(it.itemName) || null });
          rep.mrn_lines++;
        }
      }

      // 4) receipts -> grn (bridge itemId -> mrn_line via legacy_item_id)
      const recvByLine = new Map();
      for (const r of S('SELECT * FROM receipts ORDER BY id')) {
        const link = lineByItemId.get(r.itemId);
        if (!link) continue;
        run(
          `INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, supplier,
                            invoice_no, invoice_date, delivery_date, purchase_source, purchase_source_norm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          clean(r.grnNumber) || null, link.mrnId, link.lineId, link.name, Number(r.qty) || 0,
          r.unitPrice == null ? null : Number(r.unitPrice), clean(r.supplierName) || null,
          clean(r.invoiceNumber) || null, isoDate(r.invoiceDate), isoDate(r.deliveryDateISO, r.deliveryDate),
          purchaseSourceNorm(r.purchaseSource), purchaseSourceNorm(r.purchaseSource) // consolidated to 2 buckets
        );
        rep.grn++;
        recvByLine.set(link.lineId, (recvByLine.get(link.lineId) || 0) + (Number(r.qty) || 0));
      }
      for (const [lineId, recv] of recvByLine) run('UPDATE mrn_lines SET qty_received = ? WHERE id = ?', recv, lineId);
      // set each MRN's status from its received coverage
      for (const mrnId of mrnIds) {
        const agg = get('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(qty_received),0) r FROM mrn_lines WHERE mrn_id = ?', mrnId);
        const status = agg.r <= 0 ? 'open' : (agg.r >= agg.q ? 'received' : 'partially_received');
        run('UPDATE mrn SET status = ? WHERE id = ?', status, mrnId);
      }

      // 5) issues
      for (const i of S('SELECT * FROM issues ORDER BY id')) {
        const desc = clean(i.itemName)
          + (clean(i.itemDesc) ? ' — ' + clean(i.itemDesc) : '')
          + (clean(i.issuedTo) ? ' (to ' + clean(i.issuedTo) + ')' : '');
        // The MR number ties the handover to the receipt it came out of. Dropping it is what
        // orphaned six items: the receipt keeps the storekeeper's own wording while the issue
        // carries a "— <site>" tail and a "(to <person>)" suffix, so the two never meet.
        run(
          `INSERT INTO issues (asset_id, description, qty, unit_price, issue_date, issued_by, category, mrn_no)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
          lookupAsset(i.vehicleMachinery), desc || '(item)', Number(i.qty) || 1,
          isoOr('2020-01-01', i.issueDateISO, i.issueDate), clean(i.issuedBy) || null, clean(i.category) || null,
          clean(i.mrnNum) || null
        );
        rep.issues++;
      }

      // 6) material_transfers -> mtn (mtn_no is UNIQUE; suffix duplicates)
      const seenMtn = new Map();
      for (const m of S('SELECT * FROM material_transfers ORDER BY id')) {
        const base = clean(m.mtnNum) || ('MTN-' + m.id);
        const n = (seenMtn.get(base) || 0) + 1;
        seenMtn.set(base, n);
        const mtnNo = n === 1 ? base : (base + '-' + n);
        if (n > 1) rep.mtn_no_suffixed++;
        const desc = clean(m.itemName) + (clean(m.itemDesc) ? ' — ' + clean(m.itemDesc) : '');
        run(
          `INSERT INTO mtn (mtn_no, txn_date, description, qty, from_location, to_location,
                            from_asset_id, to_asset_id, transferred_by, received_by, reason, category)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          mtnNo, isoOr('2020-01-01', m.transferDateISO, m.transferDate), desc || null, Number(m.qty) || 0,
          clean(m.fromLocation) || null, clean(m.toLocation) || null,
          lookupAsset(m.fromLocation), lookupAsset(m.toLocation),
          clean(m.transferredBy) || null, clean(m.receivedBy) || null, clean(m.notes) || null, clean(m.category) || null
        );
        rep.mtn++;
      }

      // 7) batteries
      const batMap = new Map();
      for (const b of S('SELECT * FROM batteries')) {
        const info = run(
          `INSERT INTO batteries (serial_no, brand, capacity_ah, condition, purchase_date, warranty_date,
                                  current_asset_id, state, state_norm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          clean(b.serialNumber) || ('NOSERIAL-' + b.id), clean(b.brand) || null, capacityAh(b.itemName),
          clean(b.condition) || null, isoDate(b.purchaseDateISO, b.purchaseDate), isoDate(b.expiryDateISO, b.expiryDate),
          lookupAsset(b.currentVehicle) || lookupAsset(b.itemDesc), clean(b.state) || 'in_store', batteryStateNorm(b.state)
        );
        batMap.set(b.id, info.lastInsertRowid);
        rep.batteries++;
      }

      // 8) battery_movements -> battery_events
      for (const ev of S('SELECT * FROM battery_movements ORDER BY id')) {
        const bid = batMap.get(ev.batteryId);
        if (!bid) continue;
        run(
          `INSERT INTO battery_events (battery_id, event_type, from_asset_id, to_asset_id, reason, mtn_ref, event_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          bid, clean(ev.movementType).toLowerCase() || 'event', lookupAsset(ev.fromLocation), lookupAsset(ev.toLocation),
          clean(ev.notes) || null, clean(ev.mrnNum) || null, isoOr('2020-01-01', ev.movementDateISO, ev.movementDate)
        );
        rep.battery_events++;
      }
    });
  } finally {
    src.close();
  }

  return rep;
}

module.exports = { runStep };
