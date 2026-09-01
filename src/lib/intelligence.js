'use strict';

// ===========================================================================
// Advisory intelligence (Phase 5 §1 + §4). Everything here is READ-ONLY — it
// flags for a human, never auto-corrects a ledger or a cost. Thresholds are
// business calls (config.anomaly*Factor), defaulted and owner-tunable.
// ===========================================================================

const { get, all } = require('../db');
const config = require('../config');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const daysAgoISO = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10);

// ---- global service-due list ---------------------------------------------
function serviceDue() {
  const rows = all(
    `SELECT ss.asset_id, ss.machine_label, ss.interval_hours, ss.expected_cost,
            a.code AS asset_code, a.running_hours, p.name AS project_name
       FROM service_specs ss
       JOIN assets a ON a.id = ss.asset_id
       LEFT JOIN projects p ON p.id = a.current_project_id
      WHERE ss.interval_hours IS NOT NULL AND ss.interval_hours > 0`
  );
  return rows
    .map((r) => {
      const rh = r.running_hours || 0;
      const over = rh - r.interval_hours;
      return {
        asset_id: r.asset_id, asset_code: r.asset_code, machine_label: r.machine_label,
        project: r.project_name, running_hours: rh, interval_hours: r.interval_hours,
        due: rh >= r.interval_hours, overdue_by: over > 0 ? round(over) : 0,
        hours_remaining: over < 0 ? round(-over) : 0, expected_cost: r.expected_cost,
      };
    })
    .sort((a, b) => (b.due ? 1 : 0) - (a.due ? 1 : 0) || b.overdue_by - a.overdue_by || a.hours_remaining - b.hours_remaining);
}

// ---- unusual consumption (asset compared to ITSELF) ----------------------
function unusualConsumption(factor = config.anomalyConsumptionFactor) {
  const recentDays = 30;
  const baselineDays = config.forecastWindowDays; // e.g. 90
  const recentSince = daysAgoISO(recentDays);
  const baselineSince = daysAgoISO(recentDays + baselineDays);
  const pairs = all(
    `SELECT sl.asset_id, sl.product_id, a.code AS asset_code, pr.name AS product_name, pr.unit
       FROM stock_ledger sl JOIN assets a ON a.id = sl.asset_id JOIN products pr ON pr.id = sl.product_id
      WHERE sl.kind = 'issue' AND sl.asset_id IS NOT NULL AND sl.txn_date >= ?
      GROUP BY sl.asset_id, sl.product_id`,
    recentSince
  );
  const out = [];
  for (const p of pairs) {
    const recent = get(`SELECT COALESCE(SUM(ABS(qty)),0) q FROM stock_ledger WHERE asset_id=? AND product_id=? AND kind='issue' AND txn_date >= ?`, p.asset_id, p.product_id, recentSince);
    const base = get(`SELECT COALESCE(SUM(ABS(qty)),0) q, COUNT(*) n FROM stock_ledger WHERE asset_id=? AND product_id=? AND kind='issue' AND txn_date >= ? AND txn_date < ?`, p.asset_id, p.product_id, baselineSince, recentSince);
    if (base.n < 1 || base.q <= 0) continue; // not enough of the asset's own history to judge
    const recentRate = recent.q / recentDays;
    const baseRate = base.q / baselineDays;
    if (recentRate > factor * baseRate) {
      out.push({
        asset_code: p.asset_code, product_name: p.product_name, unit: p.unit,
        recent_qty: round(recent.q), recent_rate: round(recentRate), baseline_rate: round(baseRate),
        ratio: round(recentRate / baseRate),
      });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ---- duplicate MRN / likely double-entry ---------------------------------
function duplicateMrn() {
  const duplicate_numbers = all(`SELECT mrn_no, COUNT(*) c FROM mrn GROUP BY mrn_no HAVING c > 1`);
  const likely_double_entries = all(
    `SELECT a.code AS asset_code, ml.description, ml.qty, m.req_date, COUNT(*) c,
            GROUP_CONCAT(m.mrn_no) AS mrn_nos
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id LEFT JOIN assets a ON a.id = m.asset_id
      GROUP BY m.asset_id, ml.description, ml.qty, m.req_date
      HAVING c > 1`
  );
  return { duplicate_numbers, likely_double_entries };
}

// ---- GRN price spike (item vs its own recent price history) --------------
function grnPriceSpikes(factor = config.anomalyPriceSpikeFactor) {
  const grns = all(`SELECT id, store_item_id, description, unit_price FROM grn WHERE unit_price IS NOT NULL ORDER BY id`);
  const out = [];
  for (const g of grns) {
    const base = g.store_item_id
      ? get(`SELECT AVG(unit_price) avg, COUNT(*) n FROM grn WHERE store_item_id=? AND unit_price IS NOT NULL AND id <> ?`, g.store_item_id, g.id)
      : get(`SELECT AVG(unit_price) avg, COUNT(*) n FROM grn WHERE description=? AND unit_price IS NOT NULL AND id <> ?`, g.description, g.id);
    if (!base || base.n < 1 || !base.avg) continue;
    if (g.unit_price > factor * base.avg) {
      out.push({ grn_id: g.id, item: g.description, unit_price: round(g.unit_price), baseline_avg: round(base.avg), ratio: round(g.unit_price / base.avg) });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ---- periodic integrity check --------------------------------------------
function integrityCheck() {
  const issues = [];
  const add = (type, detail) => issues.push({ type, detail });

  for (const j of all(`SELECT id, job_no FROM job_cards WHERE asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.id=job_cards.asset_id)`))
    add('orphan_job_asset', `Job ${j.job_no} references a missing asset`);
  for (const l of all(`SELECT id FROM stock_ledger WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id=stock_ledger.product_id)`))
    add('orphan_ledger_product', `Stock ledger #${l.id} references a missing product`);
  for (const j of all(`SELECT job_no FROM job_cards WHERE status='CLOSED' AND NOT EXISTS (SELECT 1 FROM job_costs c WHERE c.job_id=job_cards.id)`))
    add('closed_without_snapshot', `Closed job ${j.job_no} has no cost snapshot`);

  // ledger balance reconciliation: Σ(signed qty) must equal the last balance_after
  for (const p of all(`SELECT id, name FROM products`)) {
    const rows = all(`SELECT qty, balance_after FROM stock_ledger WHERE product_id=? ORDER BY id`, p.id);
    if (!rows.length) continue;
    let running = 0;
    for (const r of rows) running += r.qty;
    const last = rows[rows.length - 1].balance_after;
    if (Math.abs(running - last) > 0.001) add('ledger_reconcile', `Product "${p.name}": running sum ${round(running)} ≠ last balance ${round(last)}`);
  }
  return { issues, count: issues.length };
}

// ---- summary counts for the dashboard "needs attention" panel ------------
function needsAttentionSummary() {
  const dup = duplicateMrn();
  return {
    service_due: serviceDue().filter((s) => s.due).length,
    unusual_consumption: unusualConsumption().length,
    duplicate_mrn: dup.duplicate_numbers.length + dup.likely_double_entries.length,
    grn_price_spikes: grnPriceSpikes().length,
    integrity_issues: integrityCheck().count,
    // Vehicles carrying more than one open job card (pre-date the one-open-card rule).
    vehicle_conflicts: require('./jobstate').duplicateOpenJobs().length,
  };
}

module.exports = { serviceDue, unusualConsumption, duplicateMrn, grnPriceSpikes, integrityCheck, needsAttentionSummary };
