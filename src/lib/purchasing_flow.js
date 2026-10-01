'use strict';

// ===========================================================================
// Purchasing & Procurement Flow: Monitor, Queues, Road, and Workshop Urgency.
//
// Matches the Stores and Job Cards pattern (stores_flow.js, jobs_flow.js):
//
//   Approved → Assigned → Prioritized → Ordered → Received → Priced
//
// Workshop supervisors dynamically prioritize items day to day (P1 Breakdown,
// P2 Urgent, P3 Routine, P4 Stock) with operational notes.
// Both Head Office and Local Purchase officers can reassign items bilaterally.
// ===========================================================================

const { get, all } = require('../db');
const { hasCap } = require('./auth');
const scope = require('./scope');

const PRIORITIES = ['P1_CRITICAL', 'P2_URGENT', 'P3_ROUTINE', 'P4_LOW'];
const PRIORITY_LABELS = {
  P1_CRITICAL: 'P1 Breakdown',
  P2_URGENT: 'P2 Urgent',
  P3_ROUTINE: 'P3 Routine',
  P4_LOW: 'P4 Stock',
};
const PRIORITY_BADGES = {
  P1_CRITICAL: 'red',
  P2_URGENT: 'amber',
  P3_ROUTINE: '',
  P4_LOW: 'muted',
};

const CHANNELS = ['head_office', 'local_purchase'];
const CHANNEL_LABEL = { head_office: 'Head Office', local_purchase: 'Local Purchase' };

/** Channels user may act on */
function channelsFor(user) {
  if (!user) return [];
  if (hasCap(user, 'purchasing.all_channels')) return CHANNELS.slice();
  const mine = [];
  if (hasCap(user, 'purchasing.head_office')) mine.push('head_office');
  if (hasCap(user, 'purchasing.local')) mine.push('local_purchase');
  return mine;
}
const seesBoth = (user) => channelsFor(user).length === CHANNELS.length;

const AT_BUYING_STAGE = `(m.approval_status = 'approved' OR m.purchase_requested_at IS NOT NULL)`;
const NOT_FULLY_RECEIVED = `COALESCE(l.qty_received, 0) < l.qty`;
const LIVE = `${AT_BUYING_STAGE} AND m.status <> 'cancelled'`;

const LINE_COLS = `
  l.id, l.mrn_id, l.description, l.qty, l.unit, l.qty_received, l.category,
  l.purchase_source, l.purchased_at, l.purchased_by, l.supplier, l.invoice_no,
  l.invoice_date, l.purchase_amount,
  l.source_changed_at, l.source_changed_by, l.source_changed_reason, l.source_changed_from,
  l.buying_priority, l.priority_note, l.priority_updated_at, l.priority_updated_by,
  m.mrn_no, m.req_date, m.required_date, m.requested_by, m.purpose, m.approval_status,
  m.purchase_requested_at, m.job_id, m.workshop_id,
  w.code AS workshop_code, w.name AS workshop_name,
  a.id AS asset_id, a.code AS asset_code, a.registration AS asset_reg,
  j.job_no,
  (SELECT COUNT(*) FROM mrn_line_invoices i WHERE i.mrn_line_id = l.id) AS invoice_images,
  (SELECT COUNT(*) FROM grn g WHERE g.mrn_line_id = l.id AND g.unit_price IS NULL) AS unpriced_grns`;

const LINE_FROM = `
  FROM mrn_lines l
  JOIN mrn m ON m.id = l.mrn_id
  LEFT JOIN workshops w ON w.id = m.workshop_id
  LEFT JOIN assets a ON a.id = m.asset_id
  LEFT JOIN job_cards j ON j.id = m.job_id`;

/**
 * Road milestone representation:
 *   Approved -> Assigned -> Prioritized -> Ordered -> Received -> Priced
 */
