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

// Dashboard endpoints are accessible to all authenticated users; financial figures and sensitive
// rollups are gated per-field based on the user's module & capability permissions.
router.use(requireAuth);
const permissions = require('../lib/permissions');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const jobsFlow = require('../lib/jobs_flow');
const storesFlow = require('../lib/stores_flow');
const jobstate = require('../lib/jobstate');
const scope = require('../lib/scope');
const limits = require('../lib/approval_limits');
const { hasCap } = require('../lib/auth');
const attendance = require('../lib/attendance');
const jobClose = require('../lib/job_close');
const costing = require('../lib/costing');
const mechanicsLib = require('../lib/mechanics');

// Live, in-flight MRNs awaiting a decision. approval_status is 'requested' | 'certified'
// | 'approved' | 'rejected' (there is no 'pending'); the 1500+ imported rows are
// 'requested' with no requester, so a real pending row must carry a requester.
const LIVE_PENDING_MRN = "(approval_status = 'requested' AND requested_by IS NOT NULL AND TRIM(requested_by) <> '') OR approval_status = 'certified'";

// Low-stock predicates kept identical to each dedicated page so the dashboard counts
// match those pages exactly.
const LOW_GENERAL = 'is_general = 1 AND balance <= COALESCE(min_stock, 0)';
const LOW_OIL = '(COALESCE(stock_qty,0) <= 0 OR (COALESCE(reorder_level,0) > 0 AND COALESCE(stock_qty,0) <= reorder_level))';
const LOW_FILTER = 'qty_in_stock <= COALESCE(reorder_level, 0)';

const today = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
};
const nowYM = () => {
  const [y, m] = today().split('-');
  return { year: parseInt(y, 10), month: parseInt(m, 10) };
};

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

// ---- improvement plan, Step 2b: your own workshops' figures --------------------------------------
// With the workshops kept apart, someone outside head office sees their own workshops' jobs,
// requests, issues and cost here (scope.reach) and their own store's stock (scope.ownStore). Head
// office — and everyone, until the workshops are kept apart — sees the company's, as before.
const wsSql = (...a) => scope.wsSql(...a);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Low stock in each kind, and the list behind it: the company's, or one store's. */
function lowStock(user, limit = 30) {
  const store = scope.ownStore(user);
  if (store == null) {
    return {
      general: get(`SELECT COUNT(*) c FROM store_items WHERE ${LOW_GENERAL}`).c,
      oil: get(`SELECT COUNT(*) c FROM products WHERE active = 1 AND ${LOW_OIL}`).c,
      filter: get(`SELECT COUNT(*) c FROM filter_stock WHERE ${LOW_FILTER}`).c,
      list: () => stockAlerts(limit),
    };
  }
  const alerts = require('../lib/store_shelf').reorderAlerts(store);
  const n = (sec) => alerts.filter((a) => a.section === sec).length;
  return {
    general: n('general'), oil: n('oil'), filter: n('filter'),
    list: () => alerts.slice(0, limit).map((a) => ({ name: a.name, category: a.category, current: a.current_stock,
      reorder: a.reorder_level, kind: a.section, status: statusOf(a.current_stock, a.reorder_level) })),
  };
}

/** Open cards, vehicles in, live requests and today's issues — of the workshops in `ws` (null: all). */
function counts(ws) {
  return {
    active_jobs: get(`SELECT COUNT(*) c FROM job_cards j WHERE ${jobstate.openSql('j')}${wsSql('j.workshop_id', ws)}`).c,
    vehicles_in_workshop: get(`SELECT COUNT(DISTINCT j.asset_id) c FROM job_cards j WHERE ${jobstate.openSql('j')} AND j.asset_id IS NOT NULL${wsSql('j.workshop_id', ws)}`).c,
    pending_requests: get(`SELECT COUNT(*) c FROM mrn WHERE (${LIVE_PENDING_MRN})${wsSql('workshop_id', ws)}`).c,
    // An issue is its job card's workshop's, else the store it left.
    todays_issue_cost: get(`SELECT COALESCE(SUM(i.qty * COALESCE(i.unit_price, 0)), 0) v FROM issues i
                             LEFT JOIN job_cards j ON j.id = i.job_id WHERE i.issue_date = ?${wsSql('COALESCE(j.workshop_id, i.store_id)', ws)}`, today()).v,
  };
}

