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

const OPEN_JOBS = require('../lib/jobstate').openSql();   // cards that hold their vehicle
const jobsFlow = require('../lib/jobs_flow');
const storesFlow = require('../lib/stores_flow');
const jobstate = require('../lib/jobstate');
const scope = require('../lib/scope');
const limits = require('../lib/approval_limits');
const { hasCap } = require('../lib/auth');
const attendance = require('../lib/attendance');
const jobClose = require('../lib/job_close');

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
  const jm = jobsFlow.monitor(user);
  const sm = storesFlow.monitor(user);
  const rReach = scope.reach(user);
  const { year, month } = nowYM();

  // 1. Core KPIs
  const jOwn = scope.filter(user, 'j.workshop_id');
  const andJ = jOwn.sql ? ` AND ${jOwn.sql}` : '';
  const active_jobs = get(`SELECT COUNT(*) c FROM job_cards j WHERE ${jobstate.openSql('j')}${andJ}`, ...jOwn.params).c;
  const vehicles_in_workshop = get(`SELECT COUNT(DISTINCT j.asset_id) c FROM job_cards j WHERE ${jobstate.openSql('j')} AND j.asset_id IS NOT NULL${andJ}`, ...jOwn.params).c;
  const monthly_cost_total = get(`SELECT COALESCE(SUM(total_cost), 0) v FROM vehicle_monthly_costs WHERE year = ? AND month = ?`, year, month).v;
  const low_stock_items = get(`SELECT COUNT(*) c FROM store_items WHERE ${LOW_GENERAL}`).c;
  const low_oil_stock = get(`SELECT COUNT(*) c FROM products WHERE active = 1 AND ${LOW_OIL}`).c;
  const low_filter_stock = get(`SELECT COUNT(*) c FROM filter_stock WHERE ${LOW_FILTER}`).c;
  const low_stock_total = low_stock_items + low_oil_stock + low_filter_stock;

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
  const is_approver = total_pending > 0 || ['stores.mrn.certify', 'stores.mrn.approve', 'jobs.approve_transport', 'jobs.approve_operations', 'jobrequests.certify', 'jobrequests.approve', 'attendance.signoff', 'jobs.reopen', 'stores.count.approve', 'stores.disposal.approve'].some(may);

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
      qty: l.received, link: `#/stores?tab=items&step=unpriced`
    })),
    unreturned_cores: sm.old_units_due || { tyre: 0, battery: 0 }
  };

  const userScope = rReach && rReach.length === 1
    ? { id: rReach[0], label: (get('SELECT name FROM workshops WHERE id = ?', rReach[0]) || {}).name || null }
    : null;

  res.json({
    kpis: {
      active_jobs, vehicles_in_workshop, total_pending,
      monthly_cost_total, low_stock_total,
      field_down: jm.watch ? jm.watch.breakdowns_down : null
    },
    jobs_pipeline: jobs_road,
    stores_pipeline: stores_road,
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
