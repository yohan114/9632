'use strict';

const express = require('express');
const { get, run } = require('../db');
const auth = require('../lib/auth');
const permissions = require('../lib/permissions');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const passwordPolicy = require('../lib/password_policy');
const capabilities = require('../lib/capabilities');
const mfa = require('../lib/mfa');
const { asyncHandler, require_ } = require('../lib/http');

const router = express.Router();

const clientIp = (req) => req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';

// A session, its cookie, and the signed-in user as the screens need them. The one way into the
// system: after a password (no second factor on the account), or after a code (/mfa/verify).
function startSession(req, res, user, { mfaVerified = false, method = 'password', extra = {} } = {}) {
  const { token, expires } = auth.createSession(user.id, req, { mfaVerified });
  res.cookie(auth.COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    expires: new Date(expires),
  });
  audit.record({ userId: user.id, entity: 'session', action: 'login', after: method === 'password' ? null : { second_factor: method } });
  const roles = auth.rolesForUser(user.id);
  const caps = capabilities.capsForRoles(roles);
  const st = mfa.status(user.id, roles);
  return res.json({
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    roles,
    permissions: permissions.userPermissions(roles),
    caps,
    capNeeds: capabilities.needsFor(caps),
    mustChangePassword: !!user.must_change_password,
    passwordPolicy: passwordPolicy.describe(),
    mfaEnabled: st.enabled,
    mfaSetupRequired: st.setupRequired,
    ...extra,
  });
}

router.post(
  '/login',
  asyncHandler((req, res) => {
    require_(req.body, ['username', 'password']);
    // Checked BEFORE the password is verified, so a locked key costs nothing to refuse and no
    // timing difference tells an attacker whether the username exists.
    const ip = clientIp(req);
    const wait = ratelimit.check(ip, req.body.username);
    if (wait) {
      return res.status(429).set('Retry-After', String(wait)).json({
        error: `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`,
      });
    }
    const user = get('SELECT * FROM users WHERE username = ? AND active = 1', req.body.username);
    if (!user || !auth.verifyPassword(req.body.password, user.password_hash)) {
      ratelimit.fail(ip, req.body.username);
      // ON THE RECORD, BUT BOUNDED. A wrong password against a REAL account is logged — that is the
      // one worth knowing about, and the per-user limit caps it at a few rows per quarter hour. A
      // guess at a name that does not exist is not logged row by row (a botnet spraying invented
      // names would otherwise fill the table); only the moment an address or name gets locked out.
      if (user) {
        audit.record({ userId: user.id, entity: 'session', action: 'login_failed', after: { ip }, notify: false });
      }
      if (ratelimit.check(ip, req.body.username)) {
        audit.record({ userId: user ? user.id : null, entity: 'session', action: 'login_locked',
          after: { ip, username: String(req.body.username).slice(0, 80) }, notify: false });
      }
      // The message stays the same either way: saying "no such user" hands an attacker a list of
      // which names are worth guessing at.
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // DEFAULT PASSWORDS DO NOT SIGN IN ON A LIVE SERVER. The demo seed makes every account's
    // password its username (admin/admin, store/store …). Forcing a change at first sign-in does not
    // make that safe on the internet: the first person to sign in — anyone — chooses the new
    // password and keeps the account. So on production the login is refused, and the account can
    // only be unlocked by someone with the server: `node scripts/admin.js set-password <user> <pw>`.
    // Local and test databases (NODE_ENV not production) keep the demo logins working.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEFAULT_PASSWORDS !== '1'
        && String(req.body.password).toLowerCase() === String(user.username).toLowerCase()) {
      audit.record({ userId: user.id, entity: 'session', action: 'login_blocked_default_password', after: { ip }, notify: false });
      return res.status(403).json({
        error: 'This account still has its default password and cannot sign in. Ask the administrator to set a new password.',
      });
    }
    // TWO-FACTOR: an enrolled account gets no session from the password alone — only a challenge,
    // good for five minutes and five codes. The failure counters are NOT cleared here: wrong codes
    // count against the same per-user limit as wrong passwords, so a right password followed by
    // guessed codes is throttled exactly like guessed passwords.
    if (user.mfa_enabled) {
      const challenge = mfa.createChallenge(user.id, ip);
      audit.record({ userId: user.id, entity: 'session', action: 'login_password_ok', after: { ip, second_factor: 'pending' }, notify: false });
      return res.json({ mfaRequired: true, challenge, username: user.username });
    }
    ratelimit.succeed(ip, req.body.username);
    return startSession(req, res, user);
  })
);