/**
 * This month's cost, the six-month trend and the five costliest vehicles. The company's come from the
 * vehicle cost rollup, which keeps no workshop; one workshop's are worked out from its own labour,
 * receipts, oil and services (src/lib/month_costs.js), the figures Reports → Monthly shows it.
 */
function costFigures(ws) {
  const { year, month } = nowYM();
  if (ws == null) {
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
    const monthly_cost_total = get(
      `SELECT COALESCE(SUM(total_cost), 0) v FROM vehicle_monthly_costs WHERE year = ? AND month = ?`, year, month).v;
    return { monthly_cost_total, monthly_cost_trend, top_5_cost_vehicles };
  }

  const mc = require('../lib/month_costs');
  const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const byMonth = new Map(mc.monthlyRollup(ws).map((m) => [m.month, m]));
  const monthly_cost_trend = lastNMonths(6).map((p) => {
    const r = byMonth.get(key(p.year, p.month)) || {};
    // A workshop's own figures have no filter line of their own: a filter is in a service, or a part.
    return {
      month: p.label, year: p.year, month_num: p.month,
      parts_cost: r2((r.head_office || 0) + (r.local_purchase || 0)), oil_cost: r.oil || 0, filter_cost: 0,
      labour_cost: r.labour || 0, service_cost: r.service || 0, total_cost: r.total || 0,
    };
  });
  const top_5_cost_vehicles = mc.monthAssets(key(year, month), ws).filter((a) => a.total > 0).slice(0, 5)
    .map((a) => ({ asset_id: a.asset_id, code: a.asset_code, registration: a.registration, ec_code: a.ec_code,
      total_cost: a.total, parts_cost: a.material, oil_cost: a.oil, filter_cost: 0, labour_cost: a.labour }));
  const now = byMonth.get(key(year, month));
  return { monthly_cost_total: now ? now.total : 0, monthly_cost_trend, top_5_cost_vehicles };
}

/** Quick MTD & Today Mechanics KPI pulse for users with dailywork / labour / reports privileges */
function mechanicsPulse(user, ws) {
  const ym = new Date().toISOString().slice(0, 7);
  const td = today();
  const dwWs = wsSql('COALESCE(j.workshop_id, d.workshop_id)', ws);
  const rows = all(`
    SELECT d.work_date, d.mechanic, COALESCE(d.hours, 0) AS hours, COALESCE(d.outside_labour, 0) AS outside_labour
      FROM job_daily_work d
      LEFT JOIN job_cards j ON j.id = d.job_id
     WHERE substr(d.work_date, 1, 7) = ?${dwWs}
  `, ym);
  let todayHours = 0;
  const todayMechs = new Set();
  let mtdHours = 0;
  let mtdInternalCost = 0;
  let mtdOutsideCost = 0;
  for (const r of rows) {
    const names = mechanicsLib.splitMechanics(r.mechanic);
    const lineHours = Number(r.hours) || 0;
    const lineOutside = Number(r.outside_labour) || 0;
    mtdOutsideCost += lineOutside;
    if (r.work_date === td) {
      todayHours += lineHours;
      for (const n of names) todayMechs.add(mechanicsLib.resolveMechanicName(n) || n);
    }
    for (const rawName of (names.length ? names : [r.mechanic || 'Unknown'])) {
      const canon = mechanicsLib.resolveMechanicName(rawName) || rawName;
      const rate = costing.labourRateFor(canon, r.work_date);
      mtdHours += lineHours;
      mtdInternalCost += lineHours * rate;
    }
  }
  const netSavings = r2(mtdOutsideCost - mtdInternalCost);
  const roiRatio = mtdInternalCost > 0 ? r2(mtdOutsideCost / mtdInternalCost) : 0;
  return {
    month: ym,
    today_hours: r2(todayHours),
    today_mechanics_count: todayMechs.size,
    mtd_hours: r2(mtdHours),
    mtd_internal_cost: r2(mtdInternalCost),
    mtd_outside_cost: r2(mtdOutsideCost),
    mtd_net_savings: netSavings,
    mtd_roi_ratio: roiRatio
  };
}

