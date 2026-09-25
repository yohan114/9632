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
//   GET  /approval-limits        each role's money limit per kind of approval
//   PUT  /approval-limits        set or clear one role's limit (src/lib/approval_limits.js)
//   GET  /people                 everyone, with how many of their settings are their own
//   GET  /people/:id             one person: levels, permissions, approval limits and workshop
//   PUT  /people/:id/levels      set one switch's level for this person (optionally until a date), or clear it
//   PUT  /people/:id/caps        give or take away one permission (optionally until a date), or clear it
//   PUT  /people/:id/limits      set or clear this person's own approval limit for one kind
//   POST /people/:id/reset       clear everything of their own (back to their roles)
//   POST /people/:id/copy        give them another person's levels and permissions
//   GET  /history                who changed whose access, when, and what (by person, by section)
//   GET  /overview               everyone × every section: the Sections view
//   GET  /report.xlsx|.html      the access report, as Excel or a page to print or save as PDF
//
// Every change is audited, and all of it is subject to src/lib/access_rules.js: you can only give
// what you hold, only an admin touches the admin role, and there is always an active admin. Every
// change also needs 2-step sign-in (auth.secondFactorToChange, where this router is mounted).

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

// ---- people: access person by person (access plan, Parts 2 and 3) ------------------------------
// A role is the starting template. On the People screen a person can be given, on any switch, a
// level of their own — more or less than their roles give — and a permission their roles do not
// give, or have one taken away. Either can end on a date. A person can also have their own approval
// limit, and see their own workshop only or all of them. The rules: only what you hold yourself,
// only for someone whose access is within yours, never an admin's (always full), never your own.

const limits = require('../lib/approval_limits');
const userRow = (id) => get('SELECT id, username, full_name, active, workshop_id FROM users WHERE id = ?', id);
const rolesOf = (id) => require('../lib/auth').rolesForUser(id);
const personOf = (id) => ({ id: Number(id), roles: rolesOf(id) });
const nameOf = (id) => { const u = userRow(id); return u ? (u.full_name || u.username) : ''; };

/** Why this actor may not change this person's access, or null. */
function blockedFor(actor, target) {
  if (Number(actor.id) === Number(target.id)) return 'You cannot change your own access. Ask another manager or an admin.';
  if (target.roles.includes('admin')) return 'An admin always has full access to everything.';
  try { rules.assertCanManageUser(actor, target.id); } catch (e) { return e.message; }
  return null;
}

