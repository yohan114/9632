'use strict';

// ===========================================================================
// WorkshopOne Enterprise Real-Time Privilege/Permission-Scoped Notification Engine
//
// Computes live actionable items (certifications, approvals, store transfers,
// dual-authorization 4-eyes requests, workday sign-offs) and recent workflow
// status transitions (certified, approved, rejected, dispatched, received)
// strictly scoped to the signed-in user's capabilities, module access,
// financial approval limits, and workshop reach.
// ===========================================================================

const { get, all, run, tx } = require('../db');
const { hasCap } = require('./auth');
const permissions = require('./permissions');
const scope = require('./scope');
const limits = require('./approval_limits');
const dualAuth = require('./dual_auth');
const attendance = require('./attendance');
const jobstate = require('./jobstate');
const jobClose = require('./job_close');
const jobsFlow = require('./jobs_flow');
const purchasingFlow = require('./purchasing_flow');

function ensureNotificationTable() {
  try {
    const d = require('../db').db;
    d.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_reads (
        user_id   INTEGER NOT NULL,
        notif_key TEXT NOT NULL,
        read_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, notif_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_notif_reads_user ON user_notification_reads(user_id);
    `);
  } catch (e) {
    // ignore if db not ready yet
  }
}

ensureNotificationTable();

function slFormat(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(s);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

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

/**
 * Map audit_log entity to module permission & deep link
 */
function resolveAuditTarget(entity, entityId, action) {
  const e = String(entity || '').toLowerCase();
  if (e === 'mrn' || e === 'mrn_lines') {
    return { mod: 'stores', link: entityId ? `#/stores?tab=mrn&id=${entityId}` : '#/stores?tab=mrn', label: 'MRN' };
  }
  if (e === 'grn' || e === 'grn_vouchers') {
    return { mod: 'stores', link: '#/stores?tab=flow&sub=grn', label: 'GRN' };
  }
  if (e === 'issues' || e === 'min_notes') {
    return { mod: 'stores', link: '#/stores?tab=flow&sub=issues', label: 'Issue Note (MIN)' };
  }
  if (e === 'mtn') {
    return { mod: 'stores', link: entityId ? `#/stores?tab=mtn&id=${entityId}` : '#/stores?tab=mtn', label: 'Transfer (MTN)' };
  }
  if (e === 'job_requests' || e === 'job_request') {
    return { mod: 'jobrequests', link: entityId ? `#/jobrequests/${entityId}` : '#/jobrequests', label: 'Job Request' };
  }
  if (e === 'job_cards' || e === 'job_card' || e === 'jobs') {
    return { mod: 'jobs', link: entityId ? `#/jobs/${entityId}` : '#/jobs', label: 'Job Card' };
  }
  if (e === 'count_sessions' || e === 'stock_count') {
    return { mod: 'stores', link: '#/stores?tab=counts', label: 'Stock Take' };
  }
  if (e === 'disposals' || e === 'disposal') {
    return { mod: 'stores', link: '#/stores?tab=disposals', label: 'Disposal' };
  }
  if (e === 'tb_requests' || e === 'tyres' || e === 'batteries') {
    return { mod: 'tb_requests', link: '#/tbrequests', label: 'Tyre / Battery' };
  }
  if (e === 'attendance' || e === 'job_daily_work') {
    return { mod: 'dailywork', link: '#/dailywork', label: 'Daily Work / Attendance' };
  }
  return { mod: null, link: '#/dashboard', label: entity || 'System' };
}

/**
 * Compute all notifications scoped to the signed-in user's privileges.
 */
function getNotificationsForUser(user) {
  ensureNotificationTable();
  if (!user || !user.id) {
    return { total_unread: 0, total_actionable: 0, counts: {}, items: [], authorities: [] };
  }

  const may = (cap) => hasCap(user, cap);
  const canMod = (m) => permissions.reaches(user, m);
  const rReach = scope.reach(user);

  const readRows = all('SELECT notif_key FROM user_notification_reads WHERE user_id = ?', user.id);
  const readSet = new Set(readRows.map((r) => r.notif_key));

  const jOwn = scope.filter(user, 'j.workshop_id');
  const mOwn = scope.filter(user, 'm.workshop_id');
  const rOwn = scope.filter(user, 'r.workshop_id', { store: false });
  const and = (f) => (f && f.sql ? ` AND ${f.sql}` : '');

  const items = [];
  const pushItem = (item) => {
    const key = item.key;
    const isRead = readSet.has(key);
    items.push({
      ...item,
      unread: !isRead,
    });
  };

  // =========================================================================
  // 1. CERTIFICATIONS (Pending User's Certification Signature)
  // =========================================================================
  if (may('jobrequests.certify')) {
    const jrs = all(`
      SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.description, r.created_at,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
       WHERE r.approval_status = 'requested'${and(rOwn)}
       ORDER BY r.id DESC LIMIT 25`, ...(rOwn.params || []));
    for (const r of jrs) {
      const veh = [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `cert:jr:${r.id}`,
        category: 'certifications',
        kind: 'jr_certify',
        badge: 'CERTIFY',
        badge_color: 'blue',
        priority: 'high',
        ref: r.jr_no || `JR-${r.id}`,
        title: `Certify Job Request ${r.jr_no || '#' + r.id}`,
        subtitle: veh ? `${veh} — ${r.description || 'No description'}` : (r.description || 'Job request awaiting certification'),
        meta: `Requested by ${r.requested_by || 'Staff'} · ${r.req_date || ''}`,
        timestamp: r.created_at || r.req_date || '',
        link: `#/jobrequests/${r.id}`,
        action_label: 'Certify JR',
        capability: 'jobrequests.certify',
      });
    }
  }

  if (may('stores.mrn.certify')) {
    const INFLOW_MRN = "m.approval_status = 'requested' AND m.requested_by IS NOT NULL AND TRIM(m.requested_by) <> ''";
    const mrns = all(`
      SELECT m.id, m.mrn_no, m.req_date, m.requested_by, m.purpose,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
             (SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS lines
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id
       WHERE ${INFLOW_MRN}${and(mOwn)}
       ORDER BY m.req_date DESC, m.id DESC LIMIT 25`, ...(mOwn.params || []));
    for (const m of mrns) {
      const veh = [m.asset_reg, m.asset_ec, m.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `cert:mrn:${m.id}`,
        category: 'certifications',
        kind: 'mrn_certify',
        badge: 'CERTIFY MRN',
        badge_color: 'blue',
        priority: 'high',
        ref: m.mrn_no || `MRN-${m.id}`,
        title: `Certify MRN ${m.mrn_no}`,
        subtitle: `${veh ? veh + ' · ' : ''}${m.lines || 0} item(s)${m.purpose ? ' — ' + m.purpose : ''}`,
        meta: `Requested by ${m.requested_by || 'Workshop'} · ${m.req_date || ''}`,
        timestamp: m.req_date || '',
        link: `#/stores?tab=mrn&id=${m.id}`,
        action_label: 'Certify MRN',
        capability: 'stores.mrn.certify',
      });
    }
  }

  // =========================================================================
  // 2. APPROVALS & AUTHORIZATIONS (Pending User's Approval Decision)
  // =========================================================================
  if (may('jobrequests.approve')) {
    const jrs = all(`
      SELECT r.id, r.jr_no, r.req_date, r.requested_by, r.certified_by, r.certified_at, r.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
       WHERE r.approval_status = 'certified'${and(rOwn)}
       ORDER BY r.id DESC LIMIT 25`, ...(rOwn.params || []));
    for (const r of jrs) {
      const veh = [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `appr:jr:${r.id}`,
        category: 'approvals',
        kind: 'jr_approve',
        badge: 'APPROVE JR',
        badge_color: 'green',
        priority: 'high',
        ref: r.jr_no || `JR-${r.id}`,
        title: `Approve Certified Job Request ${r.jr_no}`,
        subtitle: `${veh ? veh + ' — ' : ''}${r.description || ''}`,
        meta: `Certified by ${r.certified_by || 'Engineer'} · Req: ${r.requested_by || 'Staff'}`,
        timestamp: r.certified_at || r.req_date || '',
        link: `#/jobrequests/${r.id}`,
        action_label: 'Approve JR',
        capability: 'jobrequests.approve',
      });
    }
  }

  if (may('jobs.approve_transport')) {
    const jc = all(`
      SELECT j.id, j.job_no, j.requested_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
       WHERE j.status = 'REQUESTED' AND j.approved_transport_at IS NULL AND j.is_historical = 0${and(jOwn)}
       ORDER BY j.id DESC LIMIT 20`, ...(jOwn.params || []));
    for (const j of jc) {
      const veh = [j.asset_reg, j.asset_ec, j.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `appr:job_tr:${j.id}`,
        category: 'approvals',
        kind: 'job_transport',
        badge: 'TRANSPORT SIGN',
        badge_color: 'amber',
        priority: 'high',
        ref: j.job_no,
        title: `Transport Approval: Job ${j.job_no}`,
        subtitle: `${veh ? veh + ' — ' : ''}${j.description || ''}`,
        meta: `Requested ${String(j.requested_at || '').slice(0, 10)}`,
        timestamp: j.requested_at || '',
        link: `#/jobs/${j.id}`,
        action_label: 'Transport Sign',
        capability: 'jobs.approve_transport',
      });
    }
  }

  if (may('jobs.approve_operations')) {
    const jc = all(`
      SELECT j.id, j.job_no, j.requested_at, j.approved_transport_at, j.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
       WHERE j.approved_transport_at IS NOT NULL AND j.approved_ops_at IS NULL AND j.is_historical = 0${and(jOwn)}
       ORDER BY j.id DESC LIMIT 20`, ...(jOwn.params || []));
    for (const j of jc) {
      const veh = [j.asset_reg, j.asset_ec, j.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `appr:job_ops:${j.id}`,
        category: 'approvals',
        kind: 'job_ops',
        badge: 'OPS APPROVE',
        badge_color: 'green',
        priority: 'high',
        ref: j.job_no,
        title: `Operations Approval: Job ${j.job_no}`,
        subtitle: `${veh ? veh + ' — ' : ''}${j.description || ''}`,
        meta: `Transport signed ${String(j.approved_transport_at || '').slice(0, 10)}`,
        timestamp: j.approved_transport_at || j.requested_at || '',
        link: `#/jobs/${j.id}`,
        action_label: 'Ops Approve',
        capability: 'jobs.approve_operations',
      });
    }
  }

  if (may('stores.mrn.approve')) {
    const mrns = all(`
      SELECT m.id, m.mrn_no, m.req_date, m.requested_by, m.certified_by, m.certified_at, m.purpose,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec,
             (SELECT COUNT(*) FROM mrn_lines ml WHERE ml.mrn_id = m.id) AS lines
        FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id
       WHERE m.approval_status = 'certified'${and(mOwn)}
       ORDER BY m.certified_at DESC, m.id DESC LIMIT 25`, ...(mOwn.params || []));
    for (const m of mrns) {
      const worth = limits.mrnValue(m.id);
      const within = limits.check(user, 'mrn_approve', worth.value);
      const veh = [m.asset_reg, m.asset_ec, m.asset_code].filter(Boolean).join(' · ');
      const valStr = worth.value > 0 ? ` · Est. Rs ${Number(worth.value).toLocaleString()}` : '';
      pushItem({
        key: `appr:mrn:${m.id}`,
        category: 'approvals',
        kind: 'mrn_approve',
        badge: within.ok ? 'APPROVE MRN' : 'OVER LIMIT',
        badge_color: within.ok ? 'green' : 'amber',
        priority: within.ok ? 'high' : 'normal',
        ref: m.mrn_no,
        title: `Approve Certified MRN ${m.mrn_no}`,
        subtitle: `${veh ? veh + ' · ' : ''}${m.lines || 0} item(s)${valStr}`,
        meta: `Certified by ${m.certified_by || 'Engineer'}${!within.ok ? ` · Needs ${within.who_can || 'higher limit'}` : ''}`,
        timestamp: m.certified_at || m.req_date || '',
        link: `#/stores?tab=mrn&id=${m.id}`,
        action_label: within.ok ? 'Approve MRN' : 'View MRN',
        capability: 'stores.mrn.approve',
        over_limit: !within.ok,
      });
    }
  }

  if (may('stores.grn.approve')) {
    try {
      const pendingGrns = all(`
        SELECT v.id, v.grn_no, v.received_date, v.supplier, sl.name AS store_name,
               (SELECT COUNT(*) FROM grn g WHERE g.voucher_id = v.id OR g.grn_no = v.grn_no) AS lines
          FROM grn_vouchers v LEFT JOIN store_locations sl ON sl.id = v.physical_store_id
         WHERE v.status = 'pending_approval'
         ORDER BY v.id DESC LIMIT 20`);
      for (const v of pendingGrns) {
        pushItem({
          key: `appr:grn:${v.id}`,
          category: 'approvals',
          kind: 'grn_approve',
          badge: 'APPROVE GRN',
          badge_color: 'green',
          priority: 'high',
          ref: v.grn_no,
          title: `Approve GRN Voucher ${v.grn_no}`,
          subtitle: `${v.store_name || 'Main Store'} · ${v.lines || 1} item(s) from ${v.supplier || 'Supplier'}`,
          meta: `Received ${v.received_date || ''}`,
          timestamp: v.received_date || '',
          link: `#/stores?tab=flow&sub=grn&id=${v.id}`,
          action_label: 'Approve GRN',
          capability: 'stores.grn.approve',
        });
      }
    } catch (e) { /* table optional */ }
  }

  if (may('stores.min.approve')) {
    try {
      const pendingMins = all(`
        SELECT n.id, n.min_no, n.issue_date, n.purpose, n.requested_by,
               a.code AS asset_code, a.registration AS asset_reg,
               (SELECT COUNT(*) FROM issues i WHERE i.min_id = n.id OR i.min_no = n.min_no) AS lines
          FROM min_notes n LEFT JOIN assets a ON a.id = n.asset_id
         WHERE n.status = 'requested'
         ORDER BY n.id DESC LIMIT 20`);
      for (const n of pendingMins) {
        const veh = [n.asset_reg, n.asset_code].filter(Boolean).join(' · ') || 'General Issue';
        pushItem({
          key: `appr:min:${n.id}`,
          category: 'approvals',
          kind: 'min_approve',
          badge: 'APPROVE MIN',
          badge_color: 'green',
          priority: 'high',
          ref: n.min_no,
          title: `Approve Issue Note ${n.min_no}`,
          subtitle: `${veh} · ${n.lines || 1} item(s)${n.purpose ? ' — ' + n.purpose : ''}`,
          meta: `Requested by ${n.requested_by || 'Workshop'} · ${n.issue_date || ''}`,
          timestamp: n.issue_date || '',
          link: `#/stores?tab=flow&sub=issues&min=${n.id}`,
          action_label: 'Approve MIN',
          capability: 'stores.min.approve',
        });
      }
    } catch (e) { /* table optional */ }
  }

  if (may('stores.mtn.approve')) {
    try {
      const pendingMtns = all(`
        SELECT t.id, t.mtn_no, t.txn_date, t.description, t.from_location, t.to_location,
               fl.name AS from_store_name, tl.name AS to_store_name
          FROM mtn t
          LEFT JOIN store_locations fl ON fl.id = t.from_store_location_id
          LEFT JOIN store_locations tl ON tl.id = t.to_store_location_id
         WHERE t.status IN ('draft', 'pending_approval')
         ORDER BY t.id DESC LIMIT 20`);
      for (const t of pendingMtns) {
        const route = `${t.from_store_name || t.from_location || 'Origin'} → ${t.to_store_name || t.to_location || 'Site Store'}`;
        pushItem({
          key: `appr:mtn:${t.id}`,
          category: 'approvals',
          kind: 'mtn_approve',
          badge: 'APPROVE MTN',
          badge_color: 'green',
          priority: 'high',
          ref: t.mtn_no,
          title: `Approve Store Transfer ${t.mtn_no}`,
          subtitle: `${route}${t.description ? ' — ' + t.description : ''}`,
          meta: `Date: ${t.txn_date || ''}`,
          timestamp: t.txn_date || '',
          link: `#/stores?tab=mtn&id=${t.id}`,
          action_label: 'Approve MTN',
          capability: 'stores.mtn.approve',
        });
      }
    } catch (e) { /* table optional */ }
  }

  if (may('stores.count.approve')) {
    try {
      const submittedSessions = all(`
        SELECT s.id, s.count_no, s.scope, s.kind, s.started_at, w.name AS store_name
          FROM count_sessions s LEFT JOIN workshops w ON w.id = s.store_id
         WHERE s.status = 'submitted'
         ORDER BY s.id DESC LIMIT 15`);
      for (const s of submittedSessions) {
        pushItem({
          key: `appr:count:${s.id}`,
          category: 'approvals',
          kind: 'stock_take',
          badge: 'STOCK TAKE',
          badge_color: 'amber',
          priority: 'high',
          ref: s.count_no || `#${s.id}`,
          title: `Approve Stock Take ${s.count_no || '#' + s.id}`,
          subtitle: `${s.store_name || 'Store'} · ${s.scope || ''} (${s.kind || 'count'})`,
          meta: `Submitted ${String(s.started_at || '').slice(0, 10)}`,
          timestamp: s.started_at || '',
          link: `#/stores?tab=counts&id=${s.id}`,
          action_label: 'Review Count',
          capability: 'stores.count.approve',
        });
      }
    } catch (e) {}
  }

  if (may('stores.disposal.approve')) {
    try {
      const openDisposals = all(`
        SELECT d.id, d.disposal_no, d.created_at, w.name AS store_name,
               (SELECT COUNT(*) FROM disposal_lines l WHERE l.disposal_id = d.id) AS lines
          FROM disposals d LEFT JOIN workshops w ON w.id = d.store_id
         WHERE d.status = 'open'
         ORDER BY d.id DESC LIMIT 15`);
      for (const d of openDisposals) {
        pushItem({
          key: `appr:disp:${d.id}`,
          category: 'approvals',
          kind: 'disposal',
          badge: 'DISPOSAL',
          badge_color: 'red',
          priority: 'high',
          ref: d.disposal_no,
          title: `Approve Disposal ${d.disposal_no}`,
          subtitle: `${d.store_name || 'Store'} · ${d.lines || 0} item(s) for write-off/disposal`,
          meta: `Created ${String(d.created_at || '').slice(0, 10)}`,
          timestamp: d.created_at || '',
          link: `#/stores?tab=disposals&id=${d.id}`,
          action_label: 'Review Disposal',
          capability: 'stores.disposal.approve',
        });
      }
    } catch (e) {}
  }

  if (may('jobs.reopen') && jobstate.partialCloseEnabled()) {
    try {
      const adminRole = (user.roles || []).includes('admin');
      const reopenReqs = jobClose.pendingRequests({ excludeRequester: adminRole ? null : user.id, workshopId: rReach });
      for (const r of reopenReqs) {
        const veh = [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · ');
        pushItem({
          key: `appr:reopen:${r.id}`,
          category: 'approvals',
          kind: 'reopen',
          badge: 'REOPEN JOB',
          badge_color: 'amber',
          priority: 'high',
          ref: r.job_no,
          title: `Reopen Request: Job ${r.job_no}`,
          subtitle: `${veh ? veh + ' — ' : ''}${r.reason || ''}`,
          meta: `Requested by ${r.requested_by_name || 'Staff'}`,
          timestamp: r.requested_at || '',
          link: `#/jobs/${r.job_id}`,
          action_label: 'Decide',
          capability: 'jobs.reopen',
        });
      }
    } catch (e) {}
  }

  // Dual-Authorization (4-Eyes) Pending Requests
  try {
    const dualList = dualAuth.listPendingDualAuth(user) || [];
    for (const d of dualList) {
      pushItem({
        key: `dual:${d.id}`,
        category: 'approvals',
        kind: 'dual_auth',
        badge: '4-EYES AUTH',
        badge_color: d.can_approve ? 'red' : 'gray',
        priority: d.can_approve ? 'urgent' : 'normal',
        ref: `${d.entity_type}#${d.entity_id}`,
        title: `4-Eyes Co-Sign: ${String(d.operation_type || '').replace(/_/g, ' ').toUpperCase()}`,
        subtitle: `${d.reason || 'Requires second manager authorization'}${d.financial_delta ? ' · Rs ' + Number(d.financial_delta).toLocaleString() : ''}`,
        meta: `Requested by ${d.requester_name || d.requester_username || 'User'}`,
        timestamp: d.requested_at || '',
        link: '__DUAL_AUTH_MODAL__',
        action_label: d.can_approve ? 'Co-Sign / Review' : 'Awaiting 2nd Signer',
        capability: 'dual_auth',
      });
    }
  } catch (e) {}

  // =========================================================================
  // 3. TRANSFERS & OPERATIONS (In-Transit MTNs, Open Job Card Queue, Sign-offs)
  // =========================================================================
  if (may('stores.mtn.edit') || may('stores.grn.receive')) {
    try {
      const inTransitMtns = all(`
        SELECT t.id, t.mtn_no, t.txn_date, t.status, t.description, t.from_location, t.to_location,
               fl.name AS from_store_name, tl.name AS to_store_name
          FROM mtn t
          LEFT JOIN store_locations fl ON fl.id = t.from_store_location_id
          LEFT JOIN store_locations tl ON tl.id = t.to_store_location_id
         WHERE t.status IN ('dispatched', 'received')
         ORDER BY t.id DESC LIMIT 20`);
      for (const t of inTransitMtns) {
        const route = `${t.from_store_name || t.from_location || 'Origin'} → ${t.to_store_name || t.to_location || 'Site Store'}`;
        pushItem({
          key: `ops:mtn:${t.id}:${t.status}`,
          category: 'transfers_ops',
          kind: 'mtn_receive',
          badge: t.status === 'received' ? 'ACCEPT STOCK' : 'IN-TRANSIT MTN',
          badge_color: 'amber',
          priority: 'high',
          ref: t.mtn_no,
          title: `${t.status === 'received' ? 'Accept Received MTN' : 'Receive Dispatched MTN'} ${t.mtn_no}`,
          subtitle: `${route}${t.description ? ' — ' + t.description : ''}`,
          meta: `Status: ${t.status.toUpperCase()} · ${t.txn_date || ''}`,
          timestamp: t.txn_date || '',
          link: `#/stores?tab=mtn&id=${t.id}`,
          action_label: t.status === 'received' ? 'Accept into Shelf' : 'Receive MTN',
          capability: 'stores.mtn.edit',
        });
      }
    } catch (e) {}
  }

  if (may('jobs.create')) {
    const waiting = all(`
      SELECT r.id, r.jr_no, r.req_date, r.approved_at, r.requested_by, r.certified_by, r.approved_by, r.description,
             a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec
        FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
       WHERE r.approval_status = 'approved' AND r.job_id IS NULL${and(rOwn)}
       ORDER BY r.approved_at DESC, r.id DESC LIMIT 20`, ...(rOwn.params || []));
    for (const r of waiting) {
      const veh = [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · ');
      pushItem({
        key: `ops:jr_open:${r.id}`,
        category: 'transfers_ops',
        kind: 'jr_open_card',
        badge: 'APPROVED JR',
        badge_color: 'blue',
        priority: 'high',
        ref: r.jr_no,
        title: `Approved JR ${r.jr_no} — Ready to Open Job Card`,
        subtitle: `${veh ? veh + ' — ' : ''}${r.description || ''}`,
        meta: `Approved by ${r.approved_by || 'Manager'} · Certified by ${r.certified_by || 'Engineer'}`,
        timestamp: r.approved_at || r.req_date || '',
        link: `#/jobrequests/${r.id}`,
        action_label: 'Open Job Card',
        capability: 'jobs.create',
      });
    }
  }

  if (canMod('purchasing')) {
    try {
      const pm = purchasingFlow.monitor(user);
      if (pm && pm.urgent_to_buy > 0) {
        pushItem({
          key: `ops:purch:urgent:${new Date().toISOString().slice(0, 10)}`,
          category: 'transfers_ops',
          kind: 'purchasing_urgent',
          badge: 'URGENT BUY',
          badge_color: 'red',
          priority: 'urgent',
          ref: `${pm.urgent_to_buy} lines`,
          title: `${pm.urgent_to_buy} Urgent Approved Item(s) Waiting to Buy`,
          subtitle: `${pm.to_buy || 0} total approved lines in your purchasing queue`,
          meta: `Purchasing Queue`,
          timestamp: new Date().toISOString(),
          link: '#/purchasing',
          action_label: 'Open Purchasing',
          capability: 'purchasing',
        });
      }
    } catch (e) {}
  }

  if (may('attendance.signoff') && attendance.isEnabled()) {
    try {
      const wsList = attendanceWorkshops(user);
      const unsignedDays = unsignedFor(wsList).slice(0, 10);
      for (const d of unsignedDays) {
        pushItem({
          key: `ops:signoff:${d.workshop_id || 0}:${d.date}`,
          category: 'transfers_ops',
          kind: 'signoff',
          badge: 'SIGN-OFF',
          badge_color: d.red_count > 0 ? 'red' : 'amber',
          priority: 'normal',
          ref: d.date,
          title: `Workday Sign-Off Pending: ${d.date}`,
          subtitle: `${d.workshop_name || 'Workshop'} · ${d.red_count || 0} red flag(s)`,
          meta: `Attendance & Daily Work`,
          timestamp: d.date,
          link: `#/dailywork?att=${encodeURIComponent(d.date)}${d.workshop_id ? '&att_ws=' + d.workshop_id : ''}`,
          action_label: 'Sign Off Day',
          capability: 'attendance.signoff',
        });
      }
    } catch (e) {}
  }

  if (may('jobs.close')) {
    try {
      const readyJobs = jobsFlow.ready(user, { limit: 10 });
      for (const r of (readyJobs.rows || [])) {
        const veh = [r.asset_reg, r.asset_ec, r.asset_code].filter(Boolean).join(' · ');
        pushItem({
          key: `ops:close:${r.id}`,
          category: 'transfers_ops',
          kind: 'ready_to_close',
          badge: 'READY TO CLOSE',
          badge_color: 'green',
          priority: 'normal',
          ref: r.job_no,
          title: `Job ${r.job_no} Ready for Closure`,
          subtitle: `${veh ? veh + ' — ' : ''}${r.description || ''}`,
          meta: `All work & pricing complete`,
          timestamp: r.since || '',
          link: `#/jobs/${r.id}`,
          action_label: 'Close Job',
          capability: 'jobs.close',
        });
      }
    } catch (e) {}
  }

  // =========================================================================
  // 4. RECENT CERTIFIED / APPROVED / WORKFLOW ACTIVITY (Last 72 Hours)
  //    Scoped strictly by user's module access & workshop reach
  // =========================================================================
  try {
    const wsFilter = rReach == null ? '' : (rReach.length ? ` AND (u.workshop_id IS NULL OR u.workshop_id IN (${rReach.map(Number).join(',')}))` : ' AND 1=0');
    const recentLogs = all(`
      SELECT al.id, al.entity, al.entity_id, al.action, al.reason, al.created_at,
             u.username, u.full_name
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.user_id
       WHERE datetime(al.created_at) >= datetime('now', '-72 hours')
         AND (
           LOWER(al.action) IN ('certify', 'certified', 'approve', 'approved', 'reject', 'rejected', 'dispatch', 'dispatched', 'receive', 'received', 'accept', 'accepted', 'signoff', 'close', 'reopen', 'create')
           OR LOWER(COALESCE(al.reason, '')) LIKE '%certif%'
           OR LOWER(COALESCE(al.reason, '')) LIKE '%approv%'
           OR LOWER(COALESCE(al.reason, '')) LIKE '%reject%'
           OR LOWER(COALESCE(al.reason, '')) LIKE '%dispatch%'
         )${wsFilter}
       ORDER BY al.id DESC LIMIT 35
    `);

    for (const log of recentLogs) {
      const target = resolveAuditTarget(log.entity, log.entity_id, log.action);
      if (target.mod && !canMod(target.mod)) continue;

      const actUpper = String(log.action || '').toUpperCase();
      let badgeColor = 'gray';
      if (/CERTIF/.test(actUpper) || /CERTIF/i.test(log.reason || '')) badgeColor = 'blue';
      else if (/APPROV|ACCEPT/.test(actUpper) || /APPROV/i.test(log.reason || '')) badgeColor = 'green';
      else if (/REJECT/.test(actUpper) || /REJECT/i.test(log.reason || '')) badgeColor = 'red';
      else if (/DISPATCH|RECEIV/.test(actUpper)) badgeColor = 'amber';

      pushItem({
        key: `audit:${log.id}`,
        category: 'status_updates',
        kind: 'workflow_event',
        badge: actUpper || 'EVENT',
        badge_color: badgeColor,
        priority: 'low',
        ref: `${target.label}${log.entity_id ? ' #' + log.entity_id : ''}`,
        title: `${target.label} ${log.entity_id ? '#' + log.entity_id : ''} — ${actUpper}`,
        subtitle: log.reason || `${actUpper} recorded on ${target.label}`,
        meta: `By ${log.full_name || log.username || 'System'} · ${slFormat(log.created_at)}`,
        timestamp: log.created_at || '',
        link: target.link,
        action_label: 'Open',
        capability: target.mod || 'general',
      });
    }
  } catch (e) {}

  // Compute category counts
  const counts = {
    all: items.length,
    unread: items.filter((i) => i.unread).length,
    certifications: items.filter((i) => i.category === 'certifications').length,
    certifications_unread: items.filter((i) => i.category === 'certifications' && i.unread).length,
    approvals: items.filter((i) => i.category === 'approvals').length,
    approvals_unread: items.filter((i) => i.category === 'approvals' && i.unread).length,
    transfers_ops: items.filter((i) => i.category === 'transfers_ops').length,
    transfers_ops_unread: items.filter((i) => i.category === 'transfers_ops' && i.unread).length,
    status_updates: items.filter((i) => i.category === 'status_updates').length,
    status_updates_unread: items.filter((i) => i.category === 'status_updates' && i.unread).length,
  };

  const totalActionable = counts.certifications + counts.approvals + counts.transfers_ops;
  const actionableUnread = counts.certifications_unread + counts.approvals_unread + counts.transfers_ops_unread;

  const authorities = [
    may('jobrequests.certify') ? 'JR Certifier' : null,
    may('jobrequests.approve') ? 'JR Approver' : null,
    may('jobs.approve_transport') ? 'Transport Approver' : null,
    may('jobs.approve_operations') ? 'Operations Approver' : null,
    may('stores.mrn.certify') ? 'MRN Certifier' : null,
    may('stores.mrn.approve') ? 'MRN Approver' : null,
    may('stores.grn.approve') ? 'GRN Approver' : null,
    may('stores.min.approve') ? 'MIN Approver' : null,
    may('stores.mtn.approve') ? 'MTN Approver' : null,
    may('stores.mtn.edit') ? 'MTN Receiver' : null,
    may('stores.count.approve') ? 'Stock Take Approver' : null,
    may('stores.disposal.approve') ? 'Disposal Approver' : null,
    may('attendance.signoff') ? 'Workday Sign-off' : null,
    may('jobs.close') ? 'Job Closer' : null,
  ].filter(Boolean);

  return {
    total_unread: counts.unread,
    actionable_unread: actionableUnread,
    total_actionable: totalActionable,
    badge_count: actionableUnread > 0 ? actionableUnread : totalActionable,
    counts,
    authorities,
    items,
    generated_at: new Date().toISOString(),
  };
}

function markRead(userId, notifKeys) {
  ensureNotificationTable();
  if (!userId || !Array.isArray(notifKeys) || !notifKeys.length) return 0;
  let count = 0;
  tx(() => {
    for (const k of notifKeys) {
      const key = String(k || '').trim();
      if (!key) continue;
      run('INSERT OR REPLACE INTO user_notification_reads (user_id, notif_key, read_at) VALUES (?, ?, datetime(\'now\'))', userId, key);
      count++;
    }
  });
  return count;
}

function markAllRead(user) {
  ensureNotificationTable();
  if (!user || !user.id) return 0;
  const feed = getNotificationsForUser(user);
  const keys = (feed.items || []).map((i) => i.key);
  return markRead(user.id, keys);
}

module.exports = {
  getNotificationsForUser,
  markRead,
  markAllRead,
};
