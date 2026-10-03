'use strict';

// ===========================================================================
// A month's cost, by month and by vehicle (Reports → Monthly, the dashboard). Total = Labour + Head
// Office + Local Purchase + Oil (+ Services), each in the month the work was done, the goods
// arrived or the oil was issued.
//
// Improvement plan, Step 2b: `ws` keeps it to one workshop, or a list of them (src/lib/scope.js
// wsSql); null is the whole company. Labour goes by its job card; a receipt by its request, else
// the store it came into; oil by its job card, else the store it left.
// ===========================================================================

const { get, all } = require('../db');
const wsSql = (...a) => require('./scope').wsSql(...a);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const OIL_VAL = 'ABS(sl.qty) * COALESCE(sl.unit_price, pr.unit_price, 0)';
// Oil issued for a service is costed inside the service (Service column), so its
// stock-ledger issue is stock-only — excluded from every oil COST aggregation.
const OIL_NOT_SERVICE = "COALESCE(sl.consumer_type,'') <> 'service'";
const GRN_WS = 'COALESCE(m.workshop_id, g.store_id)';
const OIL_WS = 'COALESCE(j.workshop_id, sl.store_id)';

/** Every month's figures, newest first. */
function monthlyRollup(ws) {
  const map = new Map();
  const M = (m) => { if (!map.has(m)) map.set(m, { month: m, labour: 0, head_office: 0, local_purchase: 0, oil: 0, jobs: 0, service: 0 }); return map.get(m); };
  for (const r of all(`SELECT substr(jl.work_date,1,7) m, ROUND(SUM(jl.amount),2) v FROM job_labour jl LEFT JOIN job_cards j ON j.id = jl.job_id
                        WHERE jl.work_date IS NOT NULL${wsSql('j.workshop_id', ws)} GROUP BY m`)) if (r.m) M(r.m).labour = r.v || 0;
  for (const r of all(`SELECT substr(g.delivery_date,1,7) m, g.purchase_source_norm src, ROUND(SUM(g.qty*g.unit_price),2) v
                         FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id
                        WHERE g.unit_price IS NOT NULL AND g.delivery_date IS NOT NULL${wsSql(GRN_WS, ws)} GROUP BY m, src`)) {
    if (!r.m) continue; const o = M(r.m);
    if (r.src === 'head_office') o.head_office += r.v || 0; else if (r.src === 'local_purchase') o.local_purchase += r.v || 0;
  }
  for (const r of all(`SELECT substr(sl.txn_date,1,7) m, ROUND(SUM(${OIL_VAL}),2) v FROM stock_ledger sl
                         JOIN products pr ON pr.id = sl.product_id LEFT JOIN job_cards j ON j.id = sl.job_id
                        WHERE sl.kind='issue' AND sl.txn_date IS NOT NULL AND ${OIL_NOT_SERVICE}${wsSql(OIL_WS, ws)} GROUP BY m`)) if (r.m) M(r.m).oil = r.v || 0;
  for (const r of all(`SELECT substr(requested_at,1,7) m, COUNT(*) c FROM job_cards WHERE requested_at IS NOT NULL${wsSql('workshop_id', ws)} GROUP BY m`)) if (r.m) M(r.m).jobs = r.c || 0;
  // Service records — cost computed live: priced filters (book × qty) + oils + labour + sundry, by service month.
  for (const r of all(`SELECT substr(j.service_date,1,7) m, ROUND(SUM(COALESCE(p.unit_price,0) * COALESCE(f.qty,1)),2) v
                         FROM service_filters f JOIN service_jobs j ON j.id = f.service_id
                         LEFT JOIN filter_prices p ON p.filter_no_norm = f.filter_no_norm
                        WHERE j.service_date IS NOT NULL${wsSql('j.workshop_id', ws)} GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  for (const r of all(`SELECT substr(j.service_date,1,7) m, ROUND(SUM(COALESCE(o.price,0)),2) v
                         FROM service_oils o JOIN service_jobs j ON j.id = o.service_id
                        WHERE j.service_date IS NOT NULL${wsSql('j.workshop_id', ws)} GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  for (const r of all(`SELECT substr(service_date,1,7) m, ROUND(SUM(COALESCE(labour_charge,0)) + SUM(COALESCE(sundry_amount,0)),2) v
                         FROM service_jobs WHERE service_date IS NOT NULL${wsSql('workshop_id', ws)} GROUP BY m`)) if (r.m) M(r.m).service += (r.v || 0);
  const tm = new Date().toISOString().slice(0, 7);
  return [...map.values()]
    .map((o) => ({ ...o, service: r2(o.service), total: r2(o.labour + o.head_office + o.local_purchase + o.oil + o.service) }))
    .filter((o) => o.month <= tm) // drop spurious future-dated (data-error) months
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** Which vehicles cost the most in a month, most first. */
function monthAssets(month, ws) {
  const map = new Map();
  const A = (id) => { if (!map.has(id)) map.set(id, { asset_id: id, labour: 0, material: 0, oil: 0 }); return map.get(id); };
  for (const r of all(`SELECT j.asset_id id, ROUND(SUM(jl.amount),2) v FROM job_labour jl JOIN job_cards j ON j.id=jl.job_id
                        WHERE j.asset_id IS NOT NULL AND substr(jl.work_date,1,7)=?${wsSql('j.workshop_id', ws)} GROUP BY j.asset_id`, month)) A(r.id).labour = r.v || 0;
  for (const r of all(`SELECT m.asset_id id, ROUND(SUM(g.qty*g.unit_price),2) v FROM grn g JOIN mrn m ON m.id=g.mrn_id
                        WHERE m.asset_id IS NOT NULL AND g.unit_price IS NOT NULL AND substr(g.delivery_date,1,7)=?${wsSql(GRN_WS, ws)} GROUP BY m.asset_id`, month)) A(r.id).material = r.v || 0;
  for (const r of all(`SELECT sl.asset_id id, ROUND(SUM(${OIL_VAL}),2) v FROM stock_ledger sl JOIN products pr ON pr.id=sl.product_id
                         LEFT JOIN job_cards j ON j.id = sl.job_id
                        WHERE sl.asset_id IS NOT NULL AND sl.kind='issue' AND ${OIL_NOT_SERVICE} AND substr(sl.txn_date,1,7)=?${wsSql(OIL_WS, ws)} GROUP BY sl.asset_id`, month)) A(r.id).oil = r.v || 0;
  return [...map.values()].map((o) => {
    const a = get('SELECT code, registration, ec_code FROM assets WHERE id=?', o.asset_id);
    return { ...o, asset_code: a ? a.code : '(unlinked)', registration: a ? a.registration : null, ec_code: a ? a.ec_code : null,
      total: r2(o.labour + o.material + o.oil) };
  }).sort((a, b) => b.total - a.total);
}

module.exports = { monthlyRollup, monthAssets, OIL_VAL, OIL_NOT_SERVICE, GRN_WS, OIL_WS };