function describePerson(actor, id) {
  const u = userRow(id);
  if (!u) bad(404, 'No such person');
  const person = personOf(id);
  const isAdmin = person.roles.includes('admin');
  const labels = new Map(all('SELECT name, COALESCE(label, name) label FROM roles').map((r) => [r.name, r.label]));
  const names = new Map(all('SELECT id, COALESCE(full_name, username) n FROM users').map((r) => [r.id, r.n]));
  const by = (p) => ({ ...p, set_by_name: names.get(p.set_by) || null });
  const levelsAll = permissions.personalFor(id, { ended: true });
  const capsAll = capabilities.personalCapsFor(id, { ended: true });
  const modLabel = new Map(permissions.MODULES.map((m) => [m.key, m.label]));
  const blocked = blockedFor(actor, person);
  const caps = capabilities.capsForUser(person);
  const ownLimits = limits.personalFor(id);
  const ws = require('../lib/workshops');
  const scope = require('../lib/scope');
  const home = ws.byId(ws.homeOf({ id }));
  return {
    user: { ...u, active: !!u.active, roles: person.roles.map((r) => ({ name: r, label: labels.get(r) || r })), is_admin: isAdmin,
      caps, role_caps: capabilities.capsForRoles(person.roles) },
    sections: permissions.SECTIONS, modules: permissions.MODULES, levels: permissions.LEVELS,
    capabilities: capabilities.CAPABILITIES.map(({ key, module, label, needs }) => ({ key, module, label, needs, section: capabilities.sectionOf(key) })),
    role_levels: permissions.userPermissions(person.roles),
    personal: Object.fromEntries(Object.entries(levelsAll).filter(([, p]) => !p.ended).map(([m, p]) => [m, by(p)])),
    personal_caps: Object.fromEntries(Object.entries(capsAll).filter(([, p]) => !p.ended).map(([k, p]) => [k, by(p)])),
    // Changes whose last day has passed: no longer applied, shown so nobody wonders where they went.
    ended: [
      ...Object.entries(levelsAll).filter(([, p]) => p.ended).map(([m, p]) => ({ type: 'level', key: m, label: modLabel.get(m) || m, value: p.level, until: p.until })),
      ...Object.entries(capsAll).filter(([, p]) => p.ended).map(([k, p]) => ({ type: 'cap', key: k, label: capabilities.get(k).label, value: p.granted ? 'given' : 'taken away', until: p.until })),
    ],
    effective: permissions.userLevels(person),
    limits: limits.KIND_KEYS.map((k) => ({ key: k, label: limits.KINDS[k].label, measure: limits.KINDS[k].measure,
      gives: isAdmin || limits.gives(person, k), role_limit: limits.roleLimitFor(person, k),
      own: ownLimits[k] ? by(ownLimits[k]) : null, effective: limits.limitFor(person, k) })),
    workshop: { home: home ? { id: home.id, name: home.name } : null, all: isAdmin || caps.includes('workshops.all'),
      separate: scope.enabled(), multi: ws.isMulti() },
    can: {
      edit: !blocked, reason: blocked,
      // The highest level this actor may give on each switch: their own (an admin: full).
      max: Object.fromEntries(permissions.MODULE_KEYS.map((m) => [m, permissions.levelFor(actor, m)])),
      // The permissions this actor may give (their own), and their own approval limits.
      caps: rules.isAdmin(actor) ? capabilities.CAP_KEYS : require('../lib/auth').capsOf(actor),
      limits: Object.fromEntries(limits.KIND_KEYS.map((k) => [k, { gives: rules.isAdmin(actor) || limits.gives(actor, k), max: limits.limitFor(actor, k) }])),
    },
  };
}

function mayChange(actor, id) {
  if (!userRow(id)) bad(404, 'No such person');
  const why = blockedFor(actor, personOf(id));
  if (why) bad(403, why);
}

// Money stays within the actor's own limit: run inside the change's transaction, after the write,
// so a change that would lift the person above it is undone.
function keepWithinLimits(actor, id) {
  const over = limits.outsideLimits(actor, personOf(id));
  if (over) bad(403, `This would give them ${over.text}. Set their approval limit first, up to ${limits.rs(over.mine)}.`);
}

const levelsOnly = (map) => Object.fromEntries(Object.entries(map).map(([m, p]) => [m, p.until ? `${p.level} until ${p.until}` : p.level]));
const capsOnly = (map) => Object.fromEntries(Object.entries(map).map(([k, p]) => [k, (p.granted ? 'give' : 'take away') + (p.until ? ` until ${p.until}` : '')]));

router.get('/people', requireCap('access.manage'), asyncHandler((req, res) => {
  const count = (sql) => {
    const out = new Map();
    const now = permissions.today();
    for (const r of all(sql, now)) out.set(r.user_id, (out.get(r.user_id) || 0) + r.n);
    return out;
  };
  const lv = count('SELECT user_id, COUNT(*) n FROM user_permissions WHERE until IS NULL OR until >= ? GROUP BY user_id');
  const cp = count('SELECT user_id, COUNT(*) n FROM user_capabilities WHERE until IS NULL OR until >= ? GROUP BY user_id');
  const lm = new Map(all('SELECT user_id, COUNT(*) n FROM user_approval_limits GROUP BY user_id').map((r) => [r.user_id, r.n]));
  res.json(all('SELECT id, username, full_name, active FROM users ORDER BY active DESC, COALESCE(full_name, username)')
    .map((u) => ({ ...u, active: !!u.active, roles: rolesOf(u.id), self: u.id === req.user.id,
      own_levels: (lv.get(u.id) || 0) + (cp.get(u.id) || 0) + (lm.get(u.id) || 0) })));
}));

router.get('/people/:id', requireCap('access.manage'), asyncHandler((req, res) => res.json(describePerson(req.user, Number(req.params.id)))));

