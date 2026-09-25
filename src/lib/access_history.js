'use strict';

// ===========================================================================
// The History of access (access plan, Part 4): who changed whose access, when, and what changed.
//
// Every change to access is already in the audit log (src/lib/audit.js). This reads the part of it
// that is about access — levels, permissions, approval limits, roles, accounts and the access report
// — and says each change in plain words, with the person it was for and the section it touched, so
// the History tab on the Access Control page can filter by person or by section.
// ===========================================================================

const { all } = require('../db');
const permissions = require('./permissions');
const capabilities = require('./capabilities');
const limits = require('./approval_limits');

// The kinds of record that are about access, and — for accounts — which actions.
const ENTITIES = ['user_permission', 'user_capability', 'user_approval_limit', 'role', 'role_permission',
  'role_capability', 'approval_limit', 'user', 'access_report'];
const USER_ACTIONS = ['create', 'update', 'set_roles', 'mfa_reset', 'sessions_revoked', 'mfa_enabled', 'mfa_disabled'];
// Records whose entity_id is the person the change was for.
const FOR_PERSON = ['user_permission', 'user_capability', 'user_approval_limit', 'user'];

const LEVEL = { none: 'None', view: 'View', add: 'Add', edit: 'Edit', full: 'Full' };
const KIND_SECTION = { mrn_approve: 'stores', job_close: 'jobs' };

const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const lvl = (l) => LEVEL[l] || l || '—';
const until = (u) => (u ? ` until ${u}` : '');

function sectionOfModule(m) {
  const s = permissions.SECTIONS.find((x) => (x.modules || []).includes(m));
  return s ? s.key : null;
}

/** One audit row, in words: { what, sections } (sections: the section keys it touched). */
function describe(r, names) {
  const b = parse(r.before_json);
  const a = parse(r.after_json);
  const modLabel = (m) => { const x = permissions.MODULES.find((mm) => mm.key === m); return x ? x.label : m; };
  const capLabel = (k) => { const c = capabilities.get(k); return c ? c.label : k; };
  const kindLabel = (k) => (limits.KINDS[k] ? limits.KINDS[k].label : k);
  const roleName = (n) => names.roles.get(n) || n;
  const one = (what, sections) => ({ what, sections: sections.filter(Boolean) });
  switch (r.entity) {
    case 'user_permission': {
      if (r.action === 'set') return one(`${modLabel(a.module)}: ${lvl(a.level)}${until(a.until)}${b.level ? ` (was ${lvl(b.level)})` : ''}`, [sectionOfModule(a.module)]);
      if (r.action === 'clear') return one(`${modLabel(a.module)}: back to the role${b.level ? ` (was ${lvl(b.level)})` : ''}`, [sectionOfModule(a.module)]);
      const touched = Object.keys({ ...(b.levels || {}), ...(a.levels || {}) }).map(sectionOfModule)
        .concat(Object.keys({ ...(b.caps || {}), ...(a.caps || {}) }).map((k) => capabilities.sectionOf(k)))
        .concat(Object.keys(b.limits || {}).map((k) => KIND_SECTION[k]));
      if (r.action === 'reset') return one('Everything of their own back to the role', touched);
      if (r.action === 'copy') return one(`Copied the access of ${a.from_name || names.users.get(a.from) || 'another person'}`, touched);
      return one(`Levels changed (${r.action})`, touched);
    }
    case 'user_capability': {
      const k = a.capability || b.capability;
      if (r.action === 'give') return one(`Given: ${capLabel(k)}${until(a.until)}`, [capabilities.sectionOf(k)]);
      if (r.action === 'take') return one(`Taken away: ${capLabel(k)}${until(a.until)}`, [capabilities.sectionOf(k)]);
      return one(`Back to the role: ${capLabel(k)}`, [capabilities.sectionOf(k)]);
    }
    case 'user_approval_limit': {
      const k = a.kind || b.kind;
      if (a.max_amount == null) return one(`Own limit to "${kindLabel(k)}" removed: the role's limit again`, [KIND_SECTION[k]]);
      return one(`Own limit to "${kindLabel(k)}": ${limits.rs(a.max_amount)}${b.max_amount != null ? ` (was ${limits.rs(b.max_amount)})` : ''}`, [KIND_SECTION[k]]);
    }
    case 'role_permission':
      return one(`Role ${roleName(a.role)}: ${modLabel(a.module)} ${lvl(b.level)} → ${lvl(a.level)}`, [sectionOfModule(a.module)]);
    case 'role_capability':
      return one(`Role ${roleName(a.role)}: ${a.granted ? 'given' : 'taken away'} ${capLabel(a.capability)}`, [capabilities.sectionOf(a.capability)]);
    case 'approval_limit':
      return one(`Role ${roleName(a.role)}: limit to "${kindLabel(a.kind)}" ${a.max_amount == null ? 'removed (no limit)' : limits.rs(a.max_amount)}`, [KIND_SECTION[a.kind]]);
    case 'role': {
      if (r.action === 'create') return one(`Role "${a.label || a.name}" created${a.clone_from ? ` as a copy of ${roleName(a.clone_from)}` : ''}`, ['access']);
      const said = [];
      if (b.label !== a.label && a.label) said.push(`renamed "${b.label || b.name}" → "${a.label}"`);
      if (b.active !== a.active && a.active != null) said.push(a.active ? 'brought back' : 'retired');
      if (b.require_mfa !== a.require_mfa && a.require_mfa != null) said.push(a.require_mfa ? 'now needs 2-step sign-in' : 'no longer needs 2-step sign-in');
      if (b.description !== a.description && a.description !== undefined && !said.length) said.push('description changed');
      return one(`Role ${roleName(a.name || b.name)}: ${said.join(', ') || 'changed'}`, ['access']);
    }
    case 'user': {
      const roles = (list) => (list || []).map(roleName).join(', ') || 'no role';
      if (r.action === 'create') return one(`Account created (roles: ${roles(a.roles)})`, ['access']);
      if (r.action === 'set_roles') return one(`Roles: ${roles(b.roles)} → ${roles(a.roles)}`, ['access']);
      if (r.action === 'mfa_reset') return one('2-step sign-in reset', ['access']);
      if (r.action === 'sessions_revoked') return one('Signed out of every device', ['access']);
      if (r.action === 'mfa_enabled') return one('2-step sign-in turned on', ['access']);
      if (r.action === 'mfa_disabled') return one('2-step sign-in turned off', ['access']);
      const said = [];
      if (a.password_reset) said.push('password reset');
      if (b.active != null && a.active != null && !!b.active !== !!a.active) said.push(a.active ? 'account switched on' : 'account switched off');
      if (b.workshop_id != null && a.workshop_id != null && b.workshop_id !== a.workshop_id) said.push('home workshop changed');
      if (b.full_name !== undefined && a.full_name !== undefined && b.full_name !== a.full_name) said.push('name changed');
      return one(said.length ? said[0][0].toUpperCase() + said.join(', ').slice(1) : 'Account changed', ['access']);
    }
    case 'access_report':
      return one(`Access report downloaded (${a.format === 'xlsx' ? 'Excel' : 'PDF'})`, ['access']);
    default:
      return one(`${r.entity} ${r.action}`, []);
  }
}

