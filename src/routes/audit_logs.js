'use strict';

// ===========================================================================
// SAP Enterprise User Activity Logs & Security Audit Trail API (Z_WO_AUDIT)
// Standard: SAP NetWeaver Security Audit Log (SM20) & Application Log (SLG1)
// Access: Strict Dual Guard (Admin Role + audit.logs.view Capability)
// ===========================================================================

const express = require('express');
const { get, all } = require('../db');
const { requireRole, requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

// Strict Dual-Guard: hard-coded Admin role check + granular capability check
const guardAuditView = [requireRole('admin'), requireCap('audit.logs.view')];
const guardAuditExport = [requireRole('admin'), requireCap('audit.logs.export')];

/**
 * Compute field-level differences between before_json and after_json.
 */
function computeDiff(before, after) {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const diff = {
    added: {},
    removed: {},
    changed: {},
    unchanged: {},
  };

  const allKeys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of allKeys) {
    const hasB = Object.prototype.hasOwnProperty.call(b, k);
    const hasA = Object.prototype.hasOwnProperty.call(a, k);

    if (hasB && !hasA) {
      diff.removed[k] = b[k];
    } else if (!hasB && hasA) {
      diff.added[k] = a[k];
    } else {
      const valB = b[k];
      const valA = a[k];
      const same = JSON.stringify(valB) === JSON.stringify(valA);
      if (same) {
        diff.unchanged[k] = valA;
      } else {
        diff.changed[k] = { before: valB, after: valA };
      }
    }
  }

  return diff;
}

/**
 * 1. GET /api/audit-logs
 * Paginated and filterable audit log stream.
 */
router.get('/', ...guardAuditView, asyncHandler(async (req, res) => {
  const q = req.query;
  const clauses = [];
  const params = [];

  // Filter: user_id
  if (q.userId) {
    clauses.push('a.user_id = ?');
    params.push(toInt(q.userId));
  }

  // Filter: entity (module)
  if (q.entity && q.entity !== 'all') {
    clauses.push('a.entity = ?');
    params.push(String(q.entity).trim());
  }

  // Filter: action
  if (q.action && q.action !== 'all') {
    clauses.push('a.action = ?');
    params.push(String(q.action).trim());
  }

  // Filter: date range
  if (q.dateFrom) {
    clauses.push("datetime(a.created_at) >= datetime(?)");
    params.push(String(q.dateFrom).trim());
  }
  if (q.dateTo) {
    clauses.push("datetime(a.created_at) <= datetime(?)");
    params.push(String(q.dateTo).trim() + (q.dateTo.length === 10 ? ' 23:59:59' : ''));
  }

  // Keyword search: reason, entity, action, username, full_name
  if (q.search && q.search.trim()) {
    const term = '%' + q.search.trim() + '%';
    clauses.push('(a.reason LIKE ? OR a.entity LIKE ? OR a.action LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?)');
    params.push(term, term, term, term, term);
  }

  const whereSql = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // Count total matching records for pagination
  const countRow = get(`
    SELECT COUNT(*) as total
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
     ${whereSql}
  `, ...params);
  const total = countRow ? countRow.total : 0;

  // Pagination bounds
  const limit = Math.min(Math.max(toInt(q.limit, 50), 10), 200);
  const offset = Math.max(toInt(q.offset, 0), 0);

  // Fetch paginated logs
  const rows = all(`
    SELECT a.id, a.user_id, a.entity, a.entity_id, a.action,
           a.before_json, a.after_json, a.reason, a.created_at,
           u.username, u.full_name,
           w.name AS workshop_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN workshops w ON w.id = u.workshop_id
     ${whereSql}
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  // Parse JSON payloads and compute delta summaries for quick display
  const logs = rows.map((r) => {
    let before = null;
    let after = null;
    try { if (r.before_json) before = JSON.parse(r.before_json); } catch {}
    try { if (r.after_json) after = JSON.parse(r.after_json); } catch {}

    const diff = computeDiff(before, after);
    const changedCount = Object.keys(diff.changed).length;
    const addedCount = Object.keys(diff.added).length;
    const removedCount = Object.keys(diff.removed).length;

    return {
      id: r.id,
      user_id: r.user_id,
      username: r.username || (r.user_id ? `User #${r.user_id}` : 'System / Anonymous'),
      full_name: r.full_name || '',
      workshop_name: r.workshop_name || '',
      entity: r.entity,
      entity_id: r.entity_id,
      action: r.action,
      reason: r.reason || '',
      has_changes: (r.before_json != null || r.after_json != null),
      changes_summary: `${changedCount} changed, ${addedCount} added, ${removedCount} removed`,
      created_at: r.created_at,
    };
  });

  // Extract distinct entities and actions for client-side filter pickers
  const entities = all(`SELECT DISTINCT entity FROM audit_log ORDER BY entity`).map((r) => r.entity);
  const actions = all(`SELECT DISTINCT action FROM audit_log ORDER BY action`).map((r) => r.action);
  const actors = all(`
    SELECT DISTINCT u.id, u.username, u.full_name
      FROM audit_log a
      JOIN users u ON u.id = a.user_id
     ORDER BY u.username
  `);

  res.json({
    logs,
    pagination: {
      total,
      limit,
      offset,
      pages: Math.ceil(total / limit),
      currentPage: Math.floor(offset / limit) + 1,
    },
    filterOptions: {
      entities,
      actions,
      actors,
    },
  });
}));

