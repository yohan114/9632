'use strict';

/**
 * Stage B Pillar 1 — Unpriced GRN & Job Parts Pricing Queue + Price Hints
 *
 * Centralizes last-price hint matching (across priced GRNs, store_items, and issues),
 * queue summaries, unpriced job_parts listing, and atomic bulk pricing cascade into
 * job_cards and vehicle_monthly_costs.
 */

const { get, all, run, tx } = require('../db');
const scope = require('./scope');
const jobstate = require('./jobstate');
const costing = require('./costing');
const stock = require('./stock');
const audit = require('./audit');
const { toInt, toNum } = require('./http');

const n2price = (v) => Math.round((Number(v) || 0) * 100) / 100;
const normDesc = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const alnumDesc = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Build a fast in-memory lookup index for last known unit prices across:
 *   1. Most recent priced GRNs (highest confidence)
 *   2. Catalogue store_items.unit_cost
 *   3. Most recent priced issues
 */
function buildLastPriceLookup() {
  const byStoreItem = new Map();
  const byNorm = new Map();
  const byAlnum = new Map();

  const indexHit = (targetMap, key, hit) => {
    if (!key || targetMap.has(key)) return;
    targetMap.set(key, hit);
  };

  for (const r of all(`
    SELECT description, unit_price,
           COALESCE(delivery_date, grn_date, substr(created_at, 1, 10)) AS dt,
           supplier, store_item_id
      FROM grn
     WHERE unit_price > 0
       AND TRIM(COALESCE(description, '')) <> ''
     ORDER BY COALESCE(delivery_date, grn_date, substr(created_at, 1, 10)) DESC, id DESC
  `)) {
    const price = n2price(r.unit_price);
    if (!(price > 0)) continue;
    const hit = {
      suggested_price: price,
      suggested_source: 'grn',
      suggested_date: r.dt ? String(r.dt).slice(0, 10) : null,
      suggested_supplier: r.supplier || null,
    };
    if (r.store_item_id) indexHit(byStoreItem, Number(r.store_item_id), hit);
    const n = normDesc(r.description);
    if (n) indexHit(byNorm, n, hit);
    const a = alnumDesc(r.description);
    if (a.length >= 4) indexHit(byAlnum, a, hit);
  }

  for (const si of all('SELECT id, name, unit_cost FROM store_items WHERE unit_cost > 0')) {
    const price = n2price(si.unit_cost);
    if (!(price > 0)) continue;
    const hit = {
      suggested_price: price,
      suggested_source: 'store_item',
      suggested_date: null,
      suggested_supplier: null,
    };
    indexHit(byStoreItem, Number(si.id), hit);
    const n = normDesc(si.name);
    if (n) indexHit(byNorm, n, hit);
    const a = alnumDesc(si.name);
    if (a.length >= 4) indexHit(byAlnum, a, hit);
  }

  for (const iss of all(`
    SELECT description, unit_price, issue_date, store_item_id
      FROM issues
     WHERE COALESCE(voided, 0) = 0
       AND unit_price > 0
       AND TRIM(COALESCE(description, '')) <> ''
     ORDER BY issue_date DESC, id DESC
  `)) {
    const price = n2price(iss.unit_price);
    if (!(price > 0)) continue;
    const hit = {
      suggested_price: price,
      suggested_source: 'issue',
      suggested_date: iss.issue_date ? String(iss.issue_date).slice(0, 10) : null,
      suggested_supplier: null,
    };
    if (iss.store_item_id) indexHit(byStoreItem, Number(iss.store_item_id), hit);
    const n = normDesc(iss.description);
    if (n) indexHit(byNorm, n, hit);
    const a = alnumDesc(iss.description);
    if (a.length >= 4) indexHit(byAlnum, a, hit);
  }

  return function suggestFor({ store_item_id, description } = {}) {
    if (store_item_id && byStoreItem.has(Number(store_item_id))) {
      return byStoreItem.get(Number(store_item_id));
    }
    const n = normDesc(description);
    if (n && byNorm.has(n)) return byNorm.get(n);
    const a = alnumDesc(description);
    if (a.length >= 4 && byAlnum.has(a)) return byAlnum.get(a);
    return null;
  };
}

function enrichAwaitingPriceRows(rows, { hintOnly = false, year = null } = {}) {
  const suggestFor = buildLastPriceLookup();
  const yr = year && /^\d{4}$/.test(String(year).trim()) ? String(year).trim() : null;

  let out = (rows || []).map((r) => {
    const hint = suggestFor({ store_item_id: r.store_item_id, description: r.description });
    return {
      ...r,
      suggested_price: hint ? hint.suggested_price : null,
      suggested_source: hint ? hint.suggested_source : null,
      suggested_date: hint ? hint.suggested_date : null,
      suggested_supplier: hint ? hint.suggested_supplier : null,
    };
  });

  if (yr) {
    out = out.filter((r) => String(r.grn_date || r.delivery_date || r.req_date || '').startsWith(yr));
  }
  if (hintOnly) {
    out = out.filter((r) => r.suggested_price != null && r.suggested_price > 0);
  }
  return out;
}