// One switch's level for this person, optionally until a date; level null clears it (back to the role).
router.put('/people/:id/levels', requireCap('access.manage'), asyncHandler((req, res) => {
  const id = Number(req.params.id);
  require_(req.body, ['module']);
  mayChange(req.user, id);
  const level = req.body.level === null || req.body.level === undefined || req.body.level === '' ? null : String(req.body.level);
  if (level) rules.assertCanSetLevel(req.user, req.body.module, level);
  const before = permissions.personalFor(id)[req.body.module] || null;
  const until = level ? permissions.cleanUntil(req.body.until) : null;
  permissions.setPersonal(id, req.body.module, level, req.user.id, until);
  audit.record({ userId: req.user.id, entity: 'user_permission', entityId: id, action: level ? 'set' : 'clear',
    before: { module: req.body.module, level: before ? before.level : null, until: before ? before.until : null },
    after: { module: req.body.module, level, until } });
  res.json(describePerson(req.user, id));
}));

// One permission for this person: state 'give', 'take' (away), or 'role' (clear: back to their roles).
router.put('/people/:id/caps', requireCap('access.manage'), asyncHandler((req, res) => {
  const id = Number(req.params.id);
  require_(req.body, ['capability', 'state']);
  mayChange(req.user, id);
  const cap = String(req.body.capability);
  if (!capabilities.isCapability(cap)) bad(400, `Unknown permission: ${cap}`);
  const state = String(req.body.state);
  if (!['give', 'take', 'role'].includes(state)) bad(400, 'Choose give, take or role.');
  let granted = state === 'give' ? true : state === 'take' ? false : null;
  const until = granted === null ? null : permissions.cleanUntil(req.body.until);
  // The same as their roles is nothing of their own (with an end date too: after it, the same again).
  if (granted !== null && granted === capabilities.capsForRoles(rolesOf(id)).includes(cap)) granted = null;
  if (granted === true) rules.assertCanGrantCaps(req.user, [cap]);
  const before = capabilities.personalCapsFor(id)[cap] || null;
  tx(() => {
    capabilities.setPersonalCap(id, cap, granted, req.user.id, until);
    keepWithinLimits(req.user, id);
  });
  audit.record({ userId: req.user.id, entity: 'user_capability', entityId: id, action: granted === null ? 'clear' : granted ? 'give' : 'take',
    before: { capability: cap, granted: before ? before.granted : null, until: before ? before.until : null },
    after: { capability: cap, granted, until } });
  res.json(describePerson(req.user, id));
}));

// This person's own approval limit for one kind; empty clears it (back to their roles' limit).
router.put('/people/:id/limits', requireCap('access.manage'), asyncHandler((req, res) => {
  const id = Number(req.params.id);
  require_(req.body, ['kind']);
  mayChange(req.user, id);
  let change;
  tx(() => {
    change = limits.setPersonalLimit(req.user, id, String(req.body.kind), req.body.max_amount);
    keepWithinLimits(req.user, id);
  });
  audit.record({ userId: req.user.id, entity: 'user_approval_limit', entityId: id, action: change.after.max_amount == null ? 'clear' : 'set',
    before: change.before, after: change.after });
  res.json(describePerson(req.user, id));
}));

// Everything of their own goes: levels, permissions and approval limits. Their roles decide again.
router.post('/people/:id/reset', requireCap('access.manage'), asyncHandler((req, res) => {
  const id = Number(req.params.id);
  mayChange(req.user, id);
  const before = { levels: levelsOnly(permissions.personalFor(id, { ended: true })), caps: capsOnly(capabilities.personalCapsFor(id, { ended: true })),
    limits: Object.fromEntries(Object.entries(limits.personalFor(id)).map(([k, p]) => [k, p.max_amount])) };
  tx(() => {
    run('DELETE FROM user_permissions WHERE user_id = ?', id);
    run('DELETE FROM user_capabilities WHERE user_id = ?', id);
    run('DELETE FROM user_approval_limits WHERE user_id = ?', id);
    keepWithinLimits(req.user, id);
  });
  audit.record({ userId: req.user.id, entity: 'user_permission', entityId: id, action: 'reset', before, after: {} });
  res.json(describePerson(req.user, id));
}));

