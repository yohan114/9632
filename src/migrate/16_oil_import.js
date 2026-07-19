'use strict';

// Phase 2 — Oil & lubricant subsystem import. The products / stock_ledger /
// product_prices / service_specs / stock_counts tables were all empty, so oil_cost
// was structurally 0 and the running-hours service-due advisory had nothing to work
// with. This step loads the oilbook export:
//   • products.csv          -> products (+ best-effort prices from reference/oil_prices.csv)
//   • transactions.csv      -> stock_ledger (issues attach to the vehicle's nearest job)
//   • reference/service_specs.csv -> service_specs (per-machine filter/oil quantities)
//   • stock_counts.csv      -> stock_counts
// Oilbook asset ids resolve to our assets via fleet_assets.csv (100% in testing).
// Prices are matched by oil grade (CI4/HD68/80W90/MP140/grease/…); unmatched products
// stay unpriced and are reported so the owner can complete the price list.
// Idempotent: clears the oil tables and re-imports. Run reconcile-costs (15) after.

const { get, all, run, tx } = require('../db');
const aliases = require('../lib/aliases');
const { load, clean } = require('./csv');

const DATE_FLOOR = '2015-01-01';
const todayISO = () => new Date().toISOString().slice(0, 10);
const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').slice(0, 10));
const dayGap = (a, b) => Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000));
const num = (v) => { const n = parseFloat(clean(v)); return Number.isFinite(n) ? n : 0; };

// Oil grade -> unit price (from sources/reference/oil_prices.csv; only clear grades).
const OIL_PRICES = [
  { re: /CI[-\s]?0?4/i, price: 1400 },
  { re: /HD[-\s]?68/i, price: 950 },
  { re: /\b80W[-\s]?90\b/i, price: 1600 },
  { re: /MP[-\s]?140/i, price: 1350 },
  { re: /(MP|HP)[-\s]?90/i, price: 1450 },
  { re: /grease/i, price: 2100 },
  { re: /1888/i, price: 2340 },
];
const priceForProduct = (name) => { for (const p of OIL_PRICES) if (p.re.test(name)) return p.price; return null; };

function lookupAsset(v) {
  const n = aliases.normalize(v);
  if (!n) return null;
  const a = get('SELECT id FROM assets WHERE code_norm = ?', n);
  if (a) return a.id;
  const al = get('SELECT asset_id FROM asset_aliases WHERE raw_norm = ? AND resolved = 1 AND asset_id IS NOT NULL', n);
  return al ? al.asset_id : null;
}

