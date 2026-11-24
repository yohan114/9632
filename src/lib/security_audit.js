'use strict';

/**
 * Security & Release Hardening Service (Stage D)
 *
 * Powers the Security & Hardening cockpit (#/access?tab=security):
 *   - Live security posture & MFA rollout audit across roles and active accounts
 *   - Guarded privileged-role MFA enforcement (with self-enrollment confirmation check)
 *   - Audited bulk deactivation of dormant / seed / stale accounts (session revocation + tx)
 *   - On-demand cold backup snapshot + non-destructive SQLite PRAGMA integrity_check verification
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { get, all, run, tx } = require('../db');
const multidb = require('../db/multidb');
const auth = require('./auth');
const rules = require('./access_rules');
const mfa = require('./mfa');
const audit = require('./audit');
const backup = require('./backup');
const backupStatus = require('./backup_status');

const PRIVILEGED_ROLES = ['admin', 'manager', 'operational_manager', 'accountant'];
const DEFAULT_SEED_USERNAMES = [
  'store', 'transport', 'ops', 'mech', 'viewer', 'asst',
  'wstore', 'mstore', 'workshop', 'fuel', 'accounts', 'test',
];

const fail = (status, msg, extra = null) => {
  const err = new Error(msg);
  err.status = status;
  if (extra) err.extra = extra;
  return err;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Computes the complete security posture, role MFA status, user account hygiene rows,
 * cold backup health summary, and runtime metadata for the Security & Hardening tab.
 */
