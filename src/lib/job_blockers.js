'use strict';

/**
 * Job Card Closure Blocker Engine (Stage C — Pillar 1)
 *
 * Computes filterable blocker badges across open/partially-closed job cards:
 *   - missing_part_price
 *   - pending_grn
 *   - unissued_shelf
 *   - no_daily_work
 *   - awaiting_signoff
 *   - missing_labour_rate
 *   - ready_to_close
 */

const { get, all } = require('../db');
const scope = require('./scope');
const review = require('./job_review');
const costing = require('./costing');
const closeLib = require('./job_close');
const jobstate = require('./jobstate');
const mechanics = require('./mechanics');

const BLOCKER_META = {
  missing_part_price: { label: 'Missing Part Price', tone: 'red' },
  pending_grn: { label: 'Pending GRN', tone: 'amber' },
  unissued_shelf: { label: 'Unissued Shelf Parts', tone: 'amber' },
  no_daily_work: { label: 'No Daily Work', tone: 'amber' },
  awaiting_signoff: { label: 'Awaiting Sign-Off', tone: 'blue' },
  missing_labour_rate: { label: 'Missing Labour Rate / Ext Value', tone: 'red' },
  ready_to_close: { label: 'Ready to Close', tone: 'green' },
};

const BLOCKER_KINDS = Object.keys(BLOCKER_META);

const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const day10 = (v) => (v ? String(v).slice(0, 10) : null);
const daysSince = (d, now = todayISO()) => (d ? Math.max(0, Math.round((Date.parse(now) - Date.parse(day10(d))) / 86400000)) : 0);

