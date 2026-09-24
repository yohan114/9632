'use strict';

// Access Control — roles, what each role may do, and each role's section clearance.
//
//   GET  /matrix                 the clearance board (role × module level)
//   POST /matrix                 set one board cell
//   GET  /roles                  every role, with its permissions and how many people hold it
//   POST /roles                  create a role (optionally a copy of an existing one)
//   PATCH /roles/:name           rename / describe / retire / reinstate a role
//   GET  /capabilities           the permission catalogue and every role's grants
//   POST /capabilities           give or take away one permission from one role
//
// Every change is audited, and all of it is subject to src/lib/access_rules.js: you can only give
// what you hold, only an admin touches the admin role, and there is always an active admin.

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_ } = require('../lib/http');
const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');
const rules = require('../lib/access_rules');
const audit = require('../lib/audit');

const router = express.Router();

const bad = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

function roleRow(name) {
  return get('SELECT id, name, label, description, is_system, active, require_mfa, created_at FROM roles WHERE name = ?', name);
}

function describeRoles() {
  const holders = new Map(all(`SELECT r.name, COUNT(u.id) n FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id JOIN users u ON u.id = ur.user_id AND u.active = 1
      GROUP BY r.name`).map((r) => [r.name, r.n]));
  return all('SELECT name, label, description, is_system, active, require_mfa, created_at FROM roles ORDER BY active DESC, id')
    .map((r) => ({
      ...r,
      is_system: !!r.is_system,
      active: r.active !== 0,
      require_mfa: !!r.require_mfa,
      locked: r.name === 'admin',
      users: holders.get(r.name) || 0,
      caps: capabilities.capsForRole(r.name),
    }));
}

// A role's permanent key, from its label: "Site Storekeeper — Matara" → site_storekeeper_matara.
// Never one of the built-in names (it would silently inherit that role's seeded permissions), and
// never an existing role's.
function newRoleName(label) {
  const base = (label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role').slice(0, 40);
  let name = base;
  for (let i = 2; capabilities.RESERVED_ROLE_NAMES.has(name) || roleRow(name); i++) name = `${base}_${i}`;
  return name;
}

// ---- clearance board ------------------------------------------------------------------------

router.get('/matrix', requireCap('access.manage'), asyncHandler((_req, res) => res.json(permissions.getMatrix())));

// Set one cell (role × module → level). Admin row is locked (always full).
router.post('/matrix', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'module', 'level']);
  rules.assertCanSetLevel(req.user, req.body.module, req.body.level);
  const before = permissions.levelForRoles([req.body.role], req.body.module);
  const matrix = permissions.setPermission(req.body.role, req.body.module, req.body.level);
  audit.record({ userId: req.user.id, entity: 'role_permission', action: 'update',
    before: { role: req.body.role, module: req.body.module, level: before },
    after: { role: req.body.role, module: req.body.module, level: req.body.level } });
  res.json(matrix);
}));

// ---- roles ----------------------------------------------------------------------------------

router.get('/roles', requireCap('access.manage', 'users.manage'), asyncHandler((_req, res) => {
  const admins = rules.activeAdminIds().length;
  res.json({ roles: describeRoles(), active_admins: admins });
}));

router.post('/roles', requireCap('access.manage'), asyncHandler((req, res) => {
  const label = clean(req.body.label, 60);
  const description = clean(req.body.description, 300) || null;
  if (!label) bad(400, 'A role needs a name.');
  if (get('SELECT 1 x FROM roles WHERE LOWER(label) = LOWER(?)', label)) bad(409, `A role called "${label}" already exists.`);

  // Copying a role: its permissions and its clearance levels, all subject to "only what you hold".
  const from = req.body.clone_from ? String(req.body.clone_from) : null;
  let caps = [];
  let levels = {};
  if (from) {
    if (from === 'admin') bad(400, 'The admin role cannot be copied. Create a role and choose its permissions instead.');
    if (!roleRow(from)) bad(404, `No role "${from}" to copy.`);
    caps = capabilities.capsForRole(from);
    for (const m of permissions.MODULE_KEYS) levels[m] = permissions.levelForRoles([from], m);
    rules.assertCanGrantCaps(req.user, caps);
    for (const [m, lvl] of Object.entries(levels)) rules.assertCanSetLevel(req.user, m, lvl);
  }

  const name = newRoleName(label);
  tx(() => {
    run("INSERT INTO roles (name, label, description, is_system, active, created_at) VALUES (?, ?, ?, 0, 1, datetime('now'))", name, label, description);
    // Every capability gets an explicit row, granted or not, so the role's state is on record.
    for (const c of capabilities.CAP_KEYS) capabilities.setCapability(name, c, caps.includes(c));
    for (const m of permissions.MODULE_KEYS) {
      run('INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES (?, ?, ?)', name, m, levels[m] || 'none');
    }
  });
  audit.record({ userId: req.user.id, entity: 'role', action: 'create',
    after: { name, label, description, clone_from: from, caps } });
  res.status(201).json(describeRoles().find((r) => r.name === name));
}));