function getSecurityPosture(actor = null) {
  const today = todayISO();

  const rawRoles = all(`
    SELECT id, name, label, description, COALESCE(is_system, 0) AS is_system,
           COALESCE(active, 1) AS active, COALESCE(require_mfa, 0) AS require_mfa
      FROM roles
     ORDER BY active DESC, id
  `);

  const rawUsers = all(`
    SELECT id, username, full_name, COALESCE(active, 1) AS active,
           COALESCE(must_change_password, 0) AS must_change_password,
           COALESCE(mfa_enabled, 0) AS mfa_enabled,
           mfa_enabled_at, access_until, created_at
      FROM users
     ORDER BY active DESC, username COLLATE NOCASE
  `);

  const userRoleRows = all(`
    SELECT ur.user_id, r.name AS role_name, r.label AS role_label,
           COALESCE(r.active, 1) AS role_active, COALESCE(r.require_mfa, 0) AS require_mfa
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     ORDER BY r.id
  `);
  const rolesByUser = new Map();
  for (const row of userRoleRows) {
    if (!rolesByUser.has(row.user_id)) rolesByUser.set(row.user_id, []);
    rolesByUser.get(row.user_id).push(row);
  }

  const sessionMap = new Map();
  try {
    for (const s of all(`
      SELECT user_id, COUNT(*) AS c, MAX(COALESCE(last_seen_at, created_at)) AS last_seen
        FROM sessions
       WHERE expires_at > datetime('now')
       GROUP BY user_id
    `)) {
      sessionMap.set(s.user_id, { count: Number(s.c || 0), lastSeen: s.last_seen || null });
    }
  } catch (_) {}

  const auditMap = new Map();
  try {
    for (const a of all(`
      SELECT user_id, COUNT(*) AS c, MAX(created_at) AS last_at
        FROM audit_log
       WHERE user_id IS NOT NULL
       GROUP BY user_id
    `)) {
      auditMap.set(a.user_id, { count: Number(a.c || 0), lastAt: a.last_at || null });
    }
  } catch (_) {}

  const roleStats = new Map();
  for (const r of rawRoles) {
    roleStats.set(r.name, { active_holders: 0, mfa_enrolled_holders: 0 });
  }

  const seedSet = new Set(DEFAULT_SEED_USERNAMES);
  const privSet = new Set(PRIVILEGED_ROLES);

  const users = rawUsers.map((u) => {
    const rRows = rolesByUser.get(u.id) || [];
    const roleNames = rRows.map((r) => r.role_name);
    const active = !!u.active;
    const mfaEnabled = !!u.mfa_enabled;
    const isPrivileged = roleNames.some((rn) => privSet.has(rn));
    const mfaRequiredByRole = rRows.some((r) => !!r.role_active && !!r.require_mfa);
    const mustChangePassword = !!u.must_change_password;
    const isDefaultSeed = seedSet.has(String(u.username || '').toLowerCase());
    const sess = sessionMap.get(u.id) || { count: 0, lastSeen: null };
    const aud = auditMap.get(u.id) || { count: 0, lastAt: null };
    const isDormant = active && aud.count === 0 && sess.count === 0;
    const isExpiredAccess = !!(u.access_until && String(u.access_until).slice(0, 10) < today);
    const lastActivityAt = sess.lastSeen && aud.lastAt
      ? (sess.lastSeen > aud.lastAt ? sess.lastSeen : aud.lastAt)
      : (sess.lastSeen || aud.lastAt || null);

    if (active) {
      for (const rn of roleNames) {
        const st = roleStats.get(rn);
        if (st) {
          st.active_holders += 1;
          if (mfaEnabled) st.mfa_enrolled_holders += 1;
        }
      }
    }

    const canManage = !!(actor && Number(actor.id) !== Number(u.id) && (rules.isAdmin(actor) || !roleNames.includes('admin')));

    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name || '',
      active,
      roles: roleNames,
      role_labels: rRows.map((r) => r.role_label || r.role_name),
      is_privileged: isPrivileged,
      mfa_enabled: mfaEnabled,
      mfa_enabled_at: u.mfa_enabled_at || null,
      mfa_required_by_role: mfaRequiredByRole,
      must_change_password: mustChangePassword,
      is_default_seed: isDefaultSeed,
      is_dormant: isDormant,
      access_until: u.access_until || null,
      is_expired_access: isExpiredAccess,
      active_sessions: sess.count,
      audit_count: aud.count,
      last_activity_at: lastActivityAt,
      created_at: u.created_at || null,
      can_deactivate: active && canManage && !roleNames.includes('admin'),
    };
  });

  const roles = rawRoles.map((r) => {
    const st = roleStats.get(r.name) || { active_holders: 0, mfa_enrolled_holders: 0 };
    return {
      id: r.id,
      name: r.name,
      label: r.label || r.name,
      description: r.description || '',
      is_system: !!r.is_system,
      active: !!r.active,
      is_privileged: privSet.has(r.name),
      require_mfa: !!r.require_mfa,
      active_holders: st.active_holders,
      mfa_enrolled_holders: st.mfa_enrolled_holders,
    };
  });

  const activeUsers = users.filter((u) => u.active);
  const privActiveUsers = activeUsers.filter((u) => u.is_privileged);
  const privRolesPresent = roles.filter((r) => r.active && r.is_privileged);
  const activeSessionsTotal = activeUsers.reduce((sum, u) => sum + u.active_sessions, 0);

  const actorRow = actor && actor.id ? users.find((u) => Number(u.id) === Number(actor.id)) : null;
  const actorMfaEnabled = actorRow ? actorRow.mfa_enabled : !!(actor && actor.id && mfa.isEnabled(actor.id));

  let backupInfo = { ok: false, snapshot_stale: true, verify_overdue: true, snapshot_count: 0 };
  try {
    const bSum = backupStatus.summary();
    const list = backup.listBackups(config.backupDir);
    backupInfo = {
      ...bSum,
      backup_dir: config.backupDir,
      interval_minutes: config.backupIntervalMinutes || 0,
      retention: config.backupRetention || 10,
      snapshot_count: (list && Array.isArray(list.files)) ? list.files.length : 0,
      total_mb: (list && list.totalMB) || 0,
    };
  } catch (_) {}

  const summary = {
    total_users: users.length,
    active_users: activeUsers.length,
    inactive_users: users.length - activeUsers.length,
    active_admins: rules.activeAdminIds().length,
    mfa_enrolled_users: activeUsers.filter((u) => u.mfa_enabled).length,
    mfa_enrolled_pct: activeUsers.length
      ? Math.round((activeUsers.filter((u) => u.mfa_enabled).length / activeUsers.length) * 100)
      : 0,
    privileged_active_users: privActiveUsers.length,
    privileged_mfa_enrolled: privActiveUsers.filter((u) => u.mfa_enabled).length,
    privileged_roles_enforced: privRolesPresent.filter((r) => r.require_mfa).length,
    privileged_roles_total: privRolesPresent.length,
    must_change_password_count: activeUsers.filter((u) => u.must_change_password).length,
    dormant_accounts_count: activeUsers.filter((u) => u.is_dormant).length,
    default_seed_active_count: activeUsers.filter((u) => u.is_default_seed).length,
    expired_access_count: activeUsers.filter((u) => u.is_expired_access).length,
    active_sessions_total: activeSessionsTotal,
    actor_mfa_enabled: actorMfaEnabled,
  };

  return {
    generated_at: new Date().toISOString(),
    privileged_roles: PRIVILEGED_ROLES,
    summary,
    roles,
    users,
    backup: backupInfo,
    runtime: {
      node_version: process.version,
      node_env: process.env.NODE_ENV || 'development',
      host: config.host,
      port: config.port,
      db_file: path.basename(config.dbPath || ''),
      multidb: !!(multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()),
    },
  };
}

