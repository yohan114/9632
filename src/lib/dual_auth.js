'use strict';

// ===========================================================================
// WorkshopOne Enterprise Dual-Authorization (4-Eyes Principle) & Audit Ledger
//
// Implements mandatory two-person authorization for:
//   1. Post-Closure Modifications (Reopening closed Job Cards, line modifications)
//   2. Stock Adjustments & Scrapping (Tool scrap, write-offs, stocktake corrections)
//   3. High-Value Threshold Approvals (Exceeding single-user approval limits)
//   4. Security & Privilege Changes (Admin promotions, capability changes)
//
// Plus cryptographic SHA-256 hash chaining on the audit ledger.
// ===========================================================================

const crypto = require('crypto');
const { get, all, run } = require('../db');

function initDualAuthTables(dbInstance) {
  const d = dbInstance || require('../db').db;
  d.exec(`
    -- 1. Multi-Workshop Cluster Assignment (SAP CDS DCL Pattern)
    CREATE TABLE IF NOT EXISTS user_workshops (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workshop_id   INTEGER NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
      role_at_site  TEXT,
      is_primary    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, workshop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_workshops_user ON user_workshops(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_workshops_ws ON user_workshops(workshop_id);

    -- 2. Granular Financial Approval Limits
    CREATE TABLE IF NOT EXISTS user_approval_limits (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category      TEXT NOT NULL, -- 'job_cards', 'mrn', 'grn', 'disposal'
      single_limit  REAL NOT NULL DEFAULT 0,
      dual_limit    REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, category)
    );

    -- 3. Dual-Authorization (4-Eyes) Requests
    CREATE TABLE IF NOT EXISTS dual_auth_requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_type  TEXT NOT NULL, -- 'job_reopen', 'stock_scrap', 'limit_override', 'security_escalation'
      entity_type     TEXT NOT NULL, -- 'job_card', 'tool', 'store_item', 'user', 'mrn', 'grn'
      entity_id       INTEGER NOT NULL,
      requested_by    INTEGER NOT NULL REFERENCES users(id),
      requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
      reason          TEXT NOT NULL,
      proposed_data   TEXT NOT NULL, -- JSON snapshot of payload/changes
      financial_delta REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TEXT,
      decision_note   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dual_auth_status ON dual_auth_requests(status);
    CREATE INDEX IF NOT EXISTS idx_dual_auth_entity ON dual_auth_requests(entity_type, entity_id);

    -- 4. Cryptographic Anti-Tamper Audit Ledger (SHA-256 Hash Chained)
    CREATE TABLE IF NOT EXISTS audit_ledger (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
      user_id          INTEGER NOT NULL,
      action           TEXT NOT NULL,
      entity           TEXT NOT NULL,
      entity_id        INTEGER,
      payload_snapshot TEXT NOT NULL,
      prev_hash        TEXT NOT NULL,
      hash             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_entity ON audit_ledger(entity, entity_id);
  `);
}

// Ensure tables are created on module import
try {
  initDualAuthTables();
} catch (e) {
  console.error('Failed to init dual auth tables:', e);
}