// Give this person another person's access: section by section and permission by permission. Where
// it matches this person's own roles nothing is stored; where it differs, a setting of their own —
// with the same end date where the other person's has one. Approval limits are not copied.
router.post('/people/:id/copy', requireCap('access.manage'), asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const from = Number(req.body && req.body.from);
  mayChange(req.user, id);
  if (!userRow(from)) bad(404, 'No such person to copy from');
  if (from === id) bad(400, 'Choose another person to copy from.');
  const source = personOf(from);
  if (source.roles.includes('admin')) bad(400, 'An admin has everything. Choose someone else to copy from.');
  const levels = permissions.userLevels(source);
  const levelUntil = permissions.personalFor(from);
  const template = permissions.userPermissions(rolesOf(id));
  const theirCaps = new Set(capabilities.capsForUser(source));
  const capUntil = capabilities.personalCapsFor(from);
  const roleCaps = new Set(capabilities.capsForRoles(rolesOf(id)));
  for (const [m, lvl] of Object.entries(levels)) if (lvl !== template[m]) rules.assertCanSetLevel(req.user, m, lvl);
  rules.assertCanGrantCaps(req.user, [...theirCaps].filter((c) => !roleCaps.has(c)));
  const before = { levels: levelsOnly(permissions.personalFor(id, { ended: true })), caps: capsOnly(capabilities.personalCapsFor(id, { ended: true })) };
  tx(() => {
    run('DELETE FROM user_permissions WHERE user_id = ?', id);
    run('DELETE FROM user_capabilities WHERE user_id = ?', id);
    for (const [m, lvl] of Object.entries(levels)) {
      if (lvl !== template[m]) permissions.setPersonal(id, m, lvl, req.user.id, levelUntil[m] ? levelUntil[m].until : null);
    }
    for (const c of capabilities.CAP_KEYS) {
      if (theirCaps.has(c) !== roleCaps.has(c)) capabilities.setPersonalCap(id, c, theirCaps.has(c), req.user.id, capUntil[c] ? capUntil[c].until : null);
    }
    keepWithinLimits(req.user, id);
  });
  audit.record({ userId: req.user.id, entity: 'user_permission', entityId: id, action: 'copy',
    before, after: { from, from_name: nameOf(from), levels: levelsOnly(permissions.personalFor(id)), caps: capsOnly(capabilities.personalCapsFor(id)) } });
  res.json(describePerson(req.user, id));
}));

// ---- History: who changed whose access, when, and what (access plan, Part 4) ---------------------

router.get('/history', requireCap('access.manage'), asyncHandler((req, res) => {
  const num = (v) => (Number(v) > 0 ? Number(v) : null);
  const section = req.query.section && permissions.SECTIONS.some((s) => s.key === req.query.section) ? String(req.query.section) : null;
  res.json(require('../lib/access_history').history({
    person: num(req.query.person), section, before: num(req.query.before), limit: Math.min(num(req.query.limit) || 100, 500),
  }));
}));

// ---- everyone at once: the Sections view and the access report (access plan, Part 3) ------------

router.get('/overview', requireCap('access.manage'), asyncHandler((_req, res) => res.json(require('../lib/access_overview').overview())));

router.get('/report.xlsx', requireCap('access.manage'), asyncHandler(async (req, res) => {
  const report = require('../lib/access_overview');
  audit.record({ userId: req.user.id, entity: 'access_report', action: 'download', after: { format: 'xlsx' }, notify: false });
  await require('../lib/export').sendXlsx(res, `access-report-${permissions.today()}.xlsx`, report.sheets(report.overview()));
}));

router.get('/report.html', requireCap('access.manage'), asyncHandler((req, res) => {
  const report = require('../lib/access_overview');
  audit.record({ userId: req.user.id, entity: 'access_report', action: 'download', after: { format: 'print' }, notify: false });
  res.type('html').send(report.printPage(report.overview(), req.user));
}));

// ---- approval limits (src/lib/approval_limits.js) ------------------------------------------

router.get('/approval-limits', requireCap('access.manage'), asyncHandler((_req, res) => {
  res.json(require('../lib/approval_limits').listForScreen());
}));

router.put('/approval-limits', requireCap('access.manage'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'kind']);
  const limits = require('../lib/approval_limits');
  const saved = limits.setLimit(req.user, req.body.role, req.body.kind, req.body.max_amount);
  res.json({ saved, ...limits.listForScreen() });
}));

module.exports = router;