function hasTable(name) {
  return !!get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

function chunkIds(ids, size = 300) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function addCount(map, jobId, kind, n = 1) {
  if (!jobId || n <= 0) return;
  let obj = map.get(jobId);
  if (!obj) {
    obj = {};
    map.set(jobId, obj);
  }
  obj[kind] = (obj[kind] || 0) + n;
}

/**
 * Computes blocker arrays for a list of job_card rows in batched SQL queries.
 * Returns a Map<jobId, { blockers: Array, ready: boolean }>.
 */
function computeBlockersMap(cards) {
  const result = new Map();
  if (!Array.isArray(cards) || !cards.length) return result;

  const activeCards = cards.filter((c) => c && c.id && !jobstate.isFinal(c.status));
  if (!activeCards.length) return result;

  const ids = [...new Set(activeCards.map((c) => Number(c.id)).filter(Boolean))];
  const countsMap = new Map();
  const dwTotalMap = new Map();
  const reopenPendingSet = new Set();

  const hasDiscTable = hasTable('delivery_discrepancies');
  const hasGenTable = hasTable('general_item_txns');
  const hasReopenTable = hasTable('job_reopen_requests');

  // Preload distinct mechanics present in labour_rates so we skip expensive per-row queries
  const ratedMechanics = new Set(
    all('SELECT DISTINCT mechanic FROM labour_rates WHERE mechanic IS NOT NULL').map((r) => r.mechanic)
  );

  for (const batch of chunkIds(ids, 300)) {
    const marks = batch.map(() => '?').join(',');

    // 1a. Missing part price: job_parts with NULL or <= 0 unit_price
    for (const r of all(
      `SELECT job_id, COUNT(*) AS c
         FROM job_parts
        WHERE job_id IN (${marks}) AND (unit_price IS NULL OR unit_price <= 0)
        GROUP BY job_id`,
      ...batch
    )) {
      addCount(countsMap, r.job_id, 'missing_part_price', r.c);
    }

    // 1b. General item txns missing price
    if (hasGenTable) {
      for (const r of all(
        `SELECT job_id, COUNT(*) AS c
           FROM general_item_txns
          WHERE job_id IN (${marks}) AND txn_type = 'issue' AND (unit_price IS NULL OR unit_price <= 0)
          GROUP BY job_id`,
        ...batch
      )) {
        addCount(countsMap, r.job_id, 'missing_part_price', r.c);
      }
    }

    // 1c. Oil ledger issues missing explicit price (check price history fallback)
    for (const l of all(
      `SELECT job_id, product_id, txn_date
         FROM stock_ledger
        WHERE job_id IN (${marks}) AND kind = 'issue' AND unit_price IS NULL`,
      ...batch
    )) {
      const p = costing.productPriceOn(l.product_id, l.txn_date);
      if (p == null || p <= 0) {
        addCount(countsMap, l.job_id, 'missing_part_price', 1);
      }
    }

    // 2. Pending GRN: unreceived non-cancelled MRN lines (unless settled discrepancy covers shortfall)
    const pendingMrnSql = hasDiscTable
      ? `SELECT m.job_id, ml.qty, ml.qty_received, ml.qty_short,
                (SELECT d.status FROM delivery_discrepancies d WHERE d.mrn_line_id = ml.id ORDER BY d.id DESC LIMIT 1) AS disc_status
           FROM mrn_lines ml
           JOIN mrn m ON m.id = ml.mrn_id
          WHERE m.job_id IN (${marks})
            AND COALESCE(ml.is_cancelled, 0) = 0
            AND COALESCE(ml.qty_received, 0) < COALESCE(ml.qty, 0)`
      : `SELECT m.job_id, ml.qty, ml.qty_received, ml.qty_short, NULL AS disc_status
           FROM mrn_lines ml
           JOIN mrn m ON m.id = ml.mrn_id
          WHERE m.job_id IN (${marks})
            AND COALESCE(ml.is_cancelled, 0) = 0
            AND COALESCE(ml.qty_received, 0) < COALESCE(ml.qty, 0)`;

    for (const ml of all(pendingMrnSql, ...batch)) {
      const settled = ml.disc_status && ['resolved', 'written_off'].includes(ml.disc_status)
        && ((ml.qty_received || 0) + (ml.qty_short || 0)) >= (ml.qty || 0);
      if (!settled) addCount(countsMap, ml.job_id, 'pending_grn', 1);
    }

    if (hasDiscTable) {
      for (const d of all(
        `SELECT m.job_id, COUNT(*) AS c
           FROM delivery_discrepancies d
           JOIN mrn m ON m.id = d.mrn_id
          WHERE m.job_id IN (${marks}) AND d.status IN ('open', 'investigating')
          GROUP BY m.job_id`,
        ...batch
      )) {
        addCount(countsMap, d.job_id, 'pending_grn', d.c);
      }
    }

    // 3. Unissued shelf parts: delivered GRNs against job MRN not yet issued
    for (const g of all(
      `SELECT m.job_id, COUNT(*) AS c
         FROM grn g
         JOIN mrn m ON m.id = g.mrn_id
        WHERE m.job_id IN (${marks})
          AND (g.qty - COALESCE((SELECT SUM(i.qty) FROM issues i WHERE i.grn_id = g.id), 0)) > 0.001
        GROUP BY m.job_id`,
      ...batch
    )) {
      addCount(countsMap, g.job_id, 'unissued_shelf', g.c);
    }

    // 4 & 6. Daily work presence, external values & mechanic labour rates
    for (const w of all(
      `SELECT job_id, mechanic, work_date, is_external, external_value
         FROM job_daily_work
        WHERE job_id IN (${marks})`,
      ...batch
    )) {
      dwTotalMap.set(w.job_id, (dwTotalMap.get(w.job_id) || 0) + 1);
      if (w.is_external) {
        if (w.external_value == null || w.external_value === '') {
          addCount(countsMap, w.job_id, 'missing_labour_rate', 1);
        }
      } else {
        const names = mechanics.splitMechanics(w.mechanic);
        if (!names.length) {
          addCount(countsMap, w.job_id, 'missing_labour_rate', 1);
        } else {
          for (const nm of names) {
            const resolved = mechanics.resolveMechanicName(nm);
            if (!ratedMechanics.has(resolved) && costing.labourRateFor(nm, w.work_date) == null) {
              addCount(countsMap, w.job_id, 'missing_labour_rate', 1);
            }
          }
        }
      }
    }

    // 5. Pending reopen requests
    if (hasReopenTable) {
      for (const r of all(
        `SELECT DISTINCT job_id
           FROM job_reopen_requests
          WHERE job_id IN (${marks}) AND status = 'pending'`,
        ...batch
      )) {
        reopenPendingSet.add(r.job_id);
      }
    }
  }

  for (const card of activeCards) {
    const raw = countsMap.get(card.id) || {};
    if (card.type === 'service') {
      if (card.flat_labour == null) raw.no_daily_work = (raw.no_daily_work || 0) + 1;
    } else {
      if ((dwTotalMap.get(card.id) || 0) === 0) raw.no_daily_work = (raw.no_daily_work || 0) + 1;
    }

    if (['REQUESTED', 'APPROVED_TRANSPORT', 'APPROVED_OPERATIONS'].includes(card.status) || reopenPendingSet.has(card.id)) {
      raw.awaiting_signoff = (raw.awaiting_signoff || 0) + 1;
    }

    const blockers = [];
    for (const kind of ['missing_part_price', 'pending_grn', 'unissued_shelf', 'no_daily_work', 'awaiting_signoff', 'missing_labour_rate']) {
      if (raw[kind] > 0) {
        blockers.push({
          kind,
          label: BLOCKER_META[kind].label,
          tone: BLOCKER_META[kind].tone,
          count: raw[kind],
        });
      }
    }

    let ready = false;
    if (['WORK_COMPLETE', 'PARTIALLY_CLOSED'].includes(card.status) && blockers.length === 0) {
      const chk = closeLib.closeCheck(card);
      if (chk && chk.ok) {
        ready = true;
        blockers.push({
          kind: 'ready_to_close',
          label: BLOCKER_META.ready_to_close.label,
          tone: BLOCKER_META.ready_to_close.tone,
          count: 1,
        });
      }
    }

    result.set(card.id, { blockers, ready });
  }

  return result;
}

/**
 * Mutates an array of job card objects (from GET /api/jobs) to include
 * `blockers` and `ready_to_close` on open cards.
 */
function attachBlockersToCards(cards) {
  if (!Array.isArray(cards) || !cards.length) return cards;
  const map = computeBlockersMap(cards);
  for (const c of cards) {
    const entry = map.get(c.id);
    c.blockers = entry ? entry.blockers : [];
    c.ready_to_close = entry ? entry.ready : false;
  }
  return cards;
}

/**
 * Full Job Card Closure Blocker dashboard dataset.
 */
function getBlockerSummary(user, query = {}) {
  const includeHist = query.include_historical === '0' ? false : true;
  const clauses = [
    jobstate.notFinalSql('j'),
    `NOT ${review.CONTAINER_SQL}`,
  ];
  const params = [];

  if (!includeHist) {
    clauses.push('COALESCE(j.is_historical, 0) = 0');
  }

  const own = scope.readFilter(user, 'j.workshop_id', 'job');
  if (own.sql) {
    clauses.push(own.sql);
    params.push(...own.params);
  }

  const fab = scope.fabricationClause(user, 'j');
  if (fab) clauses.push(fab);

  if (query.workshop_id) {
    clauses.push('j.workshop_id = ?');
    params.push(Number(query.workshop_id));
  }
  if (query.status) {
    clauses.push('j.status = ?');
    params.push(String(query.status).trim());
  }
  if (query.type) {
    clauses.push('j.type = ?');
    params.push(String(query.type).trim());
  }
  if (query.q && String(query.q).trim()) {
    const like = `%${String(query.q).trim()}%`;
    clauses.push('(j.job_no LIKE ? OR j.description LIKE ? OR a.code LIKE ? OR a.registration LIKE ? OR a.ec_code LIKE ?)');
    params.push(like, like, like, like, like);
  }

  const rawRows = all(
    `SELECT j.id, j.job_no, j.type, j.severity, j.status, j.description,
            j.requested_at, j.partial_closed_at, j.completed_at, j.flat_labour,
            j.is_historical, j.total_cost, j.workshop_id, w.code AS workshop_code, w.name AS workshop_name,
            j.asset_id, a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
            p.name AS project_name
       FROM job_cards j
       LEFT JOIN assets a ON a.id = j.asset_id
       LEFT JOIN projects p ON p.id = j.project_id
       LEFT JOIN workshops w ON w.id = j.workshop_id
      WHERE ${clauses.join(' AND ')}`,
    ...params
  );

  const blockersMap = computeBlockersMap(rawRows);
  const now = todayISO();
  const mayClose = !!jobstate.checkTransition('WORK_COMPLETE', 'CLOSED', user).ok;

  const counts = { all: 0 };
  for (const k of BLOCKER_KINDS) counts[k] = 0;

  const byStatus = {};
  let totalBlocked = 0;
  let totalReady = 0;

  const shaped = rawRows.map((r) => {
    const info = blockersMap.get(r.id) || { blockers: [], ready: false };
    const blockers = info.blockers;
    const ready = info.ready;

    counts.all += 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (ready) totalReady += 1;
    else if (blockers.length > 0) totalBlocked += 1;

    for (const b of blockers) {
      counts[b.kind] = (counts[b.kind] || 0) + 1;
    }

    const since = day10(r.status === jobstate.PARTIAL ? (r.partial_closed_at || r.completed_at || r.requested_at) : r.requested_at);
    return {
      id: r.id,
      job_no: r.job_no,
      type: r.type,
      severity: r.severity,
      status: r.status,
      description: r.description,
      is_historical: !!r.is_historical,
      workshop_id: r.workshop_id,
      workshop_code: r.workshop_code,
      workshop_name: r.workshop_name,
      asset_id: r.asset_id,
      asset_code: r.asset_code,
      asset_reg: r.asset_reg,
      asset_ec: r.asset_ec,
      project_name: r.project_name,
      total_cost: Number(r.total_cost || 0),
      requested_at: day10(r.requested_at),
      since,
      days_open: daysSince(since, now),
      blockers,
      blocker_count: ready ? 0 : blockers.length,
      ready_to_close: ready,
      link: `#/jobs/${r.id}`,
      can: {
        close: ready && mayClose && !scope.isReadOnly(user, r.workshop_id),
      },
    };
  });

  // Pending job requests waiting for action
  let pendingJobRequests = 0;
  try {
    const jrOwn = scope.filter(user, 'workshop_id', { store: false });
    const jrFab = scope.fabricationFilter(user, '');
    pendingJobRequests = get(
      `SELECT COUNT(*) AS c
         FROM job_requests
        WHERE (approval_status IN ('requested', 'certified') OR (approval_status = 'approved' AND job_id IS NULL AND service_id IS NULL))
          ${jrOwn.sql ? 'AND ' + jrOwn.sql : ''}
          ${jrFab}`,
      ...jrOwn.params
    ).c;
  } catch (_) {}

  const wantBlocker = BLOCKER_KINDS.includes(query.blocker) ? query.blocker : 'all';
  const filtered = shaped
    .filter((r) => wantBlocker === 'all' || r.blockers.some((b) => b.kind === wantBlocker))
    .sort((a, b) => {
      const aPri = a.status === 'PARTIALLY_CLOSED' || a.status === 'WORK_COMPLETE' ? 0 : 1;
      const bPri = b.status === 'PARTIALLY_CLOSED' || b.status === 'WORK_COMPLETE' ? 0 : 1;
      return (aPri - bPri) || (b.days_open - a.days_open) || (b.blocker_count - a.blocker_count) || (b.id - a.id);
    });

  const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 5000);

  return {
    counts,
    by_status: byStatus,
    total_open: rawRows.length,
    total_blocked: totalBlocked,
    total_ready: totalReady,
    pending_job_requests: pendingJobRequests,
    rows: filtered.slice(0, limit),
  };
}

module.exports = {
  BLOCKER_KINDS,
  BLOCKER_META,
  attachBlockersToCards,
  getBlockerSummary,
};