// ---- overview -------------------------------------------------------------
router.get('/overview', asyncHandler((req, res) => {
  const ws = scope.reach(req.user);   // Step 2b: null = every workshop
  const canReports = permissions.reaches(req.user, 'reports') || hasCap(req.user, 'reports.financial');
  const canJobs = permissions.reaches(req.user, 'jobs') || permissions.reaches(req.user, 'jobrequests');
  const canStores = permissions.reaches(req.user, 'stores') || permissions.reaches(req.user, 'oil') || permissions.reaches(req.user, 'generalstock');

  const { active_jobs, vehicles_in_workshop, pending_requests, todays_issue_cost } = counts(ws);
  const low = lowStock(req.user);
  const costs = canReports ? costFigures(ws) : { monthly_cost_total: null, monthly_cost_trend: [], top_5_cost_vehicles: [] };

  // Job status mix over the last 90 days (by the real job date, falling back to created_at).
  const job_status_breakdown = canJobs ? all(
    `SELECT status, COUNT(*) AS count FROM job_cards
      WHERE date(COALESCE(requested_at, created_at)) >= date('now', '-90 days')${wsSql('workshop_id', ws)}
      GROUP BY status ORDER BY count DESC`) : [];

  // Step 2b: kept to your own workshops, the actions of their people (each person's home workshop).
  const recent_activity = all(
    `SELECT al.id, al.entity, al.entity_id, al.action, al.reason, al.created_at,
            u.username, u.full_name
       FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
      ${ws == null ? '' : `WHERE al.user_id IS NOT NULL${wsSql('u.workshop_id', ws)}`}
      ORDER BY al.id DESC LIMIT 15`);

  res.json({
    active_jobs, pending_requests, vehicles_in_workshop,
    low_stock_items: low.general, low_oil_stock: low.oil, low_filter_stock: low.filter,
    todays_issue_cost: (canReports || canStores) ? todays_issue_cost : null,
    monthly_cost_total: costs.monthly_cost_total,
    job_status_breakdown,
    top_5_cost_vehicles: costs.top_5_cost_vehicles,
    monthly_cost_trend: costs.monthly_cost_trend,
    recent_activity,
    stock_alerts: canStores ? low.list() : [],
    generated_at: new Date().toISOString(),
  });
}));

function attendanceWorkshops(user) {
  if (!scope.enabled()) return [null];
  const own = scope.onlyWorkshop(user, { store: false });
  if (own) return [own];
  return all('SELECT id FROM workshops WHERE active = 1 ORDER BY is_default DESC, name').map((w) => w.id);
}

