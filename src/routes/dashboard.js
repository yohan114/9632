'use strict';

// Dashboard — read-only aggregates across every subsystem (jobs, MRNs, stock, oil,
// filters, the vehicle_monthly_costs rollup, and the audit trail). No requireModule
// gate: any authenticated user may see the dashboard, so this router embeds the stock
// alert ITEMS (not just counts) rather than making the page call the module-gated
// low-stock endpoints (which would 403 for roles without that module).

const express = require('express');
const { get, all } = require('../db');
const { requireAuth } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');

const router = express.Router();

// No module gate (every role sees the dashboard) — but authentication IS required, so
// an anonymous request can't read aggregate operational data.
router.use(requireAuth);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// job_cards has no IN_PROGRESS/IN_WORKSHOP status in this system — "active/open" means
// anything not yet CLOSED or REJECTED (the same convention jobcards.js uses).
const OPEN_JOBS = "status NOT IN ('CLOSED', 'REJECTED')";
// Live, in-flight MRNs awaiting a decision. approval_status is 'requested' | 'certified'
// | 'approved' | 'rejected' (there is no 'pending'); the 1500+ imported rows are
// 'requested' with no requester, so a real pending row must carry a requester.
const LIVE_PENDING_MRN = "(approval_status = 'requested' AND requested_by IS NOT NULL AND TRIM(requested_by) <> '') OR approval_status = 'certified'";

// Low-stock predicates kept identical to each dedicated page so the dashboard counts
// match those pages exactly.
const LOW_GENERAL = 'is_general = 1 AND balance <= COALESCE(min_stock, 0)';
const LOW_OIL = '(COALESCE(stock_qty,0) <= 0 OR (COALESCE(reorder_level,0) > 0 AND COALESCE(stock_qty,0) <= reorder_level))';
const LOW_FILTER = 'qty_in_stock <= COALESCE(reorder_level, 0)';

const today = () => new Date().toISOString().slice(0, 10);
const nowYM = () => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; };

function lastNMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ year: dt.getFullYear(), month: dt.getMonth() + 1, label: MONTHS[dt.getMonth()] });
  }
  return out;
}

const statusOf = (cur, reorder) => (cur <= 0 ? 'critical' : 'low');

// Combined low-stock items across general stock, oil and filters, critical first.
function stockAlerts(limit = 30) {
  const general = all(
    `SELECT name, COALESCE(category,'General') AS category, balance AS current, COALESCE(min_stock,0) AS reorder, 'general' AS kind
       FROM store_items WHERE ${LOW_GENERAL}`);
  const oil = all(
    `SELECT name, COALESCE(category,'Oil') AS category, COALESCE(stock_qty,0) AS current, COALESCE(reorder_level,0) AS reorder, 'oil' AS kind
       FROM products WHERE active = 1 AND ${LOW_OIL}`);
  const filters = all(
    `SELECT filter_type AS name, COALESCE(brand,'Filter') AS category, qty_in_stock AS current, COALESCE(reorder_level,0) AS reorder, 'filter' AS kind
       FROM filter_stock WHERE ${LOW_FILTER}`);
  const rows = general.concat(oil, filters);
  for (const r of rows) r.status = statusOf(r.current, r.reorder);
  // critical (out of stock) first, then by how far below reorder.
  rows.sort((a, b) => (a.status === b.status ? (a.current - a.reorder) - (b.current - b.reorder) : (a.status === 'critical' ? -1 : 1)));
  return rows.slice(0, limit);
}