/**
 * Bulk-toggles roles.require_mfa with access rules and an explicit confirmation guard
 * if the acting user belongs to one of the roles being enforced and has not yet enrolled 2FA.
 */
function setRolesMfaPolicy(actor, roleNames, requireMfa, { confirmSelfUnenrolled = false } = {}) {
  if (!Array.isArray(roleNames) || roleNames.length === 0) {
    throw fail(400, 'Select at least one role to update two-factor policy.');
  }
  const uniqueRoles = [...new Set(roleNames.map((r) => String(r || '').trim()).filter(Boolean))];
  if (!uniqueRoles.length) {
    throw fail(400, 'Select at least one valid role.');
  }

  const on = !!requireMfa;
  if (!on && !rules.isAdmin(actor)) {
    throw fail(403, 'Only an admin may disable two-factor sign-in on a role.');
  }
  if (uniqueRoles.includes('admin') && !rules.isAdmin(actor)) {
    throw fail(403, 'Only an admin may change two-factor policy on the admin role.');
  }

  const existing = uniqueRoles.map((name) => {
    const row = get('SELECT id, name, label, COALESCE(require_mfa, 0) AS require_mfa FROM roles WHERE name = ?', name);
    if (!row) throw fail(404, `Role "${name}" not found.`);
    return row;
  });

  if (on && actor && actor.id) {
    const actorRoles = new Set(Array.isArray(actor.roles) ? actor.roles : auth.rolesForUser(actor.id));
    const affectedSelfRoles = uniqueRoles.filter((rn) => actorRoles.has(rn));
    const selfMfaOn = mfa.isEnabled(actor.id);
    if (affectedSelfRoles.length > 0 && !selfMfaOn && !confirmSelfUnenrolled) {
      throw fail(
        409,
        `Your own account holds ${affectedSelfRoles.join(', ')} and does not have 2FA enrolled yet. Confirm to enforce 2FA now (you will be prompted to scan your authenticator app on next sign-in).`,
        {
          requires_self_mfa_confirm: true,
          affected_self_roles: affectedSelfRoles,
        }
      );
    }
  }

  const before = existing.map((r) => ({ name: r.name, require_mfa: !!r.require_mfa }));
  const targetVal = on ? 1 : 0;

  tx(() => {
    for (const r of existing) {
      run('UPDATE roles SET require_mfa = ? WHERE id = ?', targetVal, r.id);
    }
  });

  const updated = existing.map((r) => ({ name: r.name, label: r.label || r.name, require_mfa: on }));
  audit.record({
    userId: actor && actor.id ? actor.id : null,
    entity: 'security_mfa_policy',
    action: on ? 'enforce' : 'relax',
    before,
    after: updated,
  });

  return {
    ok: true,
    require_mfa: on,
    updated,
    posture: getSecurityPosture(actor),
  };
}

/**
 * Deactivates selected dormant / stale / seed accounts inside a single transaction,
 * revoking their active sessions and enforcing self-protection, hierarchy, and last-admin rules.
 */
function bulkDeactivateUsers(actor, userIds, reason) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw fail(400, 'Select at least one user account to deactivate.');
  }
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3) {
    throw fail(400, 'Provide a short audit reason (at least 3 characters).');
  }

  const uniqueIds = [...new Set(userIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!uniqueIds.length) {
    throw fail(400, 'No valid user IDs supplied.');
  }

  const deactivated = [];
  const skipped = [];

  tx(() => {
    for (const uid of uniqueIds) {
      const target = get('SELECT id, username, full_name, COALESCE(active, 1) AS active FROM users WHERE id = ?', uid);
      if (!target) throw fail(404, `User #${uid} not found.`);
      if (!target.active) {
        skipped.push({ id: target.id, username: target.username, reason: 'already_inactive' });
        continue;
      }

      rules.assertNotSelf(actor, uid);
      rules.assertCanManageUser(actor, uid);
      rules.assertKeepsAnAdmin({ userId: uid, deactivate: true });

      run('UPDATE users SET active = 0 WHERE id = ?', uid);
      const rev = run('DELETE FROM sessions WHERE user_id = ?', uid);
      deactivated.push({
        id: target.id,
        username: target.username,
        full_name: target.full_name || '',
        sessions_revoked: rev.changes || 0,
      });

      audit.record({
        userId: actor && actor.id ? actor.id : null,
        entity: 'user',
        entityId: target.id,
        action: 'deactivate_security_audit',
        before: { username: target.username, active: true },
        after: { username: target.username, active: false },
        reason: cleanReason,
      });
    }
  });

  return {
    ok: true,
    deactivated,
    skipped,
    posture: getSecurityPosture(actor),
  };
}