function grnWsFilterSql(user) {
  return scope.wsSql('COALESCE(m.workshop_id, g.store_id)', scope.reach(user));
}

function jobWsFilterSql(user) {
  return scope.wsSql('jc.workshop_id', scope.reach(user));
}

function pricingQueueSummary(user) {
  const suggestFor = buildLastPriceLookup();
  const grnWs = grnWsFilterSql(user);
  const jobWs = jobWsFilterSql(user);

  const grnRows = all(`
    SELECT g.id, g.store_item_id, g.description
      FROM grn g
      LEFT JOIN mrn m ON m.id = g.mrn_id
     WHERE (g.unit_price IS NULL OR g.unit_price <= 0)${grnWs}
  `);
  let unpricedGrnsWithHint = 0;
  for (const r of grnRows) {
    if (suggestFor({ store_item_id: r.store_item_id, description: r.description })) {
      unpricedGrnsWithHint++;
    }
  }

  const jpRows = all(`
    SELECT jp.id, jp.source_type, jp.description,
           COALESCE(i.store_item_id, g.store_item_id) AS store_item_id
      FROM job_parts jp
      JOIN job_cards jc ON jc.id = jp.job_id
      LEFT JOIN issues i ON jp.source_type = 'issue' AND i.id = jp.source_id
      LEFT JOIN grn g ON jp.source_type = 'grn' AND g.id = jp.source_id
     WHERE COALESCE(jp.unit_price, 0) <= 0${jobWs}
  `);
  let unpricedJpWithHint = 0;
  const bySourceType = { grn: 0, issue: 0, other: 0 };
  for (const r of jpRows) {
    if (r.source_type === 'grn') bySourceType.grn++;
    else if (r.source_type === 'issue') bySourceType.issue++;
    else bySourceType.other++;
    if (suggestFor({ store_item_id: r.store_item_id, description: r.description })) {
      unpricedJpWithHint++;
    }
  }

  const siCount = (get(`
    SELECT COUNT(*) AS n
      FROM store_items
     WHERE is_general = 1
       AND COALESCE(unit_cost, 0) <= 0
  `) || {}).n || 0;

  return {
    unpriced_grns: grnRows.length,
    unpriced_grns_with_hint: unpricedGrnsWithHint,
    unpriced_job_parts: jpRows.length,
    unpriced_job_parts_with_hint: unpricedJpWithHint,
    job_parts_by_source: bySourceType,
    unpriced_store_items: siCount,
  };
}

function listUnpricedJobParts(query = {}, user = null) {
  const clauses = ['COALESCE(jp.unit_price, 0) <= 0'];
  const params = [];

  const jobWs = scope.wsSql('jc.workshop_id', scope.reach(user));
  if (jobWs) clauses.push(jobWs.slice(' AND '.length));

  if (query.source_type && ['grn', 'issue'].includes(String(query.source_type))) {
    clauses.push('jp.source_type = ?');
    params.push(String(query.source_type));
  }
  if (query.job_status === 'open') {
    clauses.push(jobstate.openSql('jc'));
  } else if (query.job_status === 'closed') {
    clauses.push("jc.status IN ('CLOSED', 'PARTIALLY_CLOSED')");
  }
  if (query.q && String(query.q).trim()) {
    const like = `%${String(query.q).trim()}%`;
    clauses.push('(jp.description LIKE ? OR jc.job_no LIKE ? OR a.code LIKE ? OR g.grn_no LIKE ? OR m.mrn_no LIKE ?)');
    params.push(like, like, like, like, like);
  }

  const limit = Math.min(2000, Math.max(1, toInt(query.limit, 400)));
  const rows = all(`
    SELECT jp.id, jp.job_id, jp.source_type, jp.source_id, jp.mrn_line_id,
           jp.description, jp.qty, jp.unit_price, jp.created_at,
           jc.job_no, jc.status AS job_status, jc.requested_at AS job_date,
           COALESCE(jc.completed_at, jc.requested_at) AS effective_job_date,
           a.id AS asset_id, a.code AS asset_code,
           i.issue_date, i.min_no, i.store_item_id AS issue_store_item_id,
           g.grn_no, g.grn_date, g.delivery_date, g.supplier, g.store_item_id AS grn_store_item_id,
           m.mrn_no
      FROM job_parts jp
      JOIN job_cards jc ON jc.id = jp.job_id
      LEFT JOIN assets a ON a.id = jc.asset_id
      LEFT JOIN issues i ON jp.source_type = 'issue' AND i.id = jp.source_id
      LEFT JOIN grn g ON jp.source_type = 'grn' AND g.id = jp.source_id
      LEFT JOIN mrn m ON m.id = g.mrn_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY CASE WHEN ${jobstate.openSql('jc')} THEN 0 ELSE 1 END,
              COALESCE(i.issue_date, g.delivery_date, jc.requested_at, jp.created_at) DESC,
              jp.id DESC
     LIMIT ?
  `, ...params, limit);

  const suggestFor = buildLastPriceLookup();
  let enriched = rows.map((r) => {
    const storeItemId = r.issue_store_item_id || r.grn_store_item_id || null;
    const hint = suggestFor({ store_item_id: storeItemId, description: r.description });
    return {
      ...r,
      store_item_id: storeItemId,
      suggested_price: hint ? hint.suggested_price : null,
      suggested_source: hint ? hint.suggested_source : null,
      suggested_date: hint ? hint.suggested_date : null,
      suggested_supplier: hint ? hint.suggested_supplier : null,
    };
  });

  if (query.hint === '1') {
    enriched = enriched.filter((r) => r.suggested_price != null && r.suggested_price > 0);
  }
  return enriched;
}