// ---- overview -------------------------------------------------------------
router.get('/overview', asyncHandler((_req, res) => {
  const { year, month } = nowYM();

  const active_jobs = get(`SELECT COUNT(*) c FROM job_cards WHERE ${OPEN_JOBS}`).c;
  const vehicles_in_workshop = get(`SELECT COUNT(DISTINCT asset_id) c FROM job_cards WHERE ${OPEN_JOBS} AND asset_id IS NOT NULL`).c;
  const pending_requests = get(`SELECT COUNT(*) c FROM mrn WHERE ${LIVE_PENDING_MRN}`).c;

  const low_stock_items = get(`SELECT COUNT(*) c FROM store_items WHERE ${LOW_GENERAL}`).c;
  const low_oil_stock = get(`SELECT COUNT(*) c FROM products WHERE active = 1 AND ${LOW_OIL}`).c;
  const low_filter_stock = get(`SELECT COUNT(*) c FROM filter_stock WHERE ${LOW_FILTER}`).c;

  const todays_issue_cost = get(
    `SELECT COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0) v FROM issues WHERE issue_date = ?`, today()).v;
  const monthly_cost_total = get(
    `SELECT COALESCE(SUM(total_cost), 0) v FROM vehicle_monthly_costs WHERE year = ? AND month = ?`, year, month).v;

  // Job status mix over the last 90 days (by the real job date, falling back to created_at).
  const job_status_breakdown = all(
    `SELECT status, COUNT(*) AS count FROM job_cards
      WHERE date(COALESCE(requested_at, created_at)) >= date('now', '-90 days')
      GROUP BY status ORDER BY count DESC`);

  const top_5_cost_vehicles = all(
    `SELECT v.asset_id, a.code, a.registration, a.ec_code,
            ROUND(v.total_cost,2) AS total_cost, ROUND(v.parts_cost,2) AS parts_cost,
            ROUND(v.oil_cost,2) AS oil_cost, ROUND(v.filter_cost,2) AS filter_cost, ROUND(v.labour_cost,2) AS labour_cost
       FROM vehicle_monthly_costs v LEFT JOIN assets a ON a.id = v.asset_id
      WHERE v.year = ? AND v.month = ? AND v.total_cost > 0
      ORDER BY v.total_cost DESC LIMIT 5`, year, month);

  // Monthly cost trend — last 6 months, zero-filled.
  const periods = lastNMonths(6);
  const minIdx = periods[0].year * 12 + periods[0].month;
  const trendRows = all(
    `SELECT year, month,
            ROUND(SUM(parts_cost),2) AS parts_cost, ROUND(SUM(oil_cost),2) AS oil_cost,
            ROUND(SUM(filter_cost),2) AS filter_cost, ROUND(SUM(labour_cost),2) AS labour_cost,
            ROUND(SUM(total_cost),2) AS total_cost
       FROM vehicle_monthly_costs WHERE (year * 12 + month) >= ? GROUP BY year, month`, minIdx);
  const byKey = {};
  for (const r of trendRows) byKey[r.year + '-' + r.month] = r;
  const monthly_cost_trend = periods.map((p) => {
    const r = byKey[p.year + '-' + p.month] || {};
    return {
      month: p.label, year: p.year, month_num: p.month,
      parts_cost: r.parts_cost || 0, oil_cost: r.oil_cost || 0,
      filter_cost: r.filter_cost || 0, labour_cost: r.labour_cost || 0, total_cost: r.total_cost || 0,
    };
  });

  const recent_activity = all(
    `SELECT al.id, al.entity, al.entity_id, al.action, al.reason, al.created_at,
            u.username, u.full_name
       FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.id DESC LIMIT 15`);

  res.json({
    active_jobs, pending_requests, vehicles_in_workshop,
    low_stock_items, low_oil_stock, low_filter_stock,
    todays_issue_cost, monthly_cost_total,
    job_status_breakdown, top_5_cost_vehicles, monthly_cost_trend,
    recent_activity, stock_alerts: stockAlerts(),
    generated_at: new Date().toISOString(),
  });
}));

// ---- lightweight poll -----------------------------------------------------
router.get('/live-stats', asyncHandler((_req, res) => {
  const { year, month } = nowYM();
  const active_jobs = get(`SELECT COUNT(*) c FROM job_cards WHERE ${OPEN_JOBS}`).c;
  const pending_requests = get(`SELECT COUNT(*) c FROM mrn WHERE ${LIVE_PENDING_MRN}`).c;
  const low_stock_alerts =
    get(`SELECT COUNT(*) c FROM store_items WHERE ${LOW_GENERAL}`).c +
    get(`SELECT COUNT(*) c FROM products WHERE active = 1 AND ${LOW_OIL}`).c +
    get(`SELECT COUNT(*) c FROM filter_stock WHERE ${LOW_FILTER}`).c;
  const todays_cost = get(`SELECT COALESCE(SUM(qty * COALESCE(unit_price,0)),0) v FROM issues WHERE issue_date = ?`, today()).v;
  const monthly_cost = get(`SELECT COALESCE(SUM(total_cost),0) v FROM vehicle_monthly_costs WHERE year = ? AND month = ?`, year, month).v;
  res.json({ active_jobs, pending_requests, low_stock_alerts, todays_cost, monthly_cost });
}));

module.exports = router;