function unsignedFor(wsList) {
  const out = [];
  for (const ws of wsList) {
    const name = ws ? (get('SELECT name FROM workshops WHERE id = ?', ws) || {}).name : null;
    for (const d of attendance.unsignedDays({ ws })) out.push(ws ? { ...d, workshop_id: ws, workshop_name: name } : d);
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ---- workflow-monitor (process roads, process-wise approvals, on-hold watchboard) ----
router.get('/workflow-monitor', asyncHandler((req, res) => {
  const user = req.user;
  const may = (cap) => hasCap(user, cap);
  const canMod = (m) => permissions.reaches(user, m);
  const jm = jobsFlow.monitor(user);
  const sm = storesFlow.monitor(user);
  const rReach = scope.reach(user);

  // 1. Core KPIs
  const jOwn = scope.filter(user, 'j.workshop_id');
  const andJ = jOwn.sql ? ` AND ${jOwn.sql}` : '';
  const active_jobs = get(`SELECT COUNT(*) c FROM job_cards j WHERE ${jobstate.openSql('j')}${andJ}`, ...jOwn.params).c;
  const vehicles_in_workshop = get(`SELECT COUNT(DISTINCT j.asset_id) c FROM job_cards j WHERE ${jobstate.openSql('j')} AND j.asset_id IS NOT NULL${andJ}`, ...jOwn.params).c;
  // Step 2b: your own workshops' cost this month, your own store's low stock.
  const canReports = canMod('reports') || may('reports.financial');
  const { monthly_cost_total } = canReports ? costFigures(rReach) : { monthly_cost_total: null };
  const low = lowStock(user);
  const low_stock_total = low.general + low.oil + low.filter;

  // 2. Jobs Road & Pipeline
  const closed_this_month = get(`SELECT COUNT(*) c FROM job_cards j WHERE j.status = 'CLOSED' AND strftime('%Y-%m', j.completed_at) = strftime('%Y-%m', 'now')${andJ}`, ...jOwn.params).c;
  const jobs_counts = jobsFlow.counts(user);
  const jobs_road = {
    steps: [
      { key: 'requested', label: 'Requested', count: jobs_counts.open },
      { key: 'approved', label: 'Approved', count: (jm.requests ? jm.requests.operations : 0) + (jm.workshop ? jm.workshop.not_started : 0) },
      { key: 'workshop', label: 'In Workshop', count: jm.workshop ? jm.workshop.all : 0 },
      { key: 'working', label: 'Working', count: jm.workshop ? jm.workshop.worked_today : 0 },
      { key: 'done', label: 'Work Done', count: jm.finishing ? (jm.finishing.work_done + jm.finishing.partly_closed) : 0 },
      { key: 'priced', label: 'Ready to Close', count: jm.finishing ? jm.finishing.ready : 0 },
      { key: 'closed', label: 'Closed (Month)', count: closed_this_month }
    ],
    workshop: jm.workshop,
    finishing: jm.finishing,
    watch: jm.watch
  };

  // 3. Stores Road & Pipeline
  const stores_road = {
    steps: [
      { key: 'requested', label: 'Requested', count: sm.steps.requested || 0 },
      { key: 'certified', label: 'Certified', count: sm.steps.certified || 0 },
      { key: 'to_buy', label: 'To Buy', count: sm.steps.to_buy || 0 },
      { key: 'on_order', label: 'On Order', count: sm.steps.on_order || 0 },
      { key: 'received', label: 'Received', count: (sm.steps.ready || 0) + (sm.steps.done || 0) },
      { key: 'priced', label: 'Unpriced', count: sm.steps.unpriced || 0 },
      { key: 'issued', label: 'Issued / Done', count: sm.steps.done || 0 }
    ],
    today: {
      issued: sm.issued_today || 0,
      received: sm.received_today || 0,
      transfers_week: sm.transfers_week || 0
    },
    shelf: {
      low_stock: sm.low_stock || 0,
      battery_warranty: sm.battery_warranty || 0,
      stock_takes: sm.stock_takes || { counting: 0, submitted: 0 },
      old_units_due: sm.old_units_due || { tyre: 0, battery: 0 },
      disposals: sm.disposals || 0,
      unpriced_receipts: sm.steps.unpriced_receipts || 0
    }
  };

  // 4. Process-Wise Approvals
  const mOwn = scope.filter(user, 'm.workshop_id');
  const rOwn = scope.filter(user, 'r.workshop_id', { store: false });
  const and = (f) => (f.sql ? ` AND ${f.sql}` : '');
  const INFLOW_MRN = "approval_status = 'requested' AND requested_by IS NOT NULL AND TRIM(requested_by) <> ''";
  const lineCount = '(SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) lines';

  // Process Group 1: Inflow & Request Certification
  const inflow = [];
  if (may('jobrequests.certify')) {
    const jrs = all(`SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.description,
          a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
        WHERE r.approval_status = 'requested'${and(rOwn)} ORDER BY r.id DESC LIMIT 30`, ...rOwn.params);
    for (const r of jrs) {
      inflow.push({
        id: r.id, kind: 'jr_certify', ref: r.jr_no, title: `Job Request ${r.jr_no}`,
        vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
        description: r.description, requester: r.requested_by, date: r.req_date,
        link: `#/jobrequests/${r.id}`, action: 'Certify'
      });
    }
  }
  // The workshop's own step: a job request with all three signatures, waiting for its job card.
  // Without this the workshop has no prompt that work has been cleared for it.
  if (may('jobs.create')) {
    const waiting = all(`SELECT r.id, r.jr_no, r.req_date, r.approved_at, r.requested_by, r.certified_by, r.approved_by, r.description,
          a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
        WHERE r.approval_status = 'approved' AND r.job_id IS NULL${and(rOwn)} ORDER BY r.approved_at, r.id LIMIT 30`, ...rOwn.params);
    for (const r of waiting) {
      inflow.push({
        id: r.id, kind: 'jr_open_card', ref: r.jr_no, title: `Job Request ${r.jr_no}`,
        vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
        description: r.description, requester: r.requested_by, certified_by: r.certified_by,
        approved_by: r.approved_by, date: (r.approved_at || r.req_date || '').slice(0, 10),
        link: `#/jobrequests/${r.id}`, action: 'Open job card'
      });
    }
  }
  if (may('stores.mrn.certify')) {
    const mrns = all(`SELECT m.id, m.mrn_no, m.req_date, m.requested_by, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${lineCount}
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE ${INFLOW_MRN}${and(mOwn)} ORDER BY m.req_date DESC, m.id DESC LIMIT 30`, ...mOwn.params);
    for (const m of mrns) {
      inflow.push({
        id: m.id, kind: 'mrn_certify', ref: m.mrn_no, title: `MRN ${m.mrn_no}`,
        vehicle: [m.asset_reg, m.asset_ec, m.asset_code].filter(Boolean).join(' · '),
        description: `${m.lines} item(s)`, requester: m.requested_by, date: m.req_date,
        link: `#/stores?tab=mrn&id=${m.id}`, action: 'Certify'
      });
    }
  }

  // Process Group 2: Operations & Commercial Authorizations
  const authorizations = [];
  if (may('jobrequests.approve')) {
    const jrs = all(`SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.certified_by, r.description,
          a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
        WHERE r.approval_status = 'certified'${and(rOwn)} ORDER BY r.id DESC LIMIT 30`, ...rOwn.params);
    for (const r of jrs) {
      authorizations.push({
        id: r.id, kind: 'jr_approve', ref: r.jr_no, title: `Job Request ${r.jr_no}`,
        vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
        description: r.description, requester: r.requested_by, certified_by: r.certified_by, date: r.req_date,
        link: `#/jobrequests/${r.id}`, action: 'Approve'
      });
    }
  }
  if (may('jobs.approve_transport')) {
    const jc = all(`SELECT j.id, j.job_no, j.requested_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
        WHERE j.status = 'REQUESTED' AND j.approved_transport_at IS NULL AND j.is_historical = 0${and(jOwn)} ORDER BY j.id DESC LIMIT 30`, ...jOwn.params);
    for (const j of jc) {
      authorizations.push({
        id: j.id, kind: 'job_transport', ref: j.job_no, title: `Job Card ${j.job_no}`,
        vehicle: [j.asset_reg, j.asset_ec, j.asset_code].filter(Boolean).join(' · '),
        description: j.description, date: j.requested_at,
        link: `#/jobs/${j.id}`, action: 'Transport Approve'
      });
    }
  }
  if (may('jobs.approve_operations')) {
    const jc = all(`SELECT j.id, j.job_no, j.requested_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
        WHERE j.approved_transport_at IS NOT NULL AND j.approved_ops_at IS NULL AND j.is_historical = 0${and(jOwn)} ORDER BY j.id DESC LIMIT 30`, ...jOwn.params);
    for (const j of jc) {
      authorizations.push({
        id: j.id, kind: 'job_ops', ref: j.job_no, title: `Job Card ${j.job_no}`,
        vehicle: [j.asset_reg, j.asset_ec, j.asset_code].filter(Boolean).join(' · '),
        description: j.description, date: j.requested_at,
        link: `#/jobs/${j.id}`, action: 'Operations Approve'
      });
    }
  }
  if (may('stores.mrn.approve')) {
    const mrns = all(`SELECT m.id, m.mrn_no, m.req_date, m.requested_by, m.certified_by, m.certified_at, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, ${lineCount}
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id WHERE m.approval_status = 'certified'${and(mOwn)} ORDER BY m.certified_at DESC, m.id DESC LIMIT 30`, ...mOwn.params);
    for (const m of mrns) {
      const worth = limits.mrnValue(m.id);
      const within = limits.check(user, 'mrn_approve', worth.value);
      authorizations.push({
        id: m.id, kind: 'mrn_approve', ref: m.mrn_no, title: `MRN ${m.mrn_no}`,
        vehicle: [m.asset_reg, m.asset_ec, m.asset_code].filter(Boolean).join(' · '),
        description: `${m.lines} item(s)`, requester: m.requested_by, certified_by: m.certified_by, date: m.req_date,
        value: worth.value, unpriced: worth.unpriced, over_limit: !within.ok, limit: within.limit, who_can: within.who_can,
        link: `#/stores?tab=mrn&id=${m.id}`, action: 'Approve'
      });
    }
  }

  // Process Group 3: Warehouse & Physical Controls
  const warehouse = [];
  if (may('stores.grn.approve')) {
    try {
      const pendingGrns = all(`SELECT v.id, v.grn_no, v.received_date, v.supplier, sl.name AS store_name,
          (SELECT COUNT(*) FROM grn g WHERE g.voucher_id = v.id OR g.grn_no = v.grn_no) AS lines
          FROM grn_vouchers v LEFT JOIN store_locations sl ON sl.id = v.physical_store_id
          WHERE v.status = 'pending_approval' ORDER BY v.id DESC LIMIT 20`);
      for (const v of pendingGrns) {
        warehouse.push({
          id: v.id, kind: 'grn_approve', ref: v.grn_no, title: `GRN Voucher ${v.grn_no}`,
          vehicle: v.store_name || v.supplier || 'Stores', description: `${v.lines || 1} item(s) · ${v.supplier || 'Supplier'}`,
          date: v.received_date, link: `#/stores?tab=flow&sub=grn&id=${v.id}`, action: 'Approve GRN'
        });
      }
    } catch (e) { /* table optional */ }
  }
  if (may('stores.min.approve')) {
    try {
      const pendingMins = all(`SELECT n.id, n.min_no, n.issue_date, n.purpose, n.requested_by, a.code AS asset_code, a.registration AS asset_reg,
          (SELECT COUNT(*) FROM issues i WHERE i.min_id = n.id OR i.min_no = n.min_no) AS lines
          FROM min_notes n LEFT JOIN assets a ON a.id = n.asset_id
          WHERE n.status = 'requested' ORDER BY n.id DESC LIMIT 20`);
      for (const n of pendingMins) {
        warehouse.push({
          id: n.id, kind: 'min_approve', ref: n.min_no, title: `Issue Note ${n.min_no}`,
          vehicle: [n.asset_reg, n.asset_code].filter(Boolean).join(' · ') || 'General Issue',
          description: `${n.lines || 1} item(s) · ${n.purpose || ''}`, requester: n.requested_by,
          date: n.issue_date, link: `#/stores?tab=flow&sub=issues&min=${n.id}`, action: 'Approve MIN'
        });
      }
    } catch (e) { /* table optional */ }
  }
  if (may('stores.mtn.approve')) {
    try {
      const pendingMtns = all(`SELECT t.id, t.mtn_no, t.txn_date, t.description, t.from_location, t.to_location,
          fl.name AS from_store_name, tl.name AS to_store_name
          FROM mtn t LEFT JOIN store_locations fl ON fl.id = t.from_store_location_id
          LEFT JOIN store_locations tl ON tl.id = t.to_store_location_id
          WHERE t.status IN ('draft', 'pending_approval') ORDER BY t.id DESC LIMIT 20`);
      for (const t of pendingMtns) {
        warehouse.push({
          id: t.id, kind: 'mtn_approve', ref: t.mtn_no, title: `Transfer ${t.mtn_no}`,
          vehicle: `${t.from_store_name || t.from_location || 'Origin'} → ${t.to_store_name || t.to_location || 'Dest'}`,
          description: t.description || 'Material Transfer', date: t.txn_date,
          link: `#/stores?tab=mtn&id=${t.id}`, action: 'Approve MTN'
        });
      }
    } catch (e) { /* table optional */ }
  }
  if (may('stores.mtn.edit') || may('stores.grn.receive')) {
    try {
      const inTransitMtns = all(`SELECT t.id, t.mtn_no, t.txn_date, t.status, t.description, t.from_location, t.to_location,
          fl.name AS from_store_name, tl.name AS to_store_name
          FROM mtn t LEFT JOIN store_locations fl ON fl.id = t.from_store_location_id
          LEFT JOIN store_locations tl ON tl.id = t.to_store_location_id
          WHERE t.status IN ('dispatched', 'received') ORDER BY t.id DESC LIMIT 20`);
      for (const t of inTransitMtns) {
        warehouse.push({
          id: t.id, kind: 'mtn_receive', ref: t.mtn_no, title: `In-Transit MTN ${t.mtn_no}`,
          vehicle: `${t.from_store_name || t.from_location || 'Origin'} → ${t.to_store_name || t.to_location || 'Site Store'}`,
          description: `${t.description || 'Transfer'} (${t.status === 'received' ? 'Ready to Accept' : 'Dispatched'})`,
          date: t.txn_date, link: `#/stores?tab=mtn&id=${t.id}`,
          action: t.status === 'received' ? 'Accept Stock' : 'Receive MTN'
        });
      }
    } catch (e) { /* table optional */ }
  }
  if (may('stores.count.approve')) {
    const submittedSessions = all(`SELECT s.id, s.count_no, s.scope, s.kind, s.started_at, w.name AS store_name
        FROM count_sessions s LEFT JOIN workshops w ON w.id = s.store_id
        WHERE s.status = 'submitted' ORDER BY s.id DESC LIMIT 20`);
    for (const s of submittedSessions) {
      warehouse.push({
        id: s.id, kind: 'stock_take', ref: s.count_no || `#${s.id}`, title: `Stock Take ${s.count_no || ('#' + s.id)}`,
        vehicle: s.store_name, description: `${s.scope} count · ${s.kind}`, date: s.started_at,
        link: `#/stores?tab=counts&id=${s.id}`, action: 'Review Take'
      });
    }
  }
  if (may('stores.disposal.approve')) {
    const openDisposals = all(`SELECT d.id, d.disposal_no, d.created_at, w.name AS store_name,
        (SELECT COUNT(*) FROM disposal_lines l WHERE l.disposal_id = d.id) AS lines
        FROM disposals d LEFT JOIN workshops w ON w.id = d.store_id
        WHERE d.status = 'open' ORDER BY d.id DESC LIMIT 20`);
    for (const d of openDisposals) {
      warehouse.push({
        id: d.id, kind: 'disposal', ref: d.disposal_no, title: `Disposal ${d.disposal_no}`,
        vehicle: d.store_name, description: `${d.lines} item(s) for disposal`, date: d.created_at,
        link: `#/stores?tab=disposals&id=${d.id}`, action: 'Review Disposal'
      });
    }
  }

  // Process Group 4: Compliance, Workday & Reopens
  const compliance = [];
  if (may('attendance.signoff') && attendance.isEnabled()) {
    const wsList = attendanceWorkshops(user);
    const unsignedDays = unsignedFor(wsList);
    for (const d of unsignedDays) {
      compliance.push({
        id: d.date, kind: 'signoff', ref: d.date, title: `Workday Sign-off: ${d.date}`,
        vehicle: d.workshop_name || 'Workshop', description: `Attendance & daily work · ${d.red_count || 0} red flag(s)`,
        date: d.date, red_count: d.red_count,
        link: `#/dailywork?att=${encodeURIComponent(d.date)}${d.workshop_id ? '&att_ws=' + d.workshop_id : ''}`,
        action: 'Sign off'
      });
    }
  }
  if (may('jobs.reopen') && jobstate.partialCloseEnabled()) {
    const adminRole = (user.roles || []).includes('admin');
    const reopenReqs = jobClose.pendingRequests({ excludeRequester: adminRole ? null : user.id, workshopId: rReach });
    for (const r of reopenReqs) {
      compliance.push({
        id: r.id, kind: 'reopen', ref: r.job_no, title: `Reopen Request: ${r.job_no}`,
        vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
        description: r.reason, requester: r.requested_by_name, date: r.requested_at,
        link: `#/jobs/${r.job_id}`, action: 'Decide'
      });
    }
  }
  if (may('jobs.close')) {
    const readyJobs = jobsFlow.ready(user, { limit: 10 });
    for (const r of (readyJobs.rows || [])) {
      compliance.push({
        id: r.id, kind: 'ready_to_close', ref: r.job_no, title: `Ready to Close: ${r.job_no}`,
        vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
        description: `${r.description || ''} · Total Rs ${Number(r.cost && r.cost.total || 0).toLocaleString()}`,
        date: r.since,
        link: `#/jobs/${r.id}`, action: 'Close Job'
      });
    }
  }

  const total_pending = inflow.length + authorizations.length + warehouse.length + compliance.length;
  const is_approver = total_pending > 0 || [
    'stores.mrn.certify', 'stores.mrn.approve', 'stores.grn.approve', 'stores.min.approve', 'stores.mtn.approve',
    'jobs.approve_transport', 'jobs.approve_operations', 'jobrequests.certify', 'jobrequests.approve',
    'jobs.create', 'attendance.signoff', 'jobs.reopen', 'stores.count.approve', 'stores.disposal.approve'
  ].some(may);

  // 5. Admin / Manager On-Hold & Bottleneck Center
  const on_hold = {
    jobs_waiting_parts: (jobsFlow.ongoing(user, { show: 'parts', limit: 12 }).rows || []).map((r) => ({
      id: r.id, job_no: r.job_no, vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
      days_idle: r.days_idle, reason_note: r.reason_note, pending_lines: r.pending_parts ? r.pending_parts.length : 0,
      link: `#/jobs/${r.id}`
    })),
    unattended_jobs: (jobsFlow.ongoing(user, { show: 'red', limit: 12 }).rows || []).map((r) => ({
      id: r.id, job_no: r.job_no, vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
      days_idle: r.days_idle, description: r.description,
      has_reason: !!r.reason, reason_label: r.reason_label,
      link: `#/jobs/${r.id}`
    })),
    stuck_cards_count: jm.watch ? jm.watch.stuck : 0,
    stuck_cards_sample: jobsFlow.requests(user, { step: 'stuck', limit: 6 }).map((r) => ({
      id: r.id, no: r.no, vehicle: [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · '),
      since: r.since, days: r.days, link: r.link
    })),
    dual_open_vehicles: jobstate.duplicateOpenJobs({ workshopId: rReach }),
    unpriced_grns_count: sm.steps.unpriced_receipts || 0,
    unpriced_grns_sample: storesFlow.lines(user, { step: 'unpriced', limit: 6 }).map((l) => ({
      id: l.unpriced_grn_id, mrn_no: l.mrn_no, item: l.description, supplier: l.bought_from,
      qty: l.received, link: `#/stores?tab=flow&sub=lines&step=unpriced`
    })),
    unreturned_cores: sm.old_units_due || { tyre: 0, battery: 0 }
  };

  const on_hold_total = (on_hold.jobs_waiting_parts ? on_hold.jobs_waiting_parts.length : 0)
    + (on_hold.unattended_jobs ? on_hold.unattended_jobs.length : 0)
    + (on_hold.dual_open_vehicles ? on_hold.dual_open_vehicles.length : 0)
    + (on_hold.stuck_cards_count || 0)
    + (on_hold.unpriced_grns_count || 0)
    + (on_hold.unreturned_cores ? ((on_hold.unreturned_cores.tyre || 0) + (on_hold.unreturned_cores.battery || 0)) : 0);

  const userScope = rReach && rReach.length === 1
    ? { id: rReach[0], label: (get('SELECT name FROM workshops WHERE id = ?', rReach[0]) || {}).name || null }
    : null;

  const canSeeMechanics = canMod('dailywork') || canMod('labour') || canReports;
  const mechanics_pulse = canSeeMechanics ? mechanicsPulse(user, rReach) : null;

  const privilege_profile = {
    roles: user.roles || [],
    is_admin: (user.roles || []).includes('admin'),
    domains: {
      jobs: canMod('jobs') || canMod('jobrequests') || canMod('service'),
      stores: canMod('stores') || canMod('oil') || canMod('generalstock'),
      purchasing: canMod('purchasing'),
      mechanics: canSeeMechanics,
      assets: canMod('assets') || canMod('batteries') || canMod('tyres'),
      reports: canReports,
    },
    approver_badges: [
      may('jobrequests.certify') ? 'Certify Job Requests' : null,
      may('jobrequests.approve') ? 'Approve Job Requests' : null,
      may('jobs.approve_transport') ? 'Transport Approve Jobs' : null,
      may('jobs.approve_operations') ? 'Operations Approve Jobs' : null,
      may('stores.mrn.certify') ? 'Certify MRN' : null,
      may('stores.mrn.approve') ? 'Approve MRN' : null,
      may('stores.grn.approve') ? 'Approve GRN' : null,
      may('stores.min.approve') ? 'Approve MIN' : null,
      may('stores.mtn.approve') ? 'Approve MTN' : null,
      may('stores.count.approve') ? 'Approve Stock Take' : null,
      may('stores.disposal.approve') ? 'Approve Disposals' : null,
      may('attendance.signoff') ? 'Sign-off Workday' : null,
      may('jobs.close') ? 'Close Job Cards' : null,
    ].filter(Boolean)
  };

  res.json({
    kpis: {
      active_jobs, vehicles_in_workshop, total_pending,
      monthly_cost_total, low_stock_total, on_hold_total,
      field_down: jm.watch ? jm.watch.breakdowns_down : null
    },
    jobs_pipeline: jobs_road,
    stores_pipeline: stores_road,
    mechanics_pulse,
    privilege_profile,
    approvals_process: {
      inflow,
      authorizations,
      warehouse,
      compliance,
      total_pending,
      is_approver
    },
    on_hold,
    user_scope: userScope
  });
}));

// ---- lightweight poll -----------------------------------------------------
router.get('/live-stats', asyncHandler((req, res) => {
  const ws = scope.reach(req.user);   // Step 2b: as the overview
  const canReports = permissions.reaches(req.user, 'reports') || hasCap(req.user, 'reports.financial');
  const c = counts(ws);
  const low = lowStock(req.user);
  res.json({
    active_jobs: c.active_jobs, pending_requests: c.pending_requests,
    low_stock_alerts: low.general + low.oil + low.filter,
    todays_cost: canReports ? c.todays_issue_cost : null,
    monthly_cost: canReports ? costFigures(ws).monthly_cost_total : null,
  });
}));

module.exports = router;