const tooMany = (wait) => `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`;

// The second step of signing in: the challenge from /login plus the code from the phone (or a
// recovery code).
router.post(
  '/mfa/verify',
  asyncHandler((req, res) => {
    require_(req.body, ['challenge', 'code']);
    const ip = clientIp(req);
    const ch = mfa.getChallenge(req.body.challenge);
    if (!ch) return res.status(401).json({ error: 'Sign-in timed out. Enter your password again.', restart: true });
    const user = get('SELECT * FROM users WHERE id = ? AND active = 1', ch.user_id);
    if (!user || !user.mfa_enabled) {
      mfa.consumeChallenge(req.body.challenge);
      return res.status(401).json({ error: 'Sign-in timed out. Enter your password again.', restart: true });
    }
    const wait = ratelimit.check(ip, user.username);
    if (wait) return res.status(429).set('Retry-After', String(wait)).json({ error: tooMany(wait), restart: true });
    const r = mfa.check(user.id, req.body.code);
    if (r.unreadable) {
      // Not the person's fault (the server's key file is missing or wrong), so not counted against them.
      audit.record({ userId: user.id, entity: 'session', action: 'login_mfa_unreadable', after: { ip }, notify: false });
      return res.status(409).json({ error: 'Your two-factor key cannot be read on this server. Ask the administrator to reset your two-factor sign-in.', restart: true });
    }
    if (!r.ok) {
      ratelimit.fail(ip, user.username);
      mfa.failChallenge(req.body.challenge);
      audit.record({ userId: user.id, entity: 'session', action: 'login_mfa_failed', after: { ip }, notify: false });
      if (ratelimit.check(ip, user.username)) {
        audit.record({ userId: user.id, entity: 'session', action: 'login_locked', after: { ip, username: user.username }, notify: false });
      }
      const left = mfa.CHALLENGE_ATTEMPTS - (ch.attempts + 1);
      return res.status(401).json(left > 0
        ? { error: 'That code is not right. Type the code your app shows now.' }
        : { error: 'Too many wrong codes. Enter your password again.', restart: true });
    }
    mfa.consumeChallenge(req.body.challenge);
    ratelimit.succeed(ip, user.username);
    return startSession(req, res, user, {
      mfaVerified: true, method: r.method, extra: r.method === 'recovery' ? { recoveryCodesLeft: r.left } : {},
    });
  })
);

// ---- managing your own two-factor sign-in ---------------------------------------------------

router.get('/mfa', auth.requireAuth, (req, res) => res.json(mfa.status(req.user.id, req.user.roles)));

// Step 1 of enrolling: a new key to put into the authenticator app.
router.post('/mfa/setup', auth.requireAuth, asyncHandler((req, res) => {
  const out = mfa.beginSetup(req.user.id, req.user.username);
  audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'mfa_setup_started', notify: false });
  res.json(out);
}));

// Step 2: a code from the app proves it was set up right. This session counts as verified; every
// other session of this account is signed out, since none of them passed a second factor.
router.post('/mfa/enable', auth.requireAuth, asyncHandler((req, res) => {
  require_(req.body, ['code']);
  const recoveryCodes = mfa.enable(req.user.id, req.body.code);
  run('UPDATE sessions SET mfa_verified = 1 WHERE token = ?', req.user.token);
  const ended = auth.revokeSessions(req.user.id, { exceptToken: req.user.token });
  audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'mfa_enabled', after: { other_sessions_ended: ended } });
  res.json({ ok: true, recoveryCodes, otherSessionsEnded: ended });
}));