function runStep() {
  const CEIL = todayISO();
  const validDate = (d) => isISO(d) && d >= DATE_FLOOR && d <= CEIL;
  const rep = { products: 0, priced_products: 0, unpriced_products: [], ledger: 0, issues: 0,
    issues_on_job: 0, issues_no_asset: 0, service_specs: 0, stock_counts: 0, assets_resolved: 0 };

  // Oilbook fleet_assets.id -> our asset id (via ec_code / registration).
  const oilAsset = new Map();
  for (const r of load('oil/fleet_assets.csv')) {
    const id = lookupAsset(r.ec_code) || lookupAsset(r.registration);
    if (id) oilAsset.set(String(r.id), id);
  }
  rep.assets_resolved = oilAsset.size;

  tx(() => {
    // Clear (children first) then re-import — these tables are oil-only.
    for (const t of ['stock_ledger', 'stock_counts', 'product_prices', 'service_specs', 'products']) run(`DELETE FROM ${t}`);

    // Products (+ prices).
    const productMap = new Map(); // oilbook product id -> our id
    for (const p of load('oil/products.csv')) {
      const name = clean(p.name);
      if (!name) continue;
      const price = priceForProduct(name);
      const info = run(
        `INSERT INTO products (name, sheet_name, unit, category, reorder_level, unit_price, sort_order, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        name, clean(p.sheet_name) || null, clean(p.unit) || 'L', clean(p.category) || null,
        num(p.reorder_level), price, parseInt(clean(p.sort_order), 10) || 0
      );
      productMap.set(String(p.id), info.lastInsertRowid);
      rep.products++;
      if (price != null) { rep.priced_products++; run('INSERT INTO product_prices (product_id, unit_price, effective_from) VALUES (?, ?, ?)', info.lastInsertRowid, price, '2025-01-01'); }
      else rep.unpriced_products.push(name);
    }

    // Jobs-by-asset for nearest-job attachment (owner's rule: nearest, any distance).
    const jobsByAsset = new Map();
    for (const j of all('SELECT id, asset_id, requested_at, completed_at, closed_at FROM job_cards WHERE asset_id IS NOT NULL')) {
      if (!jobsByAsset.has(j.asset_id)) jobsByAsset.set(j.asset_id, []);
      jobsByAsset.get(j.asset_id).push(j);
    }
    const nearestJob = (assetId, date) => {
      const js = jobsByAsset.get(assetId) || []; if (!js.length) return null;
      let best = null, bg = Infinity;
      for (const j of js) {
        const s = String(j.requested_at).slice(0, 10);
        const e = String(j.closed_at || j.completed_at || j.requested_at).slice(0, 10);
        const g = date >= s && date <= e ? 0 : Math.min(dayGap(date, s), dayGap(date, e));
        if (g < bg) { bg = g; best = j; }
      }
      return best;
    };

    // Transactions -> stock_ledger.
    for (const t of load('oil/transactions.csv')) {
      if (clean(t.voided) === '1') continue;
      const pid = productMap.get(String(clean(t.product_id)));
      if (!pid) continue;
      const kind = clean(t.kind) || 'issue';
      const recv = num(t.qty_received), iss = num(t.qty_issued);
      const qty = kind === 'issue' ? -Math.abs(iss) : Math.abs(recv || iss);
      const d = clean(t.txn_date).slice(0, 10);
      const assetId = clean(t.asset_id) ? (oilAsset.get(String(clean(t.asset_id))) || null) : null;
      let jobId = null;
      if (kind === 'issue' && assetId && validDate(d)) { const j = nearestJob(assetId, d); if (j) jobId = j.id; }
      run(
        `INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, asset_id, project_id, job_id,
                                   consumer, consumer_type, mr_no, mtn_no, voided, legacy_id, txn_date, note)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        pid, kind, qty, num(t.balance_after), assetId, jobId,
        clean(t.description) || null, clean(t.consumer_type) || null, clean(t.mr_no) || null, clean(t.mtn_no) || null,
        parseInt(clean(t.id), 10) || null, isISO(d) ? d : '2025-01-01', clean(t.remark) || null
      );
      rep.ledger++;
      if (kind === 'issue') { rep.issues++; if (jobId) rep.issues_on_job++; else if (!assetId) rep.issues_no_asset++; }
    }

    // Service specs (per machine).
    for (const s of load('reference/service_specs.csv')) {
      const label = clean(s.machine); if (!label) continue;
      const assetId = lookupAsset(label);
      const filters = ['diesel_filter', 'oil_filter', 'air_filter', 'trans_filter', 'hy_filter'].map((k) => num(s[k]));
      const filterCost = filters.reduce((a, b) => a + b, 0);
      run(
        `INSERT INTO service_specs (asset_id, machine_label, filter_cost, diesel_filter, oil_filter, air_filter, trans_filter, hy_filter, oil_qty, hydraulic_qty, transmission_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        assetId, label, filterCost, filters[0], filters[1], filters[2], filters[3], filters[4],
        num(s.oil_qty), num(s.hy_qty), num(s.trans_qty)
      );
      rep.service_specs++;
    }

    // Stock counts.
    for (const c of load('oil/stock_counts.csv')) {
      const pid = productMap.get(String(clean(c.product_id)));
      if (!pid || !clean(c.period)) continue;
      run('INSERT OR IGNORE INTO stock_counts (product_id, period, book_qty, counted_qty, variance, note, counted_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        pid, clean(c.period), num(c.book_qty), num(c.counted_qty), num(c.variance), clean(c.note) || null, clean(c.counted_by) || null);
      rep.stock_counts++;
    }
  });

  return rep;
}

module.exports = { runStep };
