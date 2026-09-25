'use strict';

// ===========================================================================
// Stores: one list of every requested item, and the Monitor (stores plan, Part 1).
//
// Each line of a material request (MRN) walks the same road:
//
//   Requested → Certified → Approved → Bought → Received → Priced → Issued
//
// The list shows every line with how far it has come, and the Monitor counts what is waiting at
// each step. Nothing new is stored: every figure is read from the request, its receipts (grn),
// what was handed over from them (issues, less what came back unused, and the tyre/battery issues)
// and the buying record (mrn_lines.purchased_at).
//
// Only requests raised in the system are worked on. Requests imported from the old books carry no
// requester and most were never bought as written (see src/routes/purchasing.js); they stay
// searchable under "All", marked as imported history, but never fill a to-do list.
//
// A store's general request (request_type 'general') restocks the shelf: once it is received the
// line is done — its items are handed over later from stock, not from this request.
// ===========================================================================

const { get, all } = require('../db');
const scope = require('./scope');
const stores = require('./stores');

const KINDS = ['general', 'oil', 'filter', 'tyre', 'battery'];

// The same reading of a free-text category as src/lib/stock.js sectionOf(), in SQL so the list can
// be filtered before its LIMIT. A tyre or battery request says so itself.
const KIND_SQL = `CASE
  WHEN m.tb_kind IN ('tyre','battery') THEN m.tb_kind
  WHEN lower(COALESCE(ml.category,'')) LIKE '%filter%' THEN 'filter'
  WHEN lower(COALESCE(ml.category,'')) LIKE '%batter%' THEN 'battery'
  WHEN lower(COALESCE(ml.category,'')) LIKE '%tyre%' OR lower(COALESCE(ml.category,'')) LIKE '%tire%' THEN 'tyre'
  WHEN lower(COALESCE(ml.category,'')) LIKE '%lubric%' OR lower(COALESCE(ml.category,'')) LIKE '%oil%' THEN 'oil'
  ELSE 'general' END`;

// What came off each receipt of the line to a job — less what came back unused (Stage 6) — plus
// the tyres and batteries issued against it.
const ISSUED_SQL = `ROUND(
    COALESCE((SELECT SUM(i.qty) FROM issues i JOIN grn g ON g.id = i.grn_id WHERE g.mrn_line_id = ml.id), 0)
  - COALESCE((SELECT SUM(r.qty) FROM issue_returns r JOIN issues i ON i.id = r.issue_id JOIN grn g ON g.id = i.grn_id
               WHERE g.mrn_line_id = ml.id), 0)
  + COALESCE((SELECT SUM(t.qty) FROM tyre_battery_issues t WHERE t.mrn_line_id = ml.id), 0), 2)`;

const LINE_SQL = `
  SELECT ml.id, ml.mrn_id, m.mrn_no, m.req_date, m.required_date, m.requested_by, m.approval_status,
         m.status AS mrn_status, m.request_type, m.workshop_id,
         w.code AS workshop_code, w.name AS workshop_name,
         ml.description, ml.category, ml.unit, ml.qty,
         ROUND(COALESCE(ml.qty_received, 0), 2) AS received,
         COALESCE(ml.purchase_source, m.purchase_source) AS source,
         ml.purchased_at, ml.supplier AS bought_from,
         a.id AS asset_id, a.code AS asset_code, a.registration AS asset_reg,
         j.id AS job_id, j.job_no,
         ${KIND_SQL} AS kind,
         CASE WHEN TRIM(COALESCE(m.requested_by, '')) <> '' THEN 1 ELSE 0 END AS inflow,
         (SELECT COUNT(*) FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price IS NULL) AS unpriced,
         (SELECT MIN(g.id) FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price IS NULL) AS unpriced_grn_id,
         (SELECT MIN(g.id) FROM grn g WHERE g.mrn_line_id = ml.id
            AND g.qty > (SELECT COALESCE(SUM(i.qty), 0) FROM issues i WHERE i.grn_id = g.id)
                         - (SELECT COALESCE(SUM(r.qty), 0) FROM issue_returns r JOIN issues i ON i.id = r.issue_id WHERE i.grn_id = g.id)) AS shelf_grn_id,
         ${ISSUED_SQL} AS issued,
         (SELECT ROUND(COALESCE(SUM(g.qty * g.unit_price), 0), 2) FROM grn g WHERE g.mrn_line_id = ml.id AND g.unit_price IS NOT NULL) AS value,
         (SELECT MAX(date(NULLIF(g.delivery_date, ''))) FROM grn g WHERE g.mrn_line_id = ml.id) AS last_received
    FROM mrn_lines ml
    JOIN mrn m ON m.id = ml.mrn_id
    LEFT JOIN assets a ON a.id = m.asset_id
    LEFT JOIN job_cards j ON j.id = m.job_id
    LEFT JOIN workshops w ON w.id = m.workshop_id`;

