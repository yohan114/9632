'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { get, all, run } = require('../db');

const COOKIE = 'wo_session';

function hashPassword(pw) {
  return bcrypt.hashSync(String(pw), 10);
}
function verifyPassword(pw, hash) {
  try {
    return bcrypt.compareSync(String(pw), hash);
  } catch {
    return false;
  }
}

// Only ACTIVE roles count. A retired role stays on record (history, audit) but grants nothing.
function rolesForUser(userId) {
  return all(
    `SELECT r.name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ? AND COALESCE(r.active, 1) = 1`,
    userId
  ).map((r) => r.name);
}

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  run(
    `INSERT INTO sessions (user_id, token, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    userId,
    token,
    expires,
    (req && (req.ip || req.headers['x-forwarded-for'])) || null,
    (req && req.headers['user-agent']) || null
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

/**
 * Sign a user out everywhere, optionally keeping the session making the request.
 *
 * Used when a password changes or is reset, and when an account is deactivated. Without it, a
 * password change does nothing about whoever already has the old one: a session stolen or left
 * open on a shared PC stays valid for its full 12 hours. Returns how many sessions were ended.
 */
function revokeSessions(userId, { exceptToken = null } = {}) {
  if (exceptToken) return run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', userId, exceptToken).changes;
  return run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
}

/** Populate req.user (or null) from the session cookie. Never blocks. */
function authenticate(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    const sess = get(
      `SELECT s.*, u.username, u.full_name, u.active, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now')`,
      token
    );
    if (sess && sess.active) {
      const roles = rolesForUser(sess.user_id);
      req.user = {
        id: sess.user_id,
        username: sess.username,
        fullName: sess.full_name,
        roles,
        // Read fresh on every request, like the roles: a permission granted or taken away on the
        // Access screen applies from the person's next click, not their next sign-in.
        caps: require('./capabilities').capsForRoles(roles),
        mustChangePassword: !!sess.must_change_password,
        token,
      };
    }
  }
  next();
}

// Until a first-login password change is done, allow only reads and the
// change-password / logout / me endpoints. Blocks all writes with 428.
function enforcePasswordChange(req, res, next) {
  if (!req.user || !req.user.mustChangePassword) return next();
  if (req.method === 'GET') return next();
  const allowed = ['/api/auth/change-password', '/api/auth/logout'];
  if (allowed.includes(req.path)) return next();
  return res.status(428).json({ error: 'Password change required before continuing', mustChangePassword: true });
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

/** Any of the listed roles (admin always allowed). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const held = new Set(req.user.roles);
    if (held.has('admin') || roles.some((r) => held.has(r))) return next();
    return res.status(403).json({ error: 'Insufficient role', need: roles });
  };
}

function hasRole(user, ...roles) {
  if (!user) return false;
  const held = new Set(user.roles);
  return held.has('admin') || roles.some((r) => held.has(r));
}

// ---- capabilities ----------------------------------------------------------------------------
//
// requireRole/hasRole above are kept for scripts and old callers, but the app no longer decides
// anything by role NAME — a role an admin creates would never be in those lists. Use these.

/** The capability list for a user object, however it was built. Admin holds everything. */
function capsOf(user) {
  if (!user) return [];
  if (Array.isArray(user.caps)) return user.caps;
  return require('./capabilities').capsForRoles(user.roles || []);
}

/** Does this user hold ANY of the named capabilities? */
function hasCap(user, ...caps) {
  if (!user) return false;
  const held = capsOf(user);
  return caps.some((c) => held.includes(c));
}

/** Route guard: the user must hold ANY of the named capabilities. */
function requireCap(...caps) {
  const lib = require('./capabilities');
  const unknown = caps.filter((c) => !lib.isCapability(c));
  // A typo here would lock everyone out of a route at the first request — fail at startup instead.
  if (unknown.length) throw new Error(`requireCap: unknown capability ${unknown.join(', ')}`);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (hasCap(req.user, ...caps)) return next();
    const labels = caps.map((c) => lib.get(c).label);
    return res.status(403).json({ error: `Your role does not allow this: ${labels.join(' / ')}`, need: caps });
  };
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  rolesForUser,
  createSession,
  destroySession,
  revokeSessions,
  authenticate,
  enforcePasswordChange,
  requireAuth,
  requireRole,
  hasRole,
  requireCap,
  hasCap,
  capsOf,
};