/**
 * 2. GET /api/audit-logs/stats
 * Real-time analytical KPI metrics (SAP Fiori KPI tiles).
 */
router.get('/stats', ...guardAuditView, asyncHandler(async (_req, res) => {
  const totalEvents = (get(`SELECT COUNT(*) as c FROM audit_log`) || {}).c || 0;

  const todayEvents = (get(`
    SELECT COUNT(*) as c FROM audit_log
     WHERE date(created_at) = date('now')
  `) || {}).c || 0;

  const criticalDeletes = (get(`
    SELECT COUNT(*) as c FROM audit_log
     WHERE action LIKE '%delete%' OR action LIKE '%void%' OR action LIKE '%scrap%' OR action LIKE '%revoke%' OR action LIKE '%kill%'
  `) || {}).c || 0;

  const todayLogins = (get(`
    SELECT COUNT(*) as c FROM audit_log
     WHERE entity = 'session' AND (action = 'login' OR action = 'login_password_ok') AND date(created_at) = date('now')
  `) || {}).c || 0;

  const failedLoginsToday = (get(`
    SELECT COUNT(*) as c FROM audit_log
     WHERE entity = 'session' AND action LIKE 'login_fail%' AND date(created_at) = date('now')
  `) || {}).c || 0;

  const activeUsersToday = (get(`
    SELECT COUNT(DISTINCT user_id) as c FROM audit_log
     WHERE user_id IS NOT NULL AND date(created_at) = date('now')
  `) || {}).c || 0;

  const topEntities = all(`
    SELECT entity, COUNT(*) as count
      FROM audit_log
     GROUP BY entity
     ORDER BY count DESC
     LIMIT 5
  `);

  const topActorsToday = all(`
    SELECT u.username, u.full_name, COUNT(*) as count
      FROM audit_log a
      JOIN users u ON u.id = a.user_id
     WHERE date(a.created_at) = date('now')
     GROUP BY a.user_id
     ORDER BY count DESC
     LIMIT 5
  `);

  res.json({
    totalEvents,
    todayEvents,
    criticalDeletes,
    todayLogins,
    failedLoginsToday,
    activeUsersToday,
    topEntities,
    topActorsToday,
  });
}));

/**
 * 3. GET /api/audit-logs/export.xlsx
 * Export filtered audit log records to Excel (.xlsx).
 */