// The to-do each step names, over a row of LINE_SQL (aliased x). Imported history is never a to-do.
const LIVE = `x.inflow = 1 AND x.approval_status <> 'rejected' AND x.mrn_status <> 'cancelled'`;
const STEP_WHERE = {
  // A request still waiting for a signature is waiting for it, whatever has already arrived.
  requested: `${LIVE} AND x.approval_status = 'requested'`,
  certified: `${LIVE} AND x.approval_status = 'certified'`,
  // Approved; a tyre or battery request sent to head office to be bought (Stage T&B) is approved first.
  to_buy: `${LIVE} AND x.approval_status = 'approved' AND x.purchased_at IS NULL AND x.received = 0`,
  on_order: `${LIVE} AND x.received < x.qty - 0.001 AND (x.purchased_at IS NOT NULL OR x.received > 0)`,
  unpriced: `x.inflow = 1 AND x.unpriced > 0`,
  ready: `${LIVE} AND x.request_type <> 'general' AND x.received - x.issued > 0.001`,
  done: `${LIVE} AND x.received >= x.qty - 0.001 AND x.unpriced = 0
           AND (x.request_type = 'general' OR x.received - x.issued <= 0.001)`,
  rejected: `x.inflow = 1 AND (x.approval_status = 'rejected' OR x.mrn_status = 'cancelled')`,
  imported: 'x.inflow = 0',
};
// Everything still to do: live, and not done.
STEP_WHERE.open = `${LIVE} AND NOT (${STEP_WHERE.done})`;
const STEPS = Object.keys(STEP_WHERE);

/** The line's current step — the first thing still to do on it, in the order of the road. */
function stepOf(x) {
  if (!x.inflow) return 'imported';
  if (x.approval_status === 'rejected' || x.mrn_status === 'cancelled') return 'rejected';
  if (x.approval_status === 'requested') return 'requested';
  if (x.approval_status === 'certified') return 'certified';
  if (x.request_type !== 'general' && x.received - x.issued > 0.001) return 'ready';
  if (x.unpriced > 0) return 'unpriced';
  if (x.received < x.qty - 0.001) return x.purchased_at || x.received > 0 ? 'on_order' : 'to_buy';
  return 'done';
}

/**
 * The road, milestone by milestone: each is done, now (the step the line waits at), todo, or skip
 * (it does not apply — a restocking request is never issued to a job).
 */
function roadOf(x, step) {
  // Imported history was never signed in the system; what it received says it went ahead.
  const approved = x.approval_status === 'approved' || (!x.inflow && x.received > 0);
  const received = x.received >= x.qty - 0.001 ? 'done' : (x.received > 0 ? 'part' : 'todo');
  const road = [
    { key: 'requested', label: 'Requested', state: 'done' },
    { key: 'approved', label: 'Approved', state: approved ? 'done' : (x.approval_status === 'rejected' ? 'stop' : 'now') },
    { key: 'bought', label: 'Bought', state: x.purchased_at || x.received > 0 ? 'done' : (approved ? 'now' : 'todo') },
    { key: 'received', label: 'Received', state: received },
    { key: 'priced', label: 'Priced', state: x.received === 0 ? 'todo' : (x.unpriced > 0 ? 'now' : 'done') },
    { key: 'issued', label: x.request_type === 'general' ? 'To stock' : 'Issued',
      state: x.request_type === 'general' ? (received === 'done' ? 'done' : 'todo')
        : (x.received === 0 ? 'todo' : (x.received - x.issued > 0.001 ? 'now' : (received === 'done' ? 'done' : 'part'))) },
  ];
  if (step === 'on_order' && road[3].state === 'todo') road[3].state = 'now';
  return road;
}

