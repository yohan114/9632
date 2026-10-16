'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const auth = require('../lib/auth');
const { requireAuth, requireCap } = auth;
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const passwordPolicy = require('../lib/password_policy');
const rules = require('../lib/access_rules');
const workshops = require('../lib/workshops');
const storeLocs = require('../lib/store_locations');

// A password an admin types is a TEMPORARY one: the admin knows it, and so may whoever it was
// passed to on paper or over the phone. So it must still meet the rules (it is live until first
// use), and the account must replace it at first sign-in.
function checkAdminPassword(pw, username) {
  const why = passwordPolicy.problem(pw, { username });
  if (why) { const e = new Error(why); e.status = 400; throw e; }
}

const router = express.Router();

function userWithRoles(id) {
  const u = get('SELECT id, username, full_name, active, created_at, workshop_id FROM users WHERE id = ?', id);
  if (!u) return null;
  u.roles = auth.rolesForUser(id);
  try {
    u.store_locations = storeLocs.getUserStoreLocations(id);
  } catch (_) {
    u.store_locations = [];
  }
  return u;
}

// The roles being handed out must exist and be in use. A name that does not match used to be
// dropped without a word, so a typo gave the person less than the admin thought they had given.
function checkedRoleNames(roleNames) {
  if (roleNames == null) return [];
  if (!Array.isArray(roleNames)) { const e = new Error('roles must be a list'); e.status = 400; throw e; }
  const names = [...new Set(roleNames.map(String))];
  for (const name of names) {
    const role = get('SELECT active FROM roles WHERE name = ?', name);
    if (!role) { const e = new Error(`No role "${name}"`); e.status = 400; throw e; }
    if (role.active === 0) { const e = new Error(`The role "${name}" is retired`); e.status = 400; throw e; }
  }
  return names;
}

function setRoles(userId, roleNames) {
  run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const name of roleNames || []) {
    const role = get('SELECT id FROM roles WHERE name = ?', name);
    if (role) run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', userId, role.id);
  }
}

// Any signed-in user can read the role list (to populate pickers). Retired roles are not offered.
router.get('/roles', requireAuth, asyncHandler((_req, res) => res.json(
  all('SELECT id, name, label, description FROM roles WHERE COALESCE(active, 1) = 1 ORDER BY id'))));

router.get('/', requireCap('users.manage'), asyncHandler((_req, res) => {
  const users = all('SELECT id, username, full_name, active, created_at, mfa_enabled, workshop_id FROM users ORDER BY username');
  for (const u of users) {
    u.roles = auth.rolesForUser(u.id);
    try {
      u.store_locations = storeLocs.getUserStoreLocations(u.id);
    } catch (_) {
      u.store_locations = [];
    }
  }
  res.json(users);
}));

router.post('/', requireCap('users.manage'), asyncHandler((req, res) => {
  const b = req.body;
  require_(b, ['username', 'password']);
  if (get('SELECT id FROM users WHERE username = ?', b.username)) return res.status(409).json({ error: 'Username exists' });
  checkAdminPassword(b.password, b.username);
  const roles = checkedRoleNames(b.roles);
  rules.assertCanAssignRoles(req.user, roles);
  // Home workshop (Stage 2): the one chosen, else the default.
  const workshopId = workshops.forNew(null, b.workshop_id);
  const id = tx(() => {
    const info = run('INSERT INTO users (username, password_hash, full_name, active, must_change_password, workshop_id) VALUES (?, ?, ?, 1, 1, ?)',
      b.username, auth.hashPassword(b.password), b.full_name || null, workshopId);
    setRoles(info.lastInsertRowid, roles);
    return info.lastInsertRowid;
  });

  // Assign physical store location access if provided
  const storeId = toInt(b.store_location_id || b.store_id);
  if (storeId) {
    const isMain = roles.includes('main_storekeeper');
    const p = b.store_permissions || {};
    const perms = {
      can_view: p.can_view != null ? (p.can_view ? 1 : 0) : 1,
      can_receive: p.can_receive != null ? (p.can_receive ? 1 : 0) : 1,
      can_issue: p.can_issue != null ? (p.can_issue ? 1 : 0) : 1,
      can_dispatch: p.can_dispatch != null ? (p.can_dispatch ? 1 : 0) : (isMain ? 1 : 0),
      can_count: p.can_count != null ? (p.can_count ? 1 : 0) : 1,
      can_request: p.can_request != null ? (p.can_request ? 1 : 0) : 1
    };
    try {
      storeLocs.setUserStoreLocationAccess(id, storeId, perms, req.user);
    } catch (err) {
      console.warn('Initial store assignment warning:', err.message);
    }
  }

  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'create', after: { username: b.username, roles, workshop_id: workshopId, store_location_id: storeId } });
  res.status(201).json(userWithRoles(id));
}));

router.patch('/:id', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT id, username, full_name, active, workshop_id FROM users WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'User not found' });
  const b = req.body;
  rules.assertCanManageUser(req.user, id);
  if (b.active !== undefined && !b.active) rules.assertKeepsAnAdmin({ userId: id, deactivate: true });
  const sets = [];
  const params = [];
  const self = id === req.user.id;
  if (b.full_name !== undefined) { sets.push('full_name = ?'); params.push(b.full_name); }
  if (b.active !== undefined) { sets.push('active = ?'); params.push(b.active ? 1 : 0); }
  if (b.workshop_id !== undefined) { sets.push('workshop_id = ?'); params.push(workshops.mustBeActive(b.workshop_id).id); }
  if (b.password) {
    checkAdminPassword(b.password, before.username);
    sets.push('password_hash = ?'); params.push(auth.hashPassword(b.password));
    // A reset by an admin is a temporary password, exactly like a new account. An admin setting
    // their OWN password here is just a password change, and is not sent round the forced loop.
    if (!self) sets.push('must_change_password = 1');
  }
  let ended = 0;
  tx(() => {
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    // Whoever is signed in with the old password, or as an account that has just been switched
    // off, is signed out now rather than at the end of their 12-hour session.
    if (b.password || (b.active !== undefined && !b.active)) {
      ended = auth.revokeSessions(id, self ? { exceptToken: req.user.token } : {});
    }
  });
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'update', before,
    after: { ...userWithRoles(id), password_reset: !!b.password, sessions_ended: ended } });
  res.json(userWithRoles(id));
}));