// ---------------------------------------------------------------------------
// Cryptographic Hash Chaining on Audit Ledger
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function computeHash(prevHash, userId, action, entity, entityId, payloadStr, timestamp) {
  const data = `${prevHash}|${userId}|${action}|${entity}|${entityId || 0}|${payloadStr}|${timestamp}`;
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function recordLedger({ userId, action, entity, entityId, payloadSnapshot }) {
  const lastRow = get('SELECT id, hash FROM audit_ledger ORDER BY id DESC LIMIT 1');
  const prevHash = lastRow ? lastRow.hash : GENESIS_HASH;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const payloadStr = typeof payloadSnapshot === 'string' ? payloadSnapshot : JSON.stringify(payloadSnapshot || {});
  const hash = computeHash(prevHash, userId, action, entity, entityId, payloadStr, timestamp);

  const info = run(
    `INSERT INTO audit_ledger (timestamp, user_id, action, entity, entity_id, payload_snapshot, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    timestamp, userId, action, entity, entityId || null, payloadStr, prevHash, hash
  );
  return { id: info.lastInsertRowid, hash, prevHash, timestamp };
}

function verifyLedgerIntegrity() {
  const rows = all('SELECT * FROM audit_ledger ORDER BY id ASC');
  let prevHash = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== prevHash) {
      return { valid: false, brokenAtId: r.id, reason: 'Broken prev_hash chain link' };
    }
    const expectedHash = computeHash(r.prev_hash, r.user_id, r.action, r.entity, r.entity_id, r.payload_snapshot, r.timestamp);
    if (r.hash !== expectedHash) {
      return { valid: false, brokenAtId: r.id, reason: 'Tampered row content - hash mismatch' };
    }
    prevHash = r.hash;
  }
  return { valid: true, totalRecords: rows.length };
}

// ---------------------------------------------------------------------------
// 4-Eyes Dual Authorization Logic
// ---------------------------------------------------------------------------

const MANDATORY_4EYES_OPERATIONS = new Set([
  'job_reopen',             // Reopening CLOSED Job Card
  'post_closure_edit',      // Modifying financial lines on closed cards
  'stock_scrap',            // Scrap disposal of tools/batteries/parts
  'stock_writeoff',         // Negative stock adjustment
  'stocktake_correction',   // Physical stock reconciliation
  'security_escalation',    // Promoting to admin or changing access matrix
  'limit_override',         // Expense exceeding single-user approval limit
  'asset_delete',           // Deleting vehicle or machine from asset master
  'attendance_unlock',      // Unlocking historical signed-off attendance day
  'wage_rate_edit',         // Modifying mechanic hourly wage/charge rates
  'doc_exemption',          // Exempting asset from statutory compliance
  'mrn_amend_settled'       // Amending settled MRN after issues have posted
]);

function isDualAuthRequired(operationType, { financialAmount = 0, userLimit = null } = {}) {
  if (MANDATORY_4EYES_OPERATIONS.has(operationType)) return true;
  if (userLimit != null && financialAmount > userLimit) return true;
  return false;
}

function createDualAuthRequest({
  operationType,
  entityType,
  entityId,
  requestedBy,
  reason,
  proposedData,
  financialDelta = 0,
}) {
  if (!reason || !String(reason).trim()) {
    throw new Error('A detailed reason is mandatory for 4-Eyes Dual Authorization.');
  }

  const payloadStr = typeof proposedData === 'string' ? proposedData : JSON.stringify(proposedData || {});

  const info = run(
    `INSERT INTO dual_auth_requests (operation_type, entity_type, entity_id, requested_by, reason, proposed_data, financial_delta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    operationType, entityType, entityId, requestedBy, String(reason).trim(), payloadStr, Number(financialDelta) || 0
  );

  const reqId = info.lastInsertRowid;
  recordLedger({
    userId: requestedBy,
    action: 'dual_auth.request',
    entity: entityType,
    entityId,
    payloadSnapshot: { reqId, operationType, reason, financialDelta }
  });

  return get('SELECT * FROM dual_auth_requests WHERE id = ?', reqId);
}

function approveDualAuthRequest(requestId, approvedBy, note = '') {
  const req = get('SELECT * FROM dual_auth_requests WHERE id = ?', requestId);
  if (!req) throw new Error('Dual-authorization request not found');
  if (req.status !== 'PENDING') throw new Error(`Request is already ${req.status}`);

  // Enforce 4-Eyes Principle: User B cannot be User A!
  if (Number(req.requested_by) === Number(approvedBy)) {
    throw new Error('4-Eyes Violation: The person requesting an action cannot approve it themselves.');
  }

  run(
    `UPDATE dual_auth_requests
        SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now'), decision_note = ?
      WHERE id = ?`,
    approvedBy, note ? String(note).trim() : null, requestId
  );

  recordLedger({
    userId: approvedBy,
    action: 'dual_auth.approve',
    entity: req.entity_type,
    entityId: req.entity_id,
    payloadSnapshot: { reqId: requestId, operationType: req.operation_type, note }
  });

  return get('SELECT * FROM dual_auth_requests WHERE id = ?', requestId);
}

function rejectDualAuthRequest(requestId, rejectedBy, note = '') {
  const req = get('SELECT * FROM dual_auth_requests WHERE id = ?', requestId);
  if (!req) throw new Error('Dual-authorization request not found');
  if (req.status !== 'PENDING') throw new Error(`Request is already ${req.status}`);

  run(
    `UPDATE dual_auth_requests
        SET status = 'REJECTED', approved_by = ?, approved_at = datetime('now'), decision_note = ?
      WHERE id = ?`,
    rejectedBy, note ? String(note).trim() : 'Rejected by second approver', requestId
  );

  recordLedger({
    userId: rejectedBy,
    action: 'dual_auth.reject',
    entity: req.entity_type,
    entityId: req.entity_id,
    payloadSnapshot: { reqId: requestId, operationType: req.operation_type, note }
  });

  return get('SELECT * FROM dual_auth_requests WHERE id = ?', requestId);
}

function listPendingDualAuth(user) {
  const currentUserId = user && user.id ? user.id : 0;
  // User cannot approve their own requests, but we return all for dashboard counting, marking can_approve
  return all(
    `SELECT d.*,
            u1.full_name AS requester_name, u1.username AS requester_username,
            (d.requested_by != ?) AS can_approve
       FROM dual_auth_requests d
       JOIN users u1 ON u1.id = d.requested_by
      WHERE d.status = 'PENDING'
      ORDER BY d.requested_at DESC`,
    currentUserId
  );
}

// ---------------------------------------------------------------------------
// Multi-Workshop Cluster Scoping (SAP CDS DCL Tenancy)
// ---------------------------------------------------------------------------

function workshopsForUser(userId) {
  const rows = all(
    `SELECT w.id, w.name, w.code, uw.is_primary, uw.role_at_site
       FROM user_workshops uw
       JOIN workshops w ON w.id = uw.workshop_id
      WHERE uw.user_id = ? AND w.active = 1`,
    userId
  );
  if (rows.length) return rows;

  // Fallback to single workshop_id on users table if not clustered yet
  const u = get('SELECT workshop_id FROM users WHERE id = ?', userId);
  if (u && u.workshop_id) {
    const w = get('SELECT id, name, code FROM workshops WHERE id = ?', u.workshop_id);
    if (w) return [{ ...w, is_primary: 1, role_at_site: 'member' }];
  }
  return [];
}

function isWorkshopAllowed(user, targetWorkshopId) {
  if (!user) return false;
  const caps = user.caps || [];
  // Global clearance
  if (user.roles && user.roles.includes('admin')) return true;
  if (caps.includes('workshops.all')) return true;
  if (!targetWorkshopId) return true;

  const allowedIds = (user.workshop_ids || workshopsForUser(user.id).map((w) => w.id));
  return allowedIds.includes(Number(targetWorkshopId));
}

module.exports = {
  initDualAuthTables,
  recordLedger,
  verifyLedgerIntegrity,
  isDualAuthRequired,
  createDualAuthRequest,
  approveDualAuthRequest,
  rejectDualAuthRequest,
  listPendingDualAuth,
  workshopsForUser,
  isWorkshopAllowed,
  MANDATORY_4EYES_OPERATIONS
};
