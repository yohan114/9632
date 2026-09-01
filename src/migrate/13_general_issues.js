'use strict';

// Phase — General items issue list (Warehouse_Inventory_Consolidated). Adds each
// issue as a general_item_txns row (store item found/created, txn_type='issue',
// qty negative, asset resolved from the vehicle) ON TOP of existing data, and
// allocates it to a job for that vehicle whose window [start-3 .. close+3] contains
// the issue date (±3 days). Unallocatable issues (no vehicle / unresolved / no
// in-window job) are written to general_issues_unallocated.csv for review.
// Idempotent for THIS source: rows are tagged source='warehouse' and cleared on re-run.

const fs = require('fs');
const path = require('path');
const { get, all, run, tx } = require('../db');
const config = require('../config');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const SLACK = 3;
const SRC_TAG = 'warehouse';
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayGap = (a, b) => Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000));
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10));
const itemNorm = (s) => clean(s).toUpperCase().replace(/\s+/g, ' ');

function lookupAsset(v) {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
}

function runStep() {
  const rep = { rows: 0, items_created: 0, txns: 0, allocated: 0,
    no_vehicle: 0, unresolved: 0, no_date: 0, no_job: 0, cleared_prev: 0 };
  const unalloc = [];

  rep.cleared_prev = run('DELETE FROM general_item_txns WHERE source = ?', SRC_TAG).changes;

  const itemByName = new Map();
  for (const s of all('SELECT id, name FROM store_items')) itemByName.set(itemNorm(s.name), s.id);

  const jobsByAsset = new Map();
  for (const j of all('SELECT id, asset_id, requested_at, completed_at, closed_at FROM job_cards WHERE asset_id IS NOT NULL')) {
    if (!jobsByAsset.has(j.asset_id)) jobsByAsset.set(j.asset_id, []);
    jobsByAsset.get(j.asset_id).push(j);
  }
  const bestJobInWindow = (assetId, date) => {
    const js = jobsByAsset.get(assetId) || [];
    let best = null, bs = null;
    for (const j of js) {
      const s = String(j.requested_at).slice(0, 10);
      const e = String(j.closed_at || j.completed_at || j.requested_at).slice(0, 10);
      if (date < addDays(s, -SLACK) || date > addDays(e, SLACK)) continue;
      const contains = date >= s && date <= e ? 1 : 0;
      const gap = contains ? 0 : Math.min(dayGap(date, s), dayGap(date, e));
      if (!best || contains > bs.contains || (contains === bs.contains && gap < bs.gap)) { best = j; bs = { contains, gap }; }
    }
    return best;
  };

  tx(() => {
    for (const r of load('stores/general_issues.csv')) {
      const item = clean(r.item);
      if (!item) continue;
      rep.rows++;
      const rack = clean(r.rack) || null;
      const vehicle = clean(r.vehicle);
      const date = clean(r.date);
      const qty = Math.abs(parseFloat(clean(r.qty)) || 0);
      const bal = clean(r.balance) === '' ? 0 : (parseFloat(clean(r.balance)) || 0);
      const mr = clean(r.mr_no) || null;

      let sid = itemByName.get(itemNorm(item));
      if (!sid) {
        sid = run("INSERT INTO store_items (name, category, unit, rack, is_general, balance) VALUES (?, 'General Items', 'nos', ?, 1, 0)", item, rack).lastInsertRowid;
        itemByName.set(itemNorm(item), sid);
        rep.items_created++;
      }

      const assetId = vehicle ? lookupAsset(vehicle) : null;
      let jobId = null;
      if (assetId && isISO(date)) { const j = bestJobInWindow(assetId, date); if (j) { jobId = j.id; rep.allocated++; } }

      run(
        `INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, asset_id, job_id, unit_price, ref, txn_date, source)
         VALUES (?, 'issue', ?, ?, ?, ?, NULL, ?, ?, ?)`,
        sid, -qty, bal, assetId || null, jobId, mr, isISO(date) ? date : '2020-01-01', SRC_TAG
      );
      rep.txns++;

      if (!jobId) {
        let reason;
        if (!vehicle) { reason = 'no vehicle'; rep.no_vehicle++; }
        else if (!assetId) { reason = 'vehicle not in registry'; rep.unresolved++; }
        else if (!isISO(date)) { reason = 'no date'; rep.no_date++; }
        else { reason = 'no job within ±3 days'; rep.no_job++; }
        unalloc.push({ item, rack, date, vehicle, qty, reason });
      }
    }
  });

  if (unalloc.length) {
    const q = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = ['Item,Rack,Date,Vehicle,Qty,Reason'].concat(unalloc.map((u) => [u.item, u.rack, u.date, u.vehicle, u.qty, u.reason].map(q).join(',')));
    rep.review_file = path.join(config.root, 'general_issues_unallocated.csv');
    fs.writeFileSync(rep.review_file, out.join('\n') + '\n');
    rep.unallocated_count = unalloc.length;
  }

  rep.total_general_issues = get("SELECT COUNT(*) c FROM general_item_txns WHERE txn_type = 'issue'").c;
  rep.allocated_to_jobs = get("SELECT COUNT(*) c FROM general_item_txns WHERE txn_type = 'issue' AND job_id IS NOT NULL").c;
  return rep;
}

module.exports = { runStep };