// Wrong codes on the two endpoints below count against the sign-in limiter too.
function checkOwnCode(req, res, opts) {
  const ip = clientIp(req);
  const wait = ratelimit.check(ip, req.user.username);
  if (wait) { res.status(429).json({ error: tooMany(wait) }); return false; }
  const r = mfa.check(req.user.id, req.body.code, opts);
  if (!r.ok) {
    ratelimit.fail(ip, req.user.username);
    res.status(401).json({ error: 'That code is not right.' });
    return false;
  }
  return true;
}

// Turning it off needs the password AND a code — a session left open on a shared PC is not enough.
router.post('/mfa/disable', auth.requireAuth, asyncHandler((req, res) => {
  require_(req.body, ['password', 'code']);
  if (mfa.requiredByRoles(req.user.roles)) {
    return res.status(403).json({ error: 'Your role requires two-factor sign-in, so it cannot be turned off. If you have a new phone, ask an administrator to reset it.' });
  }
  const u = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(req.body.password, u.password_hash)) return res.status(401).json({ error: 'Password is incorrect' });
  if (!checkOwnCode(req, res)) return;
  mfa.clear(req.user.id);
  audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'mfa_disabled' });
  res.json({ ok: true });
}));

// New recovery codes (the old ones stop working). Needs a code from the app, not a recovery code.
router.post('/mfa/recovery-codes', auth.requireAuth, asyncHandler((req, res) => {
  require_(req.body, ['code']);
  if (!checkOwnCode(req, res, { allowRecovery: false })) return;
  const recoveryCodes = mfa.newRecoveryCodes(req.user.id);
  audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'mfa_recovery_codes_renewed' });
  res.json({ recoveryCodes });
}));

router.post(
  '/change-password',
  auth.requireAuth,
  asyncHandler((req, res) => {
    require_(req.body, ['new_password']);
    const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
    // The current password is required unless this is the forced first-login change.
    if (!req.user.mustChangePassword) {
      require_(req.body, ['current_password']);
      if (!auth.verifyPassword(req.body.current_password, user.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    const why = passwordPolicy.problem(req.body.new_password, { username: req.user.username });
    if (why) return res.status(400).json({ error: why });
    // The forced first-login change exists to get rid of the password someone else chose or saw.
    // Setting the same one again would tick the box and change nothing.
    if (auth.verifyPassword(req.body.new_password, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from the current one.' });
    }
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      auth.hashPassword(req.body.new_password), req.user.id);
    // Everyone else holding this account's old sessions is signed out; this browser stays in.
    const ended = auth.revokeSessions(req.user.id, { exceptToken: req.user.token });
    audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'change_password',
      after: { other_sessions_ended: ended } });
    res.json({ ok: true, otherSessionsEnded: ended });
  })
);

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[auth.COOKIE];
  auth.destroySession(token);
  res.clearCookie(auth.COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const u = get('SELECT signature FROM users WHERE id = ?', req.user.id);
  // The session token is the key to this account; it lives in an httpOnly cookie precisely so page
  // script cannot read it. Echoing it back in a JSON body would undo that.
  const { token: _token, ...me } = req.user;
  res.json({ ...me, permissions: permissions.userPermissions(req.user.roles), hasSignature: !!(u && u.signature),
    capNeeds: require('../lib/capabilities').needsFor(req.user.caps || []),
    passwordPolicy: passwordPolicy.describe() });
});

// Save (or clear) the signed-in user's e-signature image (drawn or uploaded PNG/JPEG data URL).
router.post('/signature', auth.requireAuth, asyncHandler((req, res) => {
  const sig = req.body.signature;
  if (sig) {
    if (!/^data:image\/(png|jpeg|jpg);base64,/.test(String(sig))) return res.status(400).json({ error: 'Signature must be a PNG/JPEG image' });
    if (String(sig).length > 400000) return res.status(413).json({ error: 'Signature image too large (max ~300 KB)' });
  }
  run('UPDATE users SET signature = ? WHERE id = ?', sig || null, req.user.id);
  audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: sig ? 'set_signature' : 'clear_signature' });
  res.json({ ok: true, hasSignature: !!sig });
}));

router.get('/signature', auth.requireAuth, asyncHandler((req, res) => {
  const u = get('SELECT signature FROM users WHERE id = ?', req.user.id);
  res.json({ signature: u ? u.signature : null });
}));

module.exports = router;
