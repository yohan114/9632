'use strict';

// ===========================================================================
// Two-factor sign-in (docs/SECURITY_ACCESS_MULTISITE_PLAN.md §3.4, SEC-09).
//
// A password alone is one secret, and it travels: typed on shared PCs, told over the phone, reused
// from somewhere else. With two-factor sign-in, a password is not enough — the person must also type
// the 6-digit code their phone's authenticator app shows right now.
//
// WHO. A role can require it ("Require two-factor sign-in" on Access Control → Roles), and anyone
// may turn it on for themselves. Nothing requires it by default, so installing this cannot lock the
// only admin out; the admin turns it on for their own role once they have enrolled.
//
// HOW IT FITS THE SESSION MODEL:
//   - an ENROLLED user gets no session from the password alone. Login returns a short-lived
//     challenge; the session is created only when the code is checked (sessions.mfa_verified = 1);
//   - a user whose role REQUIRES it but who has not enrolled yet gets a session that can reach
//     nothing but the enrolment screens and sign-out (auth.enforceMfaSetup), and no live socket;
//   - enrolling signs the person out everywhere else.
//
// Recovery: ten single-use codes shown once at enrolment; an admin can reset a person who lost their
// phone (Users & Roles → Reset 2FA); `node scripts/admin.js reset-mfa <user>` on the server is the
// last resort, including for the admin themselves.
// ===========================================================================

const crypto = require('crypto');
const { get, all, run, tx } = require('../db');
const totp = require('./totp');
const box = require('./secretbox');

const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_COUNT = 10;
// No 0/O or 1/I: these get read aloud and copied off paper.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normRecovery = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Does any of these (active) roles require two-factor sign-in? */
function requiredByRoles(roles) {
  if (!roles || !roles.length) return false;
  return !!get(`SELECT 1 x FROM roles WHERE require_mfa = 1 AND COALESCE(active, 1) = 1
                 AND name IN (${roles.map(() => '?').join(',')})`, ...roles);
}

function isEnabled(userId) {
  const u = get('SELECT mfa_enabled FROM users WHERE id = ?', userId);
  return !!(u && u.mfa_enabled);
}

function recoveryCodesLeft(userId) {
  return get('SELECT COUNT(*) n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n;
}

/** What the screens need: is it on, is it required, how many recovery codes are left. */
function status(userId, roles) {
  const enabled = isEnabled(userId);
  const required = requiredByRoles(roles);
  return { enabled, required, setupRequired: required && !enabled, recoveryCodesLeft: enabled ? recoveryCodesLeft(userId) : 0 };
}

// ---- enrolment -------------------------------------------------------------------------------

/** Start enrolling: a fresh secret, held as "pending" until a code from the phone proves it. */
function beginSetup(userId, username) {
  if (isEnabled(userId)) fail(409, 'Two-factor sign-in is already on. Turn it off first to set up a new phone.');
  const secret = totp.newSecret();
  run('UPDATE users SET mfa_pending_secret = ? WHERE id = ?', box.seal(secret), userId);
  return { secret, grouped: totp.grouped(secret), uri: totp.otpauthUri(secret, username) };
}

function newRecoveryCodes(userId) {
  const codes = [];
  tx(() => {
    run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
    for (let i = 0; i < RECOVERY_COUNT; i++) {
      let c = '';
      for (let j = 0; j < 10; j++) c += RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)];
      codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
      run('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, hash(c));
    }
  });
  return codes;
}

/** Finish enrolling: the code must come from the pending secret. Returns the recovery codes (shown once). */
function enable(userId, code) {
  const u = get('SELECT mfa_enabled, mfa_pending_secret FROM users WHERE id = ?', userId);
  if (!u) fail(404, 'User not found');
  if (u.mfa_enabled) fail(409, 'Two-factor sign-in is already on.');
  const secret = box.open(u.mfa_pending_secret);
  if (!secret) fail(400, 'Start the setup again — no setup is in progress.');
  const step = totp.verify(secret, code);
  if (step == null) fail(400, 'That code does not match. Check the phone\'s clock is set automatically, and type the code shown now.');
  run(`UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_pending_secret = NULL, mfa_last_step = ?,
         mfa_enabled_at = datetime('now') WHERE id = ?`, box.seal(secret), step, userId);
  return newRecoveryCodes(userId);
}

/** Turn it off (the route has already checked the person may). Keeps nothing behind. */
function clear(userId) {
  tx(() => {
    run(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_pending_secret = NULL, mfa_last_step = NULL,
           mfa_enabled_at = NULL WHERE id = ?`, userId);
    run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  });
}

// ---- checking a code -------------------------------------------------------------------------

/**
 * Check a code from an enrolled user: a 6-digit authenticator code, or a recovery code (used up on
 * success). Returns { ok, method, unreadable }.
 */
function check(userId, code, { allowRecovery = true } = {}) {
  const u = get('SELECT mfa_enabled, mfa_secret, mfa_last_step FROM users WHERE id = ?', userId);
  if (!u || !u.mfa_enabled) return { ok: false };
  const c = String(code || '').trim();
  if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
    const secret = box.open(u.mfa_secret);
    if (!secret) return { ok: false, unreadable: true };
    const step = totp.verify(secret, c, { lastStep: u.mfa_last_step });
    if (step == null) return { ok: false };
    // A code works once: the step is recorded, and verify() refuses it and anything older.
    run('UPDATE users SET mfa_last_step = ? WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)', step, userId, step);
    return { ok: true, method: 'totp' };
  }
  if (!allowRecovery) return { ok: false };
  const n = normRecovery(c);
  if (n.length !== 10) return { ok: false };
  const used = run(`UPDATE mfa_recovery_codes SET used_at = datetime('now')
                     WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, userId, hash(n)).changes;
  return used ? { ok: true, method: 'recovery', left: recoveryCodesLeft(userId) } : { ok: false };
}

// ---- sign-in challenges ----------------------------------------------------------------------
//
// Between "password right" and "code right" there is no session, only this: a random token good for
// five minutes and five tries. The password is not asked for again unless it expires.

function createChallenge(userId, ip) {
  run("DELETE FROM auth_challenges WHERE expires_at <= datetime('now')");
  const token = crypto.randomBytes(32).toString('hex');
  run(`INSERT INTO auth_challenges (token, user_id, ip, expires_at)
       VALUES (?, ?, ?, datetime('now', '+${CHALLENGE_MINUTES} minutes'))`, token, userId, ip || null);
  return token;
}

function getChallenge(token) {
  if (!token) return null;
  return get(`SELECT * FROM auth_challenges WHERE token = ? AND expires_at > datetime('now') AND attempts < ?`,
    String(token), CHALLENGE_ATTEMPTS) || null;
}

function failChallenge(token) {
  run('UPDATE auth_challenges SET attempts = attempts + 1 WHERE token = ?', String(token));
}

function consumeChallenge(token) {
  run('DELETE FROM auth_challenges WHERE token = ?', String(token));
}

module.exports = {
  requiredByRoles, isEnabled, status, beginSetup, enable, clear, check, newRecoveryCodes, recoveryCodesLeft,
  createChallenge, getChallenge, failChallenge, consumeChallenge, CHALLENGE_ATTEMPTS,
};