/** Who sees what: your workshops' requests (Stage 3/4) — head office and a store serving all: every one. */
function ownWhere(user) {
  return scope.filter(user, 'm.workshop_id');
}

/**
 * The list: one row per requested item. query: step (see STEPS; default open), kind, q, source,
 * workshop_id, limit.
 */
function lines(user, query = {}) {
  const inner = [];
  const p = [];
  const own = ownWhere(user);
  if (own.sql) { inner.push(own.sql); p.push(...own.params); }
  if (query.workshop_id) { inner.push('m.workshop_id = ?'); p.push(Number(query.workshop_id)); }
  if (query.mrn_id) { inner.push('m.id = ?'); p.push(Number(query.mrn_id)); }
  if (query.job_id) { inner.push('m.job_id = ?'); p.push(Number(query.job_id)); }
  if (query.source === 'head_office' || query.source === 'local_purchase') {
    inner.push('COALESCE(ml.purchase_source, m.purchase_source) = ?'); p.push(query.source);
  }
  const q = String(query.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    inner.push(`(m.mrn_no LIKE ? OR ml.description LIKE ? OR ml.category LIKE ? OR a.code LIKE ? OR a.registration LIKE ?
                 OR a.ec_code LIKE ? OR j.job_no LIKE ? OR m.requested_by LIKE ? OR ml.supplier LIKE ?
                 OR EXISTS (SELECT 1 FROM grn g WHERE g.mrn_line_id = ml.id AND (g.supplier LIKE ? OR g.invoice_no LIKE ? OR g.grn_no LIKE ?)))`);
    for (let i = 0; i < 12; i++) p.push(like);
  }
  const outer = [];
  const step = STEPS.includes(query.step) ? query.step : (query.step === 'all' ? null : 'open');
  if (step) outer.push(STEP_WHERE[step]);
  if (KINDS.includes(query.kind)) { outer.push('x.kind = ?'); p.push(query.kind); }
  const limit = Math.min(Math.max(Number(query.limit) || 300, 1), 5000);
  const rows = all(
    `SELECT x.* FROM (${LINE_SQL} ${inner.length ? 'WHERE ' + inner.join(' AND ') : ''}) x
      ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}
      ORDER BY x.req_date DESC, x.mrn_id DESC, x.id
      LIMIT ${limit}`, ...p);
  const stock = require('./stock');
  for (const r of rows) {
    r.step = stepOf(r);
    r.road = roadOf(r, r.step);
    r.on_shelf = r.request_type === 'general' ? 0 : Math.max(0, Math.round((r.received - r.issued) * 100) / 100);
    // What the line's buttons act on: the receipt still on the shelf (to issue), and the receipt
    // still awaiting its price.
    if (r.on_shelf > 0 && r.shelf_grn_id) {
      const g = stock.receivedLine(r.shelf_grn_id);
      if (g) r.shelf = { grn_id: g.grn_id, grn_no: g.grn_no, remaining: g.remaining, unit_price: g.unit_price, unit: g.unit, section: g.section };
    }
    if (r.unpriced_grn_id) {
      r.price_grn = get(`SELECT id, grn_no, qty, unit_price, supplier, invoice_no, invoice_date, purchase_source, description
                           FROM grn WHERE id = ?`, r.unpriced_grn_id);
    }
  }
  return rows;
}

/** The store whose shelf a person watches: theirs when the workshops are kept apart, else all. */
function watchedStore(user) {
  return stores.isMulti() && scope.enabled() && !scope.headOffice(user) ? stores.homeStore(user) : null;
}

/**
 * The Monitor: what is waiting at each step (the same rules as the list's filters), what moved today,
 * and what needs watching on the shelf.
 */