function roadOf(x) {
  const isApproved = x.approval_status === 'approved' || x.purchase_requested_at != null;
  const isAssigned = !!x.purchase_source;
  const isPrioritized = x.buying_priority === 'P1_CRITICAL' || x.buying_priority === 'P2_URGENT' || !!x.priority_updated_at;
  const isBought = !!x.purchased_at || Number(x.qty_received) > 0;
  const isReceived = Number(x.qty_received) >= Number(x.qty) - 0.001 ? 'done' : (Number(x.qty_received) > 0 ? 'part' : 'todo');
  const isPriced = Number(x.qty_received) === 0 ? 'todo' : (Number(x.unpriced_grns) > 0 ? 'now' : 'done');

  let orderState = 'todo';
  if (isBought) orderState = 'done';
  else if (isApproved && isAssigned) orderState = 'now';

  return [
    { key: 'approved', label: 'Approved', state: isApproved ? 'done' : 'now' },
    { key: 'assigned', label: isAssigned ? (CHANNEL_LABEL[x.purchase_source] || 'Assigned') : 'Assign Channel', state: isAssigned ? 'done' : 'now' },
    { key: 'priority', label: PRIORITY_LABELS[x.buying_priority] || 'Routine', state: isPrioritized ? 'done' : 'part' },
    { key: 'ordered', label: 'Ordered', state: orderState },
    { key: 'received', label: 'Received', state: isReceived },
    { key: 'priced', label: 'Priced', state: isPriced },
  ];
}

/**
 * Top Monitor Deck metrics for Procurement & Purchasing
 */
function monitor(user) {
  const mine = channelsFor(user);
  const own = scope.filter(user, 'm.workshop_id');
  const wScope = own.sql ? ` AND ${own.sql}` : '';
  const pScope = own.params;

  const count = (where, ...p) =>
    get(`SELECT COUNT(*) n ${LINE_FROM} WHERE ${LIVE} ${wScope} AND ${where}`, ...pScope, ...p).n;

  // Pipeline stages
  const unassigned = count(`l.purchase_source IS NULL AND l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED}`);
  const to_buy_ho = count(`l.purchase_source = 'head_office' AND l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED}`);
  const to_buy_local = count(`l.purchase_source = 'local_purchase' AND l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED}`);
  const ordered = count(`l.purchased_at IS NOT NULL AND ${NOT_FULLY_RECEIVED}`);
  const bought_total = count(`l.purchased_at IS NOT NULL`);
  const received_full = count(`COALESCE(l.qty_received, 0) >= l.qty`);

  // Workshop dynamic urgency counts (only for open lines awaiting purchase)
  const p1_critical = count(`l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED} AND l.buying_priority = 'P1_CRITICAL'`);
  const p2_urgent = count(`l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED} AND l.buying_priority = 'P2_URGENT'`);
  const p3_routine = count(`l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED} AND (l.buying_priority = 'P3_ROUTINE' OR l.buying_priority IS NULL)`);
  const p4_low = count(`l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED} AND l.buying_priority = 'P4_LOW'`);

  // Overdue watch
  const overdue_needed = count(`l.purchased_at IS NULL AND ${NOT_FULLY_RECEIVED} AND date(m.required_date) < date('now', 'localtime')`);
  const ordered_stale = count(`l.purchased_at IS NOT NULL AND ${NOT_FULLY_RECEIVED} AND date(l.purchased_at) < date('now', 'localtime', '-7 days')`);

  // Unpriced GRNs on purchased items
  const unpriced = get(`SELECT COUNT(*) n FROM grn g WHERE g.unit_price IS NULL AND g.mrn_line_id IS NOT NULL`).n;

  // Price discrepancy count
  const price_discrepancies = get(`
    SELECT COUNT(DISTINCT l.id) n
      FROM mrn_lines l
      JOIN grn g ON g.mrn_line_id = l.id
     WHERE l.purchase_amount IS NOT NULL
       AND g.unit_price IS NOT NULL
     GROUP BY l.id
    HAVING ABS(SUM(ROUND(g.qty * g.unit_price, 2)) - l.purchase_amount) > 0.50
  `);

  return {
    pipeline: {
      unassigned,
      to_buy_ho,
      to_buy_local,
      to_buy_total: to_buy_ho + to_buy_local,
      ordered,
      bought_total,
      received_full,
    },
    urgency: {
      p1_critical,
      p2_urgent,
      p3_routine,
      p4_low,
      urgent_total: p1_critical + p2_urgent,
    },
    watch: {
      overdue_needed,
      ordered_stale,
      unpriced,
      price_discrepancies: (price_discrepancies && price_discrepancies.n) || 0,
    },
    channels: mine,
    sees_both: seesBoth(user),
  };
}

/**
 * Filtered work queue lines query
 */
