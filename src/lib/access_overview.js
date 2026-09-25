'use strict';

// ===========================================================================
// Everyone's access at once (access plan, Part 3).
//
// One table of every person: their level on each section switch, the permissions they hold, their
// approval limits and their workshop, and which of those were set for them personally. It feeds the
// Sections view on the Access Control page (pick a section, see who reaches it) and the access
// report, as Excel or as a page to print or save as PDF, to sign and file.
// ===========================================================================

const { all } = require('../db');
const permissions = require('./permissions');
const capabilities = require('./capabilities');
const limits = require('./approval_limits');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WORD = { none: 'None', view: 'View', add: 'Add', edit: 'Edit', full: 'Full' };
const LETTER = { none: '—', view: 'V', add: 'A', edit: 'E', full: 'F' };

/** The columns: one per switch, grouped under its section; Workshops and Access Control by permission. */
function columns() {
  const mods = new Map(permissions.MODULES.map((m) => [m.key, m]));
  const out = [];
  for (const s of permissions.SECTIONS) {
    if (s.always) continue;
    if (s.special) { out.push({ section: s.key, sectionLabel: s.label, special: s.special, label: s.label }); continue; }
    const parts = s.modules.filter((m) => mods.has(m));
    for (const m of parts) {
      out.push({ section: s.key, sectionLabel: s.label, module: m,
        label: parts.length > 1 ? mods.get(m).label.split(' · ').pop() : s.label });
    }
  }
  return out;
}

function overview() {
  const roleLabel = new Map(all('SELECT name, COALESCE(NULLIF(label, \'\'), name) label FROM roles').map((r) => [r.name, r.label]));
  const names = new Map(all('SELECT id, COALESCE(NULLIF(full_name, \'\'), username) n FROM users').map((r) => [r.id, r.n]));
  const wsName = new Map(all('SELECT id, name FROM workshops').map((w) => [w.id, w.name]));
  const ws = require('./workshops');
  const people = all('SELECT id, username, full_name, active FROM users ORDER BY active DESC, COALESCE(NULLIF(full_name, \'\'), username)')
    .map((u) => {
      const roles = require('./auth').rolesForUser(u.id);
      const person = { id: u.id, roles };
      const isAdmin = roles.includes('admin');
      const caps = capabilities.capsForUser(person);
      const ownLevels = isAdmin ? {} : permissions.personalFor(u.id);
      const ownCaps = isAdmin ? {} : capabilities.personalCapsFor(u.id);
      const ownLimits = isAdmin ? {} : limits.personalFor(u.id);
      const by = (p) => ({ ...p, set_by_name: names.get(p.set_by) || null });
      return {
        id: u.id, username: u.username, name: u.full_name || u.username, active: !!u.active, is_admin: isAdmin,
        roles: roles.map((r) => roleLabel.get(r) || r),
        levels: permissions.userLevels(person),
        own: Object.fromEntries(Object.entries(ownLevels).map(([m, p]) => [m, by(p)])),
        caps,
        own_caps: Object.fromEntries(Object.entries(ownCaps).map(([k, p]) => [k, by(p)])),
        limits: Object.fromEntries(limits.KIND_KEYS.filter((k) => isAdmin || limits.gives(person, k)).map((k) => [k, limits.limitFor(person, k)])),
        own_limits: Object.fromEntries(Object.entries(ownLimits).map(([k, p]) => [k, by(p)])),
        workshop: wsName.get(ws.homeOf({ id: u.id })) || '',
        all_workshops: isAdmin || caps.includes('workshops.all'),
      };
    });
  return {
    date: permissions.today(),
    sections: permissions.SECTIONS,
    modules: permissions.MODULES,
    columns: columns(),
    capabilities: capabilities.CAPABILITIES.map(({ key, module, label }) => ({ key, module, label, section: capabilities.sectionOf(key) })),
    kinds: limits.KIND_KEYS.map((k) => ({ key: k, label: limits.KINDS[k].label })),
    people,
  };
}

// ---- what one cell says ------------------------------------------------------------------------

const opens = (p, col) => p.is_admin || col.special.some((c) => p.caps.includes(c));
const limitText = (p, k) => (!(k in p.limits) ? '' : p.limits[k] == null ? 'No limit' : limits.rs(p.limits[k]));