function inspectSqliteReadOnly(filePath) {
  const conn = new Database(filePath, { readonly: true });
  try {
    const ic = conn.pragma('integrity_check');
    const messages = ic.map((r) => r.integrity_check);
    const integrityOk = messages.length === 1 && messages[0] === 'ok';
    if (!integrityOk) {
      throw fail(500, `Snapshot integrity_check failed (${path.basename(filePath)}): ${messages.join(', ')}`);
    }
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const hasUsers = tables.some((t) => t.name === 'users');
    const usersCount = hasUsers ? Number(conn.prepare('SELECT COUNT(*) AS c FROM users').get().c || 0) : null;
    return { tablesCount: tables.length, hasUsers, usersCount };
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

/**
 * Non-destructive integrity verification on an existing cold backup file or MultiDB bundle directory,
 * recording the verification verdict into backup-status.json so /api/health reflects it immediately.
 */
function verifySnapshotFile(snapshotPath) {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    throw fail(404, 'Snapshot file does not exist for verification.');
  }

  const stat = fs.statSync(snapshotPath);
  const name = path.basename(snapshotPath);

  if (stat.isDirectory()) {
    const coreFile = path.join(snapshotPath, 'core.db');
    if (!fs.existsSync(coreFile)) {
      throw fail(500, `MultiDB snapshot bundle ${name} is missing core.db.`);
    }
    const coreInfo = inspectSqliteReadOnly(coreFile);
    if (!coreInfo.hasUsers || !(coreInfo.usersCount > 0)) {
      throw fail(500, `MultiDB snapshot ${name} has no active users table.`);
    }
    let totalTables = coreInfo.tablesCount;
    let totalBytes = fs.statSync(coreFile).size;
    const wsDir = path.join(snapshotPath, 'workshops');
    if (fs.existsSync(wsDir)) {
      for (const wf of fs.readdirSync(wsDir).filter((f) => f.endsWith('.db'))) {
        const wfPath = path.join(wsDir, wf);
        const wsInfo = inspectSqliteReadOnly(wfPath);
        totalTables += wsInfo.tablesCount;
        totalBytes += fs.statSync(wfPath).size;
      }
    }
    const verdict = {
      ok: true,
      snapshot: name,
      isMulti: true,
      tables: totalTables,
      users: coreInfo.usersCount,
      bytes: totalBytes,
      integrity: 'ok',
    };
    backupStatus.write('verify', verdict);
    return { ...verdict, verified_at: new Date().toISOString() };
  }

  const info = inspectSqliteReadOnly(snapshotPath);
  if (!info.hasUsers || !(info.usersCount > 0)) {
    throw fail(500, `Snapshot ${name} contains 0 user accounts.`);
  }
  const verdict = {
    ok: true,
    snapshot: name,
    isMulti: false,
    tables: info.tablesCount,
    users: info.usersCount,
    bytes: stat.size,
    integrity: 'ok',
  };
  backupStatus.write('verify', verdict);
  return { ...verdict, verified_at: new Date().toISOString() };
}

/**
 * Triggers a live SQLite online backup snapshot and immediately verifies PRAGMA integrity_check.
 */
async function runVerifiedColdBackup(actor = null) {
  const snapPath = await backup.snapshot();
  const verify = verifySnapshotFile(snapPath);
  audit.record({
    userId: actor && actor.id ? actor.id : null,
    entity: 'system_backup',
    action: 'verified_snapshot',
    after: verify,
  });
  return {
    ok: true,
    snapshot: path.basename(String(snapPath)),
    verify,
    backup: backupStatus.summary(),
  };
}

module.exports = {
  PRIVILEGED_ROLES,
  DEFAULT_SEED_USERNAMES,
  getSecurityPosture,
  setRolesMfaPolicy,
  bulkDeactivateUsers,
  verifySnapshotFile,
  runVerifiedColdBackup,
};