function bulkPriceJobParts(rows, actor, { cascadeGrnPriceFn } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw httpError(400, 'Nothing to save');

  const validated = [];
  for (const r of list) {
    const id = toInt(r && r.id);
    if (!id) continue;
    const raw = r.unit_price;
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const priceNum = Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      throw httpError(400, `Unit price must be greater than 0 for job part #${id}`);
    }
    validated.push({ id, unit_price: n2price(priceNum) });
  }
  if (!validated.length) throw httpError(400, 'Enter at least one valid positive unit price');

  const affectedJobIds = new Set();
  const buckets = new Map();
  const updatedIds = [];
  const touchedGrns = [];

  const trackBucket = (assetId, dateStr) => {
    if (!assetId || !dateStr) return;
    const ym = String(dateStr).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    const [year, month] = ym.split('-').map(Number);
    if (year && month) buckets.set(`${assetId}:${ym}`, { assetId, year, month });
  };

  tx(() => {
    for (const item of validated) {
      const jp = get(`
        SELECT jp.*, jc.asset_id, jc.workshop_id, jc.requested_at, jc.completed_at
          FROM job_parts jp
          LEFT JOIN job_cards jc ON jc.id = jp.job_id
         WHERE jp.id = ?
      `, item.id);
      if (!jp) continue;
      if (jp.job_id && scope.jobRefusal(actor, jp.job_id)) continue;

      run('UPDATE job_parts SET unit_price = ? WHERE id = ?', item.unit_price, jp.id);
      updatedIds.push(jp.id);
      if (jp.job_id) affectedJobIds.add(jp.job_id);

      if (jp.source_type === 'grn' && jp.source_id) {
        const grnRow = get('SELECT id, unit_price, priced_at, delivery_date, grn_date FROM grn WHERE id = ?', jp.source_id);
        if (grnRow) {
          run(`
            UPDATE grn
               SET unit_price = ?,
                   priced_at = COALESCE(priced_at, datetime('now'))
             WHERE id = ?
          `, item.unit_price, grnRow.id);
          if (typeof cascadeGrnPriceFn === 'function') {
            cascadeGrnPriceFn(grnRow.id, item.unit_price);
          }
          touchedGrns.push(grnRow.id);
          trackBucket(jp.asset_id, grnRow.delivery_date || grnRow.grn_date || jp.completed_at || jp.requested_at);
        }
      } else if (jp.source_type === 'issue' && jp.source_id) {
        const iss = get('SELECT id, store_item_id, asset_id, issue_date FROM issues WHERE id = ?', jp.source_id);
        if (iss) {
          run('UPDATE issues SET unit_price = ? WHERE id = ?', item.unit_price, iss.id);
          run("UPDATE stock_moves SET unit_price = ? WHERE source_table = 'issues' AND source_id = ?", item.unit_price, iss.id);
          run('UPDATE general_item_txns SET unit_price = ? WHERE source_issue_id = ?', item.unit_price, iss.id);
          if (iss.store_item_id) {
            run('UPDATE store_items SET unit_cost = ? WHERE id = ? AND COALESCE(unit_cost, 0) <= 0', item.unit_price, iss.store_item_id);
          }
          trackBucket(iss.asset_id || jp.asset_id, iss.issue_date || jp.completed_at || jp.requested_at);
        } else {
          trackBucket(jp.asset_id, jp.completed_at || jp.requested_at);
        }
      } else {
        trackBucket(jp.asset_id, jp.completed_at || jp.requested_at);
      }
    }

    if (touchedGrns.length) {
      try { stock.sync({ grn: touchedGrns }); } catch (_) {}
    }

    for (const jid of affectedJobIds) {
      try { costing.refreshJobTotals(jid); } catch (_) {}
    }
    for (const b of buckets.values()) {
      try { costing.recalcVehicleMonth(b.assetId, b.year, b.month); } catch (_) {}
    }
  });

  if (updatedIds.length) {
    audit.record({
      userId: actor ? actor.id : null,
      entity: 'job_parts',
      action: 'bulk_price',
      after: {
        saved: updatedIds.length,
        jobs_refreshed: affectedJobIds.size,
        grns_updated: touchedGrns.length,
        ids: updatedIds.slice(0, 50),
      },
    });
  }

  return {
    ok: true,
    saved: updatedIds.length,
    jobs_refreshed: affectedJobIds.size,
    grns_updated: touchedGrns.length,
  };
}

module.exports = {
  buildLastPriceLookup,
  enrichAwaitingPriceRows,
  pricingQueueSummary,
  listUnpricedJobParts,
  bulkPriceJobParts,
};