function lines(user, query = {}) {
  const mine = channelsFor(user);
  const tab = ['to_buy', 'urgent', 'unassigned', 'ordered', 'bought', 'all'].includes(query.tab)
    ? query.tab : 'to_buy';
  const limit = Math.min(Math.max(Number(query.limit) || 300, 1), 2000);

  const where = [LIVE];
  const params = [];

  // Workshop scope
  const own = scope.filter(user, 'm.workshop_id');
  if (own.sql) { where.push(own.sql); params.push(...own.params); }
  if (query.workshop_id) { where.push('m.workshop_id = ?'); params.push(Number(query.workshop_id)); }
  if (query.job_id) { where.push('m.job_id = ?'); params.push(Number(query.job_id)); }
  if (query.mrn_id) { where.push('m.id = ?'); params.push(Number(query.mrn_id)); }

  // Tabs
  if (tab === 'unassigned') {
    where.push('l.purchase_source IS NULL', NOT_FULLY_RECEIVED, 'l.purchased_at IS NULL');
  } else if (tab === 'urgent') {
    where.push("l.buying_priority IN ('P1_CRITICAL', 'P2_URGENT')", 'l.purchased_at IS NULL', NOT_FULLY_RECEIVED);
    if (query.channel && CHANNELS.includes(query.channel)) {
      where.push('l.purchase_source = ?');
      params.push(query.channel);
    }
  } else if (tab === 'ordered') {
    where.push('l.purchased_at IS NOT NULL', NOT_FULLY_RECEIVED);
    if (query.channel && CHANNELS.includes(query.channel)) {
      where.push('l.purchase_source = ?');
      params.push(query.channel);
    }
  } else if (tab === 'bought') {
    where.push('l.purchased_at IS NOT NULL');
    if (query.channel && CHANNELS.includes(query.channel)) {
      where.push('l.purchase_source = ?');
      params.push(query.channel);
    }
  } else if (tab === 'to_buy') {
    where.push('l.purchased_at IS NULL', NOT_FULLY_RECEIVED);
    if (query.channel && CHANNELS.includes(query.channel)) {
      where.push('l.purchase_source = ?');
      params.push(query.channel);
    } else if (mine.length) {
      where.push(`l.purchase_source IN (${mine.map(() => '?').join(',')})`);
      params.push(...mine);
    } else {
      where.push('1 = 0');
    }
  }

  // Priority filter override
  if (query.priority && PRIORITIES.includes(query.priority)) {
    where.push('l.buying_priority = ?');
    params.push(query.priority);
  }

  // Search text
  const q = String(query.q || '').trim();
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where.push(`(l.description LIKE ? ESCAPE '\\' OR m.mrn_no LIKE ? ESCAPE '\\'
                 OR a.code LIKE ? ESCAPE '\\' OR a.registration LIKE ? ESCAPE '\\'
                 OR l.supplier LIKE ? ESCAPE '\\' OR l.invoice_no LIKE ? ESCAPE '\\'
                 OR l.priority_note LIKE ? ESCAPE '\\' OR j.job_no LIKE ? ESCAPE '\\')`);
    for (let i = 0; i < 8; i++) params.push(like);
  }

  // Sorting: Workshop Priority FIRST, then Needed Date, then Requisition Date
  let order;
  if (tab === 'bought') {
    order = 'datetime(l.purchased_at) DESC, l.id DESC';
  } else {
    order = `
      CASE l.buying_priority
        WHEN 'P1_CRITICAL' THEN 1
        WHEN 'P2_URGENT' THEN 2
        WHEN 'P3_ROUTINE' THEN 3
        WHEN 'P4_LOW' THEN 4
        ELSE 3
      END ASC,
      date(m.required_date) IS NULL, date(m.required_date) ASC,
      date(m.req_date) ASC,
      l.id ASC`;
  }

  const rows = all(
    `SELECT ${LINE_COLS} ${LINE_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
    ...params
  );

  // Mark seen
  const mark = get('SELECT seen_at FROM user_seen_marks WHERE user_id = ? AND key = ?', user.id, 'purchasing');
  const since = mark ? mark.seen_at : null;

  for (const r of rows) {
    r.is_new = since ? String(r.req_date || '') > String(since).slice(0, 10) : true;
    r.priority_label = PRIORITY_LABELS[r.buying_priority] || 'P3 Routine';
    r.priority_badge = PRIORITY_BADGES[r.buying_priority] || '';
    r.road = roadOf(r);
  }

  return {
    rows,
    channels: mine,
    tab,
    sees_both: seesBoth(user),
    seen_at: since,
  };
}

module.exports = {
  PRIORITIES,
  PRIORITY_LABELS,
  PRIORITY_BADGES,
  CHANNELS,
  CHANNEL_LABEL,
  channelsFor,
  seesBoth,
  roadOf,
  monitor,
  lines,
};
