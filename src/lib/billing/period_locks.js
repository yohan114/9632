'use strict';

/**
 * Site-Month & Month-Wide Billing Period Lock Service
 *
 * Locking a period (`project_id = 0` for whole month, or `project_id > 0` for
 * one site-month) blocks bill generation, revisions, finalisation, and
 * retroactive fuel slip re-pricing inside that scope.
 */

let _ensuredDefault = false;

function qGet(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).get(...params);
  return require('../../db').get(sql, ...params);
}

function qAll(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).all(...params);
  return require('../../db').all(sql, ...params);
}

function qRun(targetDb, sql, ...params) {
  if (targetDb) return targetDb.prepare(sql).run(...params);
  return require('../../db').run(sql, ...params);
}

function assertValidPeriodKey(raw) {
  const s = String(raw || '').trim().slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(s)) {
    const err = new Error('Valid periodKey (YYYY-MM) is required');
    err.status = 400;
    throw err;
  }
  return s;
}

function ensurePeriodLocksTable(targetDb = null) {
  if (!targetDb && _ensuredDefault) return;
  const ddlTable = `
    CREATE TABLE IF NOT EXISTS fleet_billing_period_locks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      period_key  TEXT NOT NULL,
      project_id  INTEGER NOT NULL DEFAULT 0,
      locked_by   INTEGER,
      locked_at   TEXT NOT NULL DEFAULT (datetime('now')),
      reason      TEXT,
      UNIQUE (period_key, project_id)
    )
  `;
  const ddlIdx = 'CREATE INDEX IF NOT EXISTS idx_billing_period_locks_key ON fleet_billing_period_locks(period_key)';
  if (targetDb) {
    targetDb.exec(`${ddlTable}; ${ddlIdx};`);
  } else {
    qRun(null, ddlTable);
    qRun(null, ddlIdx);
    _ensuredDefault = true;
  }
}

function formatLockRow(row) {
  if (!row) return null;
  const pid = Number(row.project_id) || 0;
  return {
    id: row.id,
    period_key: row.period_key,
    project_id: pid,
    scope: pid === 0 ? 'MONTH' : 'SITE',
    locked_by: row.locked_by != null ? Number(row.locked_by) : null,
    locked_by_name: row.locked_by_name || null,
    locked_at: row.locked_at || null,
    reason: row.reason || null,
    project_name: row.project_name || null,
    project_code: row.project_code || null,
  };
}

function isPeriodLocked(periodKey, projectId = 0, targetDb = null) {
  const s = String(periodKey || '').trim().slice(0, 7);
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(s)) return null;
  ensurePeriodLocksTable(targetDb);

  const pid = projectId != null && Number(projectId) > 0 ? Number(projectId) : 0;
  const row = qGet(
    targetDb,
    `
      SELECT l.*, COALESCE(u.full_name, u.username) AS locked_by_name
        FROM fleet_billing_period_locks l
        LEFT JOIN users u ON u.id = l.locked_by
       WHERE l.period_key = ?
         AND (l.project_id = 0 OR (? > 0 AND l.project_id = ?))
       ORDER BY CASE WHEN l.project_id = 0 THEN 0 ELSE 1 END ASC, l.id DESC
       LIMIT 1
    `,
    s,
    pid,
    pid
  );
  return formatLockRow(row);
}

function listPeriodLocks(periodKey = null, targetDb = null) {
  ensurePeriodLocksTable(targetDb);
  const s = periodKey ? String(periodKey).trim().slice(0, 7) : null;
  const rows = s
    ? qAll(
        targetDb,
        `
          SELECT l.*, COALESCE(u.full_name, u.username) AS locked_by_name,
                 p.name AS project_name, p.code AS project_code
            FROM fleet_billing_period_locks l
            LEFT JOIN users u ON u.id = l.locked_by
            LEFT JOIN projects p ON p.id = l.project_id
           WHERE l.period_key = ?
           ORDER BY l.period_key DESC, l.project_id ASC
        `,
        s
      )
    : qAll(
        targetDb,
        `
          SELECT l.*, COALESCE(u.full_name, u.username) AS locked_by_name,
                 p.name AS project_name, p.code AS project_code
            FROM fleet_billing_period_locks l
            LEFT JOIN users u ON u.id = l.locked_by
            LEFT JOIN projects p ON p.id = l.project_id
           ORDER BY l.period_key DESC, l.project_id ASC
        `
      );
  return rows.map(formatLockRow);
}

function lockPeriod({ periodKey, projectId = 0, userId = null, reason = null }, targetDb = null) {
  const normKey = assertValidPeriodKey(periodKey);
  const normPid = projectId != null && Number(projectId) > 0 ? Number(projectId) : 0;
  ensurePeriodLocksTable(targetDb);

  qRun(
    targetDb,
    `
      INSERT INTO fleet_billing_period_locks (period_key, project_id, locked_by, locked_at, reason)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(period_key, project_id) DO UPDATE SET
        locked_by = excluded.locked_by,
        locked_at = datetime('now'),
        reason = excluded.reason
    `,
    normKey,
    normPid,
    userId != null ? Number(userId) : null,
    reason != null && String(reason).trim() ? String(reason).trim() : null
  );

  const exact = qGet(
    targetDb,
    `
      SELECT l.*, COALESCE(u.full_name, u.username) AS locked_by_name,
             p.name AS project_name, p.code AS project_code
        FROM fleet_billing_period_locks l
        LEFT JOIN users u ON u.id = l.locked_by
        LEFT JOIN projects p ON p.id = l.project_id
       WHERE l.period_key = ? AND l.project_id = ?
       LIMIT 1
    `,
    normKey,
    normPid
  );
  return formatLockRow(exact);
}

function unlockPeriod({ periodKey, projectId = 0 }, targetDb = null) {
  const normKey = assertValidPeriodKey(periodKey);
  const normPid = projectId != null && Number(projectId) > 0 ? Number(projectId) : 0;
  ensurePeriodLocksTable(targetDb);

  const info = qRun(
    targetDb,
    'DELETE FROM fleet_billing_period_locks WHERE period_key = ? AND project_id = ?',
    normKey,
    normPid
  );
  return { unlocked: Number(info && info.changes) > 0 };
}

module.exports = {
  ensurePeriodLocksTable,
  isPeriodLocked,
  listPeriodLocks,
  lockPeriod,
  unlockPeriod,
};
