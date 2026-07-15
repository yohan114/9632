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

function rolesForUser(userId) {
  return all(
    `SELECT r.name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?`,
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

/** Populate req.user (or null) from the session cookie. Never blocks. */
function authenticate(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    const sess = get(
      `SELECT s.*, u.username, u.full_name, u.active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now')`,
      token
    );
    if (sess && sess.active) {
      req.user = {
        id: sess.user_id,
        username: sess.username,
        fullName: sess.full_name,
        roles: rolesForUser(sess.user_id),
        token,
      };
    }
  }
  next();
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

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  rolesForUser,
  createSession,
  destroySession,
  authenticate,
  requireAuth,
  requireRole,
  hasRole,
};