router.patch('/roles/:name', requireCap('access.manage'), asyncHandler((req, res) => {
  const role = roleRow(req.params.name);
  if (!role) bad(404, 'Role not found');
  // The admin role is fixed, with one exception: whether it requires two-factor sign-in.
  const keys = Object.keys(req.body || {});
  if (role.name === 'admin' && keys.some((k) => k !== 'require_mfa')) bad(400, 'The admin role cannot be changed.');
  const sets = [];
  const params = [];
  if (req.body.require_mfa !== undefined) {
    const on = !!req.body.require_mfa;
    // Asking for MORE proof at sign-in only tightens things, so whoever manages roles may switch it
    // on. Switching it OFF loosens every holder's sign-in, and is an admin's call.
    if (!on && !rules.isAdmin(req.user)) bad(403, 'Only an admin can stop a role requiring two-factor sign-in.');
    if (role.name === 'admin' && !rules.isAdmin(req.user)) bad(403, 'Only an admin can change this for the admin role.');
    sets.push('require_mfa = ?'); params.push(on ? 1 : 0);
  }
  if (req.body.label !== undefined) {
    const label = clean(req.body.label, 60);
    if (!label) bad(400, 'A role needs a name.');
    if (get('SELECT 1 x FROM roles WHERE LOWER(label) = LOWER(?) AND name <> ?', label, role.name)) bad(409, `A role called "${label}" already exists.`);
    sets.push('label = ?'); params.push(label);
  }
  if (req.body.description !== undefined) { sets.push('description = ?'); params.push(clean(req.body.description, 300) || null); }
  if (req.body.active !== undefined) {
    const active = !!req.body.active;
    if (!active) {
      // Retiring a role that people still hold would silently strip their access. Move them to
      // another role first — the screen shows how many hold it.
      const holders = get(`SELECT COUNT(*) n FROM user_roles ur JOIN users u ON u.id = ur.user_id
                            WHERE ur.role_id = ? AND u.active = 1`, role.id).n;
      if (holders) bad(409, `${holders} active user(s) still hold this role. Give them another role first.`);
    } else {
      // Reinstating brings back every permission the role holds, so the same "only what you
      // hold" rule applies as when those permissions were first given.
      rules.assertCanGrantCaps(req.user, capabilities.capsForRole(role.name));
    }
    sets.push('active = ?'); params.push(active ? 1 : 0);
  }
  if (sets.length) run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...params, role.id);
  audit.record({ userId: req.user.id, entity: 'role', entityId: role.id, action: 'update', before: role, after: roleRow(role.name) });
  res.json(describeRoles().find((r) => r.name === role.name));
}));

// ---- permissions ----------------------------------------------------------------------------

router.get('/capabilities', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json({
    capabilities: capabilities.CAPABILITIES.map(({ key, module, label, needs }) => ({ key, module, label, needs })),
    modules: permissions.MODULES,
    roles: describeRoles(),
  });
}));

router.post('/capabilities', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'capability']);
  const role = roleRow(req.body.role);
  if (!role) bad(404, 'Role not found');
  const granted = !!req.body.granted;
  if (granted) rules.assertCanGrantCaps(req.user, [req.body.capability]);
  const before = capabilities.capsForRole(role.name).includes(req.body.capability);
  capabilities.setCapability(role.name, req.body.capability, granted);
  audit.record({ userId: req.user.id, entity: 'role_capability', entityId: role.id, action: granted ? 'grant' : 'revoke',
    before: { role: role.name, capability: req.body.capability, granted: before },
    after: { role: role.name, capability: req.body.capability, granted } });
  res.json(describeRoles().find((r) => r.name === role.name));
}));

module.exports = router;