/** Every setting made for one person, in words: [{ person, section, what, setting, until, by, on }]. */
function changes(ov) {
  const capByKey = new Map(ov.capabilities.map((c) => [c.key, c]));
  const secLabel = new Map(ov.sections.map((s) => [s.key, s.label]));
  const modLabel = new Map(ov.modules.map((m) => [m.key, m.label]));
  const kindLabel = new Map(ov.kinds.map((k) => [k.key, k.label]));
  const out = [];
  for (const p of ov.people) {
    for (const [m, o] of Object.entries(p.own)) {
      out.push({ person: p.name, section: modLabel.get(m) || m, what: 'Level', setting: WORD[o.level], until: o.until || '', by: o.set_by_name || '', on: String(o.set_at || '').slice(0, 10) });
    }
    for (const [k, o] of Object.entries(p.own_caps)) {
      const c = capByKey.get(k);
      out.push({ person: p.name, section: secLabel.get(c.section) || '', what: c.label, setting: o.granted ? 'Given' : 'Taken away', until: o.until || '', by: o.set_by_name || '', on: String(o.set_at || '').slice(0, 10) });
    }
    for (const [k, o] of Object.entries(p.own_limits)) {
      out.push({ person: p.name, section: 'Approval limit', what: kindLabel.get(k), setting: limits.rs(o.max_amount), until: '', by: o.set_by_name || '', on: String(o.set_at || '').slice(0, 10) });
    }
  }
  return out;
}

// ---- Excel ---------------------------------------------------------------------------------------

function sheets(ov) {
  const cols = ov.columns;
  const people = ov.people.filter((p) => p.active);
  const access = {
    name: 'Access',
    columns: [
      { header: 'Name', key: 'name', width: 24 }, { header: 'Username', key: 'username', width: 16 },
      { header: 'Roles', key: 'roles', width: 30 }, { header: 'Workshop', key: 'workshop', width: 22 },
      { header: 'Sees', key: 'sees', width: 14 },
      ...cols.map((c, i) => ({ header: c.module && c.label !== c.sectionLabel ? `${c.sectionLabel} · ${c.label}` : c.label, key: 'c' + i, width: 14 })),
      ...ov.kinds.map((k) => ({ header: `Limit: ${k.label}`, key: 'l_' + k.key, width: 18 })),
      { header: 'Own changes', key: 'own', width: 12 },
    ],
    rows: people.map((p) => {
      const row = { name: p.name, username: p.username, roles: p.roles.join(', '), workshop: p.workshop,
        sees: p.all_workshops ? 'All workshops' : 'Own workshop',
        own: Object.keys(p.own).length + Object.keys(p.own_caps).length + Object.keys(p.own_limits).length };
      cols.forEach((c, i) => {
        if (c.special) { row['c' + i] = opens(p, c) ? 'Yes' : 'No'; return; }
        const o = p.own[c.module];
        row['c' + i] = WORD[p.levels[c.module]] + (o ? (o.until ? ` (own, until ${o.until})` : ' (own)') : '');
      });
      for (const k of ov.kinds) row['l_' + k.key] = limitText(p, k.key) + (p.own_limits[k.key] ? ' (own)' : '');
      return row;
    }),
  };
  const own = {
    name: 'Own changes',
    columns: [
      { header: 'Person', key: 'person', width: 24 }, { header: 'Section', key: 'section', width: 24 },
      { header: 'What', key: 'what', width: 44 }, { header: 'Setting', key: 'setting', width: 14 },
      { header: 'Until', key: 'until', width: 12 }, { header: 'Set by', key: 'by', width: 20 }, { header: 'Set on', key: 'on', width: 12 },
    ],
    rows: changes({ ...ov, people }),
  };
  const secLabel = new Map(ov.sections.map((s) => [s.key, s.label]));
  const perms = {
    name: 'Permissions',
    columns: [
      { header: 'Person', key: 'person', width: 24 }, { header: 'Section', key: 'section', width: 24 },
      { header: 'Permission', key: 'permission', width: 60 }, { header: 'From', key: 'from', width: 14 },
    ],
    rows: people.filter((p) => !p.is_admin).flatMap((p) => ov.capabilities.filter((c) => p.caps.includes(c.key)).map((c) => ({
      person: p.name, section: secLabel.get(c.section) || '', permission: c.label, from: p.own_caps[c.key] ? 'Own' : 'Role',
    }))),
  };
  return [access, own, perms];
}

// ---- a page to print or save as PDF -------------------------------------------------------------