/**
 * The history, newest first. Filters: `person` (changes for them, or made by them), `section` (a
 * section key), `before` (an audit id, for the next page). Returns { rows, more }.
 */
function history({ person = null, section = null, before = null, limit = 100 } = {}) {
  const names = {
    users: new Map(all("SELECT id, COALESCE(NULLIF(full_name, ''), username) n FROM users").map((u) => [u.id, u.n])),
    roles: new Map(all("SELECT name, COALESCE(NULLIF(label, ''), name) l FROM roles").map((x) => [x.name, x.l])),
  };
  const where = [`al.entity IN (${ENTITIES.map(() => '?').join(',')})`,
    `(al.entity <> 'user' OR al.action IN (${USER_ACTIONS.map(() => '?').join(',')}))`];
  const params = [...ENTITIES, ...USER_ACTIONS];
  if (person) {
    where.push(`(al.user_id = ? OR (al.entity_id = ? AND al.entity IN (${FOR_PERSON.map(() => '?').join(',')})))`);
    params.push(person, person, ...FOR_PERSON);
  }
  if (before) { where.push('al.id < ?'); params.push(before); }
  const out = [];
  let more = false;
  // With a section filter some rows are skipped, so read in pages until there are enough.
  let cursor = null;
  for (let page = 0; page < 20 && out.length <= limit; page++) {
    const rows = all(`SELECT al.* FROM audit_log al WHERE ${where.join(' AND ')}${cursor ? ' AND al.id < ?' : ''}
                      ORDER BY al.id DESC LIMIT 500`, ...params, ...(cursor ? [cursor] : []));
    if (!rows.length) break;
    for (const r of rows) {
      const d = describe(r, names);
      if (section && !d.sections.includes(section)) continue;
      if (out.length === limit) { more = true; break; }
      out.push({
        id: r.id, at: r.created_at, by: r.user_id, by_name: names.users.get(r.user_id) || (r.user_id ? `#${r.user_id}` : 'System'),
        person: FOR_PERSON.includes(r.entity) ? r.entity_id : null,
        person_name: FOR_PERSON.includes(r.entity) ? (names.users.get(r.entity_id) || `#${r.entity_id}`) : null,
        entity: r.entity, action: r.action, what: d.what, sections: d.sections,
      });
    }
    if (more || rows.length < 500) break;
    cursor = rows[rows.length - 1].id;
  }
  return { rows: out, more };
}

module.exports = { ENTITIES, USER_ACTIONS, describe, history };
