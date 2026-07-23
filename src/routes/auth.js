'use strict';

const express = require('express');
const { get, run } = require('../db');
const auth = require('../lib/auth');
const permissions = require('../lib/permissions');
const audit = require('../lib/audit');
const { asyncHandler, require_ } = require('../lib/http');

const router = express.Router();

router.post(
  '/login',
  asyncHandler((req, res) => {
    require_(req.body, ['username', 'password']);
    const user = get('SELECT * FROM users WHERE username = ? AND active = 1', req.body.username);
    if (!user || !auth.verifyPassword(req.body.password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const { token, expires } = auth.createSession(user.id, req);
    res.cookie(auth.COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      expires: new Date(expires),
    });
    audit.record({ userId: user.id, entity: 'session', action: 'login' });
    const roles = auth.rolesForUser(user.id);
    res.json({
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roles,
      permissions: permissions.userPermissions(roles),
      mustChangePassword: !!user.must_change_password,
    });
  })
);

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
    if (String(req.body.new_password).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    require('../db').run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      auth.hashPassword(req.body.new_password), req.user.id);
    audit.record({ userId: req.user.id, entity: 'user', entityId: req.user.id, action: 'change_password' });
    res.json({ ok: true });
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
  res.json({ ...req.user, permissions: permissions.userPermissions(req.user.roles), hasSignature: !!(u && u.signature) });
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
