'use strict';

const express = require('express');
const { get } = require('../db');
const auth = require('../lib/auth');
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
    res.json({
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      roles: auth.rolesForUser(user.id),
    });
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
  res.json(req.user);
});

module.exports = router;