router.post('/:id/roles', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM users WHERE id = ?', id)) return res.status(404).json({ error: 'User not found' });
  require_(req.body, ['roles']);
  const roles = checkedRoleNames(req.body.roles);
  rules.assertCanManageUser(req.user, id);
  // The account's existing roles were checked by assertCanManageUser; what is being ADDED must be
  // within the actor's reach too.
  const current = all('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', id).map((r) => r.name);
  rules.assertCanAssignRoles(req.user, roles.filter((r) => !current.includes(r)));
  rules.assertKeepsAnAdmin({ userId: id, newRoles: roles });
  rules.assertNotOwn(req.user, id);   // your roles are your access: someone else changes them (Part 2)
  tx(() => setRoles(id, roles));
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'set_roles', before: { roles: current }, after: { roles } });
  res.json(userWithRoles(id));
}));

// Someone lost or replaced their phone: take their two-factor sign-in off so they can enrol again.
// Signs them out everywhere. If their role requires it, they are asked to set it up at next sign-in.
router.post('/:id/mfa-reset', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const u = get('SELECT id, username, mfa_enabled FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  rules.assertCanManageUser(req.user, id);
  require('../lib/mfa').clear(id);
  const ended = auth.revokeSessions(id, id === req.user.id ? { exceptToken: req.user.token } : {});
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'mfa_reset',
    before: { mfa_enabled: !!u.mfa_enabled }, after: { mfa_enabled: false, sessions_ended: ended } });
  res.json(userWithRoles(id));
}));

// A person's signed-in sessions, and signing them out everywhere (a lost phone, a shared PC, someone
// leaving). The same "within your reach" rule as every other change to an account.
router.get('/:id/sessions', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  if (!get('SELECT id FROM users WHERE id = ?', id)) return res.status(404).json({ error: 'User not found' });
  rules.assertCanManageUser(req.user, id);
  res.json({ sessions: auth.listSessions(id, req.user.token) });
}));

router.post('/:id/sessions/revoke', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const u = get('SELECT id, username FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  rules.assertCanManageUser(req.user, id);
  const ended = auth.revokeSessions(id, id === req.user.id ? { exceptToken: req.user.token } : {});
  audit.record({ userId: req.user.id, entity: 'user', entityId: id, action: 'sessions_revoked', after: { ended } });
  res.json({ ok: true, ended });
}));

// List physical store locations with access flags for a user
router.get('/:id/stores', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const u = get('SELECT id, username, full_name FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  rules.assertCanManageUser(req.user, id);

  const allStores = storeLocs.listStoreLocations({ activeOnly: true });
  const userAccess = storeLocs.getUserStoreLocations(id);
  const accessMap = new Map(userAccess.map((a) => [Number(a.store_location_id), a]));

  const result = allStores.map((s) => {
    const a = accessMap.get(Number(s.id));
    return {
      store_id: s.id,
      store_code: s.code,
      store_name: s.name,
      store_type: s.store_type,
      workshop_id: s.workshop_id,
      has_access: !!a,
      can_view: a ? a.can_view : 0,
      can_receive: a ? a.can_receive : 0,
      can_issue: a ? a.can_issue : 0,
      can_dispatch: a ? a.can_dispatch : 0,
      can_count: a ? a.can_count : 0,
      can_request: a ? a.can_request : 0
    };
  });
  res.json({ user_id: id, username: u.username, full_name: u.full_name, stores: result });
}));

// Set or update store location access for a user
router.post('/:id/stores', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const u = get('SELECT id, username FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  rules.assertCanManageUser(req.user, id);

  const b = req.body;
  if (Array.isArray(b.stores)) {
    for (const item of b.stores) {
      const sId = toInt(item.store_id || item.store_location_id);
      if (!sId) continue;
      if (item.has_access || item.can_view || item.can_receive || item.can_issue) {
        storeLocs.setUserStoreLocationAccess(id, sId, {
          can_view: item.can_view ? 1 : 1,
          can_receive: item.can_receive ? 1 : 0,
          can_issue: item.can_issue ? 1 : 0,
          can_dispatch: item.can_dispatch ? 1 : 0,
          can_count: item.can_count ? 1 : 0,
          can_request: item.can_request ? 1 : 0
        }, req.user);
      } else {
        storeLocs.revokeUserStoreLocationAccess(id, sId, req.user);
      }
    }
  } else {
    const sId = toInt(b.store_id || b.store_location_id);
    if (!sId) return res.status(400).json({ error: 'store_location_id is required' });
    storeLocs.setUserStoreLocationAccess(id, sId, b, req.user);
  }
  res.json(userWithRoles(id));
}));

// Revoke a store location from a user
router.delete('/:id/stores/:storeId', requireCap('users.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const storeId = toInt(req.params.storeId);
  rules.assertCanManageUser(req.user, id);
  storeLocs.revokeUserStoreLocationAccess(id, storeId, req.user);
  res.json({ ok: true, revoked_store_id: storeId });
}));

module.exports = router;