function printPage(ov, user) {
  const cols = ov.columns;
  const people = ov.people.filter((p) => p.active);
  const groups = [];
  for (const c of cols) {
    const g = groups[groups.length - 1];
    if (g && g.section === c.section) g.n++; else groups.push({ section: c.section, label: c.sectionLabel, n: 1 });
  }
  const cell = (p, c) => {
    if (c.special) return `<td class="c">${opens(p, c) ? 'Yes' : '—'}</td>`;
    const o = p.own[c.module];
    const lvl = p.levels[c.module];
    return `<td class="c${o ? ' own' : ''}${lvl === 'none' ? ' no' : ''}" ${o && o.until ? `title="until ${esc(o.until)}"` : ''}>${LETTER[lvl]}${o ? '*' : ''}</td>`;
  };
  const rows = people.map((p) => `<tr><td class="n"><b>${esc(p.name)}</b><br><span class="m">${esc(p.roles.join(', ') || 'no role')}</span></td>
    <td class="m${p.own_caps['workshops.all'] ? ' own' : ''}">${esc(p.all_workshops ? 'All' : p.workshop)}${p.own_caps['workshops.all'] ? '*' : ''}</td>${cols.map((c) => cell(p, c)).join('')}
    ${ov.kinds.map((k) => `<td class="r${p.own_limits[k.key] ? ' own' : ''}">${esc(limitText(p, k.key))}${p.own_limits[k.key] ? '*' : ''}</td>`).join('')}</tr>`).join('');
  const list = changes({ ...ov, people });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Access report ${esc(ov.date)}</title>
<style>
  @page{size:A4 landscape;margin:8mm} body{font-family:Arial,sans-serif;color:#000;font-size:10px;margin:0}
  h1{font-size:17px;margin:0 0 2px} h2{font-size:12px;margin:12px 0 4px;border-bottom:2px solid #333;padding-bottom:2px}
  .sub{color:#444;margin-bottom:6px} table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th,td{border:1px solid #999;padding:2px 3px;vertical-align:top} th{background:#eee;font-size:9px}
  td.c{text-align:center;width:22px} td.r{text-align:right;white-space:nowrap} td.no{color:#aaa}
  td.own{background:#ffe8c7;font-weight:bold} .m{color:#555;font-size:9px} td.n{min-width:120px}
  .sign{display:flex;gap:40px;margin-top:22px} .sign div{border-top:1px solid #000;padding-top:3px;min-width:200px}
  button{padding:8px 14px;font-size:14px;margin:8px 0;cursor:pointer} @media print{.noprint{display:none}}
</style></head><body>
<button class="noprint" id="print">🖨 Print / Save as PDF</button>
<h1>Access report</h1>
<div class="sub">${people.length} active people · ${esc(ov.date)} · made by ${esc(user.fullName || user.username)}.
  V = view · A = add · E = edit · F = full · — = none. <b>*</b> and orange: changed for this person. Dashboard: everyone.</div>
<table><thead>
  <tr><th rowspan="2">Person</th><th rowspan="2">Workshop</th>${groups.map((g) => (g.n > 1 ? `<th colspan="${g.n}">${esc(g.label)}</th>` : `<th rowspan="2">${esc(g.label)}</th>`)).join('')}
    ${ov.kinds.map((k) => `<th rowspan="2">Limit: ${esc(k.label)}</th>`).join('')}</tr>
  <tr>${groups.filter((g) => g.n > 1).map((g) => cols.filter((c) => c.section === g.section).map((c) => `<th>${esc(c.label)}</th>`).join('')).join('')}</tr>
</thead><tbody>${rows || `<tr><td colspan="${cols.length + 2 + ov.kinds.length}">Nobody.</td></tr>`}</tbody></table>
<h2>Changes made for one person (${list.length})</h2>
${list.length ? `<table><thead><tr><th>Person</th><th>Section</th><th>What</th><th>Setting</th><th>Until</th><th>Set by</th><th>Set on</th></tr></thead>
<tbody>${list.map((x) => `<tr><td>${esc(x.person)}</td><td>${esc(x.section)}</td><td>${esc(x.what)}</td><td>${esc(x.setting)}</td><td>${esc(x.until || 'no end')}</td><td>${esc(x.by)}</td><td>${esc(x.on)}</td></tr>`).join('')}</tbody></table>`
    : '<p>None: everyone has exactly what their roles give.</p>'}
<div class="sign"><div>Checked by</div><div>Signature</div><div>Date</div></div>
<script src="/js/print-page.js"></script>
</body></html>`;
}

module.exports = { overview, columns, changes, sheets, printPage };