router.get('/export.xlsx', ...guardAuditExport, asyncHandler(async (req, res) => {
  const q = req.query;
  const clauses = [];
  const params = [];

  if (q.userId) { clauses.push('a.user_id = ?'); params.push(toInt(q.userId)); }
  if (q.entity && q.entity !== 'all') { clauses.push('a.entity = ?'); params.push(String(q.entity).trim()); }
  if (q.action && q.action !== 'all') { clauses.push('a.action = ?'); params.push(String(q.action).trim()); }
  if (q.dateFrom) { clauses.push("datetime(a.created_at) >= datetime(?)"); params.push(String(q.dateFrom).trim()); }
  if (q.dateTo) { clauses.push("datetime(a.created_at) <= datetime(?)"); params.push(String(q.dateTo).trim() + (q.dateTo.length === 10 ? ' 23:59:59' : '')); }
  if (q.search && q.search.trim()) {
    const term = '%' + q.search.trim() + '%';
    clauses.push('(a.reason LIKE ? OR a.entity LIKE ? OR a.action LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?)');
    params.push(term, term, term, term, term);
  }

  const whereSql = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = all(`
    SELECT a.id, a.created_at,
           COALESCE(u.username, 'System') AS actor_username,
           COALESCE(u.full_name, '') AS actor_full_name,
           COALESCE(w.name, '') AS workshop,
           a.entity, a.entity_id, a.action,
           a.reason, a.before_json, a.after_json
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN workshops w ON w.id = u.workshop_id
     ${whereSql}
     ORDER BY a.id DESC
     LIMIT 5000
  `, ...params);

  const exportRows = rows.map((r) => {
    let before = null;
    let after = null;
    try { if (r.before_json) before = JSON.parse(r.before_json); } catch {}
    try { if (r.after_json) after = JSON.parse(r.after_json); } catch {}
    const diff = computeDiff(before, after);
    const summary = `${Object.keys(diff.changed).length} changed, ${Object.keys(diff.added).length} added, ${Object.keys(diff.removed).length} removed`;

    return {
      id: r.id,
      timestamp: r.created_at,
      actor_username: r.actor_username,
      actor_full_name: r.actor_full_name,
      workshop: r.workshop,
      entity: r.entity,
      entity_id: r.entity_id || '',
      action: r.action,
      reason: r.reason || '',
      changes_summary: summary,
    };
  });

  const timestampStr = new Date().toISOString().slice(0, 10);
  await sendXlsx(res, `security-audit-trail-${timestampStr}.xlsx`, [{
    name: 'Security Audit Trail',
    columns: [
      { header: 'Event ID', key: 'id', width: 12 },
      { header: 'Timestamp', key: 'timestamp', width: 22 },
      { header: 'Username', key: 'actor_username', width: 18 },
      { header: 'Full Name', key: 'actor_full_name', width: 22 },
      { header: 'Workshop Location', key: 'workshop', width: 20 },
      { header: 'Module / Entity', key: 'entity', width: 20 },
      { header: 'Entity ID', key: 'entity_id', width: 14 },
      { header: 'Action', key: 'action', width: 18 },
      { header: 'Reason / Notes', key: 'reason', width: 30 },
      { header: 'Changes Summary', key: 'changes_summary', width: 26 },
    ],
    rows: exportRows,
  }]);
}));

/**
 * 4. GET /api/audit-logs/:id
 * Single record detail with full before/after JSON states and computed diff.
 */
router.get('/:id(\\d+)', ...guardAuditView, asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const row = get(`
    SELECT a.*,
           u.username, u.full_name,
           w.name AS workshop_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN workshops w ON w.id = u.workshop_id
     WHERE a.id = ?
  `, id);

  if (!row) return res.status(404).json({ error: 'Audit log entry not found' });

  let before = null;
  let after = null;
  try { if (row.before_json) before = JSON.parse(row.before_json); } catch {}
  try { if (row.after_json) after = JSON.parse(row.after_json); } catch {}

  const diff = computeDiff(before, after);

  res.json({
    id: row.id,
    user_id: row.user_id,
    username: row.username || (row.user_id ? `User #${row.user_id}` : 'System / Anonymous'),
    full_name: row.full_name || '',
    workshop_name: row.workshop_name || '',
    entity: row.entity,
    entity_id: row.entity_id,
    action: row.action,
    reason: row.reason || '',
    created_at: row.created_at,
    before,
    after,
    diff,
  });
}));

module.exports = router;
