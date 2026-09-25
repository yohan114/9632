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

// mfaVerified: the second factor was checked when this session was made. An enrolled user's session
// without it is not honoured (authenticate below), so the only way to one is through the code.
function createSession(userId, req, { mfaVerified = false } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  run(
    `INSERT INTO sessions (user_id, token, expires_at, ip, user_agent, mfa_verified, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    userId,
    token,
    expires,
    (req && (req.ip || req.headers['x-forwarded-for'])) || null,
    (req && req.headers['user-agent']) || null,
    mfaVerified ? 1 : 0
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  require('./emitter').emit('sessions_changed', {});   // live sockets on that session are closed
}

/**
 * Sign a user out everywhere, optionally keeping the session making the request.
 *
 * Used when a password changes or is reset, and when an account is deactivated. Without it, a
 * password change does nothing about whoever already has the old one: a session stolen or left
 * open on a shared PC stays valid for its full 12 hours. Returns how many sessions were ended.
 */
function revokeSessions(userId, { exceptToken = null } = {}) {
  const n = exceptToken
    ? run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', userId, exceptToken).changes
    : run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
  if (n) require('./emitter').emit('sessions_changed', { userId });
  return n;
}

// ---- which sessions are still good ------------------------------------------------------------
//
// EXPIRY IS COMPARED AS A TIME, NOT AS TEXT. expires_at is written as an ISO string
// ("2026-09-24T02:38:12Z") and used to be compared with datetime('now') ("2026-09-24 04:08:12").
// As text, 'T' sorts after ' ', so on its expiry day a session was still "valid" hours after it
// had expired — the 12-hour limit really ran to midnight UTC. julianday() reads both forms as times.
//
// IDLE means no INPUT, not no requests. The screens refresh themselves whenever data changes, so an
// open dashboard sends requests all day with nobody at the PC. Every request carries how long it has
// been since the last mouse, keyboard or touch input (X-WO-Idle-Ms), and last_seen_at moves only to
// that moment. A request without the header (a script, curl) counts as activity.

const idleLimitMs = () => Math.max(0, config.sessionIdleMinutes || 0) * 60000;
const toDbTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
function fromDbTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

/**
 * The session behind a token, if it is still good: not past its expiry, not idle too long, the user
 * still active, and the second factor passed if they have one. An idle session is deleted on the
 * spot. Returns { sess } or { sess: null, ended } with the reason.
 */
function liveSession(token) {
  if (!token) return { sess: null, ended: 'none' };
  const sess = get(
    `SELECT s.*, u.username, u.full_name, u.active, u.must_change_password, u.mfa_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND julianday(s.expires_at) > julianday('now')`,
    token
  );
  if (!sess) return { sess: null, ended: 'expired' };
  if (!sess.active) return { sess: null, ended: 'inactive' };
  // An enrolled user's session must have passed the code. One that did not (made before they
  // enrolled, and somehow not revoked) is treated as no session at all.
  if (sess.mfa_enabled && !sess.mfa_verified) return { sess: null, ended: 'mfa' };
  const seen = fromDbTime(sess.last_seen_at);
  if (idleLimitMs() && seen && Date.now() - seen > idleLimitMs()) {
    run('DELETE FROM sessions WHERE id = ?', sess.id);
    require('./audit').record({ userId: sess.user_id, entity: 'session', action: 'session_idle_expired',
      after: { idle_minutes: config.sessionIdleMinutes }, notify: false });
    require('./emitter').emit('sessions_changed', { userId: sess.user_id });
    return { sess: null, ended: 'idle' };
  }
  return { sess, ended: null };
}

// Move last_seen_at to the last real input (see above). At most one write a minute per session.
function touchSession(sess, req) {
  const hdr = parseInt(req.headers['x-wo-idle-ms'], 10);
  const idleFor = Number.isFinite(hdr) && hdr > 0 ? Math.min(hdr, 7 * 24 * 3600 * 1000) : 0;
  const activeAt = Date.now() - idleFor;
  const seen = fromDbTime(sess.last_seen_at);
  if (!seen || activeAt - seen >= 60000) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', toDbTime(activeAt), sess.id);
}

// A short description of a browser, for the "signed-in devices" list.
function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /; wv\)/.test(s) ? 'Android app'
    : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /^node|curl|undici/i.test(s) ? 'Script' : 'Browser';
  const os = /Windows NT/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iPhone / iPad'
    : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** A person's signed-in sessions, newest activity first — never the tokens. */
function listSessions(userId, currentToken) {
  return all(`SELECT id, token, created_at, last_seen_at, expires_at, ip, user_agent, mfa_verified FROM sessions
               WHERE user_id = ? AND julianday(expires_at) > julianday('now')
               ORDER BY COALESCE(last_seen_at, created_at) DESC`, userId)
    .map((r) => ({
      id: r.id,
      device: describeAgent(r.user_agent),
      ip: r.ip,
      signed_in_at: r.created_at,
      last_active_at: r.last_seen_at || r.created_at,
      expires_at: r.expires_at,
      second_factor: !!r.mfa_verified,
      current: !!currentToken && r.token === currentToken,
    }));
}

/** Populate req.user (or null) from the session cookie. Never blocks. */
function authenticate(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    const { sess } = liveSession(token);
    if (!sess) {
      // The browser sent a session that is over (expired, idle, revoked). Say so, so the page can go
      // back to sign-in instead of showing errors — and stop the browser sending the dead token.
      res.set('X-WO-Session', 'ended');
      res.clearCookie(COOKIE);
    } else {
      touchSession(sess, req);
      const roles = rolesForUser(sess.user_id);
      const userExtra = get('SELECT access_until, approval_limit, workshop_id FROM users WHERE id = ?', sess.user_id) || {};
      const uBase = {
        id: sess.user_id,
        username: sess.username,
        fullName: sess.full_name,
        roles,
        access_until: userExtra.access_until || null,
        approval_limit: userExtra.approval_limit != null ? userExtra.approval_limit : null,
        workshop_id: userExtra.workshop_id || null,
      };
      req.user = {
        ...uBase,
        caps: require('./capabilities').effectiveCaps(uBase),
        permissions: require('./permissions').effectiveUserPermissions(uBase),
        mustChangePassword: !!sess.must_change_password,
        mfaEnabled: !!sess.mfa_enabled,
        mfaSetupRequired: !sess.mfa_enabled && require('./mfa').requiredByRoles(roles),
        sessionId: sess.id,
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

// What someone who still has to set up two-factor sign-in may reach. Everything else under /api and
// /uploads answers 428 until they have — reads included: for a role that requires a second factor,
// a password alone must not be enough to see the data either.
const MFA_SETUP_ALLOWED = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password',
  '/api/auth/mfa', '/api/auth/mfa/setup', '/api/auth/mfa/enable', '/api/health']);
function enforceMfaSetup(req, res, next) {
  if (!req.user || !req.user.mfaSetupRequired) return next();
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads')) return next();
  if (MFA_SETUP_ALLOWED.has(req.path)) return next();
  return res.status(428).json({ error: 'Your role requires two-factor sign-in. Set it up to continue.', mfaSetupRequired: true });
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
  return require('./capabilities').effectiveCaps(user);
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
  liveSession,
  listSessions,
  describeAgent,
  authenticate,
  enforcePasswordChange,
  enforceMfaSetup,
  requireAuth,
  requireRole,
  hasRole,
  requireCap,
  hasCap,
  capsOf,
};
