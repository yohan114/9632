'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const auth = require('../lib/auth');
const { requireAuth, requireRole } = auth;
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');

const router = express.Router();

function userWithRoles(id) {
  const u = get('SELECT id, username, full_name, active, created_at FROM users WHERE id = ?', id);
  if (!u) return null;
  u.roles = auth.rolesForUser(id);
  return u;
}

function setRoles(userId, roleNames) {
  run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const name of roleNames || []) {
    const role = get('SELECT id FROM roles WHERE name = ?', name);
    if (role) run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', userId, role.id);
  }
}

// Any signed-in user can read the role list (to populate pickers).
router.get('/roles', requireAuth, asyncHandler((_req, res) => res.json(all('SELECT id, name, label FROM roles ORDER BY id'))));

router.get('/', requireRole('admin'), asyncHandler((_req, res) => {
  const users = all('SELECT id, username, full_name, active, created_at FROM users ORDER BY username');
  for (const u of users) u.roles = auth.rolesForUser(u.id);
  res.json(users);
}));

router.post('/', requireRole('admin'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['username', 'password']);
  if (get('SELECT id FROM users WHERE username = ?', b.username)) return res.status(409).json({ error: 'Username exists' });
  const id = tx(() => {
    const info = run('INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
      b.username, auth.hashPassword(b.password), b.full_name || null);
    setRoles(info.lastInsertRowid, b.roles);
    return info.lastInsertRowid;
  });
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'create', after: { username: b.username } });
  res.status(201).json(userWithRoles(id));
}));

router.patch('/:id', requireRole('admin'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT id, username, full_name, active FROM users WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'User not found' });
  const b = req.body;
  const sets = [];
  const params = [];
  if (b.full_name !== undefined) { sets.push('full_name = ?'); params.push(b.full_name); }
  if (b.active !== undefined) { sets.push('active = ?'); params.push(b.active ? 1 : 0); }
  if (b.password) { sets.push('password_hash = ?'); params.push(auth.hashPassword(b.password)); }
  if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'update', before, after: userWithRoles(id) });
  res.json(userWithRoles(id));
}));

router.post('/:id/roles', requireRole('admin'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM users WHERE id = ?', id)) return res.status(404).json({ error: 'User not found' });
  require_(req.body, ['roles']);
  tx(() => setRoles(id, req.body.roles));
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'set_roles', after: { roles: req.body.roles } });
  res.json(userWithRoles(id));
}));

module.exports = router;