function monitor(user) {
  const own = ownWhere(user);
  const sums = STEPS.filter((s) => !['imported', 'rejected'].includes(s))
    .map((s) => `SUM(CASE WHEN ${STEP_WHERE[s]} THEN 1 ELSE 0 END) AS ${s}`).join(', ');
  const counts = get(
    `SELECT ${sums}, SUM(CASE WHEN ${STEP_WHERE.unpriced} THEN x.unpriced ELSE 0 END) AS unpriced_receipts
       FROM (${LINE_SQL} ${own.sql ? 'WHERE ' + own.sql : ''}) x`, ...own.params);
  for (const k of Object.keys(counts)) counts[k] = counts[k] || 0;

  // Requests (the whole MRN) waiting for a signature.
  const mOwn = own.sql ? ` AND ${own.sql}` : '';
  const INFLOW = "TRIM(COALESCE(m.requested_by, '')) <> ''";
  const to_certify = get(`SELECT COUNT(*) n FROM mrn m WHERE ${INFLOW} AND m.approval_status = 'requested'${mOwn}`, ...own.params).n;
  const to_approve = get(`SELECT COUNT(*) n FROM mrn m WHERE ${INFLOW} AND m.approval_status = 'certified'${mOwn}`, ...own.params).n;

  // Moved today and this week — in your store when the workshops are kept apart.
  const store = watchedStore(user);
  const st = store ? ' AND store_id = ?' : '';
  const sp = store ? [store] : [];
  const issued_today = get(`SELECT COUNT(*) n FROM issues WHERE date(issue_date) = date('now', 'localtime')${st}`, ...sp).n
    + get("SELECT COUNT(*) n FROM tyre_battery_issues WHERE date(issue_date) = date('now', 'localtime')").n;
  const received_today = get(`SELECT COUNT(*) n FROM grn WHERE date(NULLIF(delivery_date, '')) = date('now', 'localtime')${st}`, ...sp).n;
  const transfers_week = store
    ? get(`SELECT COUNT(DISTINCT t.id) n FROM mtn t JOIN mtn_lines l ON l.mtn_id = t.id
            WHERE date(t.txn_date) >= date('now', 'localtime', '-6 day') AND (l.from_store_id = ? OR l.to_store_id = ?)`, store, store).n
    : get("SELECT COUNT(*) n FROM mtn WHERE date(txn_date) >= date('now', 'localtime', '-6 day')").n;

  // On the shelf: items at or under the level the store reorders them at (Stage 4), in your store —
  // or, for head office, in every store.
  const stock = require('./stock');
  const storeIds = store ? [store] : all('SELECT DISTINCT store_id FROM store_reorder').map((r) => r.store_id);
  let low_stock = 0;
  for (const sid of storeIds) for (const section of stock.SECTIONS) low_stock += stock.items(section, null, 5000, { store: sid, low: true }).length;

  const battery_warranty = require('./intelligence').warrantyRadar(60).expiring.length;

  // Stock takes (Part 2): being counted, and waiting for head office.
  const stock_takes = require('./stock_count').waiting(store);

  // Tyres and batteries (Part 4): old units nobody has said what became of (ST-D8), and disposal
  // notes waiting for a manager.
  const old_units_due = get(`SELECT COALESCE(SUM(i.kind = 'tyre'), 0) AS tyre, COALESCE(SUM(i.kind = 'battery'), 0) AS battery
                               FROM tyre_battery_issues i
                              WHERE i.source = 'request' AND i.kind IN ('tyre','battery')
                                AND NOT EXISTS (SELECT 1 FROM tb_returns r WHERE r.issue_id = i.id)${store ? ' AND i.store_id = ?' : ''}`, ...sp);
  const disposals = require('./disposal').waiting(store);

  return {
    steps: counts, to_certify, to_approve, issued_today, received_today, transfers_week, low_stock, battery_warranty, stock_takes,
    old_units_due, disposals,
    store: store ? { id: store, label: stores.label(store) } : null,
  };
}

// LINE_SQL and STEP_WHERE: the Job Cards Ongoing tab reads a card's parts by the same rules (job cards plan, Part 2).
module.exports = { KINDS, STEPS, LINE_SQL, STEP_WHERE, lines, monitor, stepOf, roadOf };
