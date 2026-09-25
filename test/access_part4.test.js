'use strict';

// Access plan, Part 4 — History and security.
//
//   - The History of access: who changed whose access, when, and what, by person or by section.
//   - The browser's Content-Security-Policy is enforced: no inline handler or inline script is left
//     anywhere the browser loads, so an injected script is refused, not run.
//   - Live updates go only to people who may see a section that shows that kind of record.
//   - Changing access needs 2-step sign-in; reading it does not.
//   - The flagged libraries are on fixed versions.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-accp4-'));
process.env.DB_PATH = path.join(TMP, 'ap4.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const emitter = require('../src/lib/emitter');
const liveScope = require('../src/lib/live_scope');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
capabilities.seedCapabilities();
perms.seedDefaults();

const PW = 'copper-lantern-gravel';
const U = {};
function mkUser(username, roles, fullName) {
  const id = run('INSERT INTO users (username, password_hash, active, full_name) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), fullName || username.toUpperCase()).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  U[username] = id;
  return id;
}
mkUser('boss', ['admin']); mkUser('plain', ['admin']); mkUser('sk', ['storekeeper']); mkUser('buyer', ['purchase_local']);
mkUser('vw', ['viewer']); mkUser('ws', ['workshop']);

// ---- the server -----------------------------------------------------------------------------------
const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.httpServer.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });
function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text: buf });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const r = await req('POST', '/api/auth/login', { body: { username: user, password: PW } });
    assert.strictEqual(r.status, 200, r.text);
    cookies[user] = r.headers['set-cookie'][0].split(';')[0];
  }
  return cookies[user];
}
// 2-step sign-in, as the real endpoints leave it: on for the person, passed by this session.
function secondFactorOn(cookie) {
  const token = decodeURIComponent(cookie.split('=')[1]);
  const s = get('SELECT user_id FROM sessions WHERE token = ?', token);
  run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', s.user_id);
  run('UPDATE sessions SET mfa_verified = 1 WHERE token = ?', token);
  return cookie;
}
const label = (role) => get("SELECT COALESCE(NULLIF(label, ''), name) l FROM roles WHERE name = ?", role).l;
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const day = (n) => { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ================================================================== 2-step sign-in to change access
test('changing access needs 2-step sign-in; reading it, and turning it on, do not', async () => {
  // "plain" is an admin without it.
  assert.strictEqual((await call('plain', 'GET', '/access/people')).status, 200, 'reading is fine');
  assert.strictEqual((await call('plain', 'GET', '/users')).status, 200);
  for (const [m, p, b] of [
    ['PUT', `/access/people/${U.sk}/levels`, { module: 'stores', level: 'view' }],
    ['PUT', `/access/people/${U.sk}/caps`, { capability: 'jobs.reason', state: 'give' }],
    ['POST', '/access/matrix', { role: 'viewer', module: 'stores', level: 'none' }],
    ['POST', '/access/roles', { label: 'Tester' }],
    ['PUT', '/access/approval-limits', { role: 'manager', kind: 'mrn_approve', max_amount: 5 }],
    ['POST', '/users', { username: 'newbie', password: 'Kestrel-Timber-5521', roles: ['viewer'] }],
    ['PATCH', `/users/${U.sk}`, { full_name: 'Changed' }],
    ['POST', `/users/${U.sk}/roles`, { roles: ['viewer'] }],
  ]) {
    const r = await call('plain', m, p, b);
    assert.strictEqual(r.status, 403, `${m} ${p}`);
    assert.strictEqual(r.body.secondFactorRequired, true);
    assert.match(r.body.error, /2-step sign-in/);
  }
  assert.strictEqual(get("SELECT COUNT(*) n FROM users WHERE username = 'newbie'").n, 0, 'nothing happened');
  // Turning it on is not behind the rule.
  assert.strictEqual((await call('plain', 'POST', '/auth/mfa/setup')).status, 200);
  // With it on, the same change goes through.
  secondFactorOn(await as('boss'));
  assert.strictEqual((await call('boss', 'PUT', `/access/people/${U.sk}/levels`, { module: 'stores', level: 'view' })).status, 200);
  assert.strictEqual((await call('boss', 'PUT', `/access/people/${U.sk}/levels`, { module: 'stores', level: null })).status, 200);
  // And /auth/me tells the screens, so they can say so.
  assert.strictEqual((await call('plain', 'GET', '/auth/me')).body.mfaEnabled, false);
  assert.strictEqual((await call('boss', 'GET', '/auth/me')).body.mfaEnabled, true);
});

// ================================================================== History
test('History: who changed whose access, when and what — by person and by section', async () => {
  secondFactorOn(await as('boss'));
  const start = get('SELECT COALESCE(MAX(id), 0) m FROM audit_log').m;
  await call('boss', 'PUT', `/access/people/${U.sk}/levels`, { module: 'purchasing', level: 'edit', until: day(3) });
  await call('boss', 'PUT', `/access/people/${U.vw}/caps`, { capability: 'jobs.reason', state: 'give' });
  await call('boss', 'PUT', `/access/people/${U.ws}/caps`, { capability: 'jobs.create', state: 'take' });
  await call('boss', 'PUT', `/access/people/${U.ws}/limits`, { kind: 'job_close', max_amount: 7500 });
  await call('boss', 'POST', '/access/matrix', { role: 'viewer', module: 'labour', level: 'none' });
  await call('boss', 'POST', `/users/${U.buyer}/roles`, { roles: ['purchase_local', 'viewer'] });
  await call('boss', 'GET', '/access/report.xlsx');

  const all = (await call('boss', 'GET', '/access/history')).body;
  const mine = all.rows.filter((r) => r.id > start);
  assert.deepStrictEqual(mine.map((r) => r.what), [
    'Access report downloaded (Excel)',
    `Roles: ${label('purchase_local')} → ${label('purchase_local')}, ${label('viewer')}`,
    `Role ${label('viewer')}: Labour Rates View → None`,
    'Own limit to "Close a job card fully": Rs 7,500',
    'Taken away: Open a new job card',
    'Given: Say why a job in the workshop is not being worked on',
    `Purchasing: Edit until ${day(3)}`,
  ], 'newest first, in plain words');
  const lvl = mine[mine.length - 1];
  assert.strictEqual(lvl.by_name, 'BOSS');
  assert.strictEqual(lvl.person_name, 'SK');
  assert.deepStrictEqual(lvl.sections, ['purchasing']);

  // By person: changes for them, and changes they made.
  const ws = (await call('boss', 'GET', `/access/history?person=${U.ws}`)).body.rows.map((r) => r.what);
  assert.deepStrictEqual(ws.slice(0, 2), ['Own limit to "Close a job card fully": Rs 7,500', 'Taken away: Open a new job card']);
  const byBoss = (await call('boss', 'GET', `/access/history?person=${U.boss}`)).body.rows.filter((r) => r.id > start);
  assert.strictEqual(byBoss.length, mine.length, 'everything the boss did');
  // By section.
  const jobs = (await call('boss', 'GET', '/access/history?section=jobs')).body.rows.filter((r) => r.id > start).map((r) => r.what);
  assert.deepStrictEqual(jobs, ['Own limit to "Close a job card fully": Rs 7,500', 'Taken away: Open a new job card', 'Given: Say why a job in the workshop is not being worked on']);
  const labour = (await call('boss', 'GET', '/access/history?section=labour')).body.rows.filter((r) => r.id > start).map((r) => r.what);
  assert.deepStrictEqual(labour, [`Role ${label('viewer')}: Labour Rates View → None`]);
  // Page by page.
  const p1 = (await call('boss', 'GET', '/access/history?limit=3')).body;
  assert.strictEqual(p1.rows.length, 3);
  assert.strictEqual(p1.more, true);
  const p2 = (await call('boss', 'GET', `/access/history?limit=3&before=${p1.rows[2].id}`)).body;
  assert.ok(p2.rows.every((r) => r.id < p1.rows[2].id));
  // Nothing else from the audit log: a job card, a sign-in, a signature.
  assert.ok(all.rows.every((r) => !['job_card', 'session'].includes(r.entity)));
  assert.ok(!all.rows.some((r) => r.action === 'mfa_setup_started'), 'starting 2-step set-up is not a change of access');
  assert.ok(get("SELECT COUNT(*) n FROM audit_log WHERE action = 'mfa_setup_started'").n > 0, '(though it is in the audit log)');
  // Access managers only — reading needs no 2-step sign-in.
  assert.strictEqual((await call('sk', 'GET', '/access/history')).status, 403);
  assert.strictEqual((await call('plain', 'GET', '/access/history')).status, 200);
  // Undo, for the tests after this one.
  await call('boss', 'POST', `/access/people/${U.sk}/reset`, {});
  await call('boss', 'POST', `/access/people/${U.vw}/reset`, {});
  await call('boss', 'POST', `/access/people/${U.ws}/reset`, {});
  await call('boss', 'POST', '/access/matrix', { role: 'viewer', module: 'labour', level: 'view' });
  await call('boss', 'POST', `/users/${U.buyer}/roles`, { roles: ['purchase_local'] });
});

// ================================================================== the browser's script protection
const walk = (dir, out = []) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else if (/\.(js|html)$/.test(f.name)) out.push(p);
  }
  return out;
};
const ROOT = path.join(__dirname, '..');

test('no inline handler, javascript: link or inline script anywhere the browser loads', () => {
  const files = [...walk(path.join(ROOT, 'public')), ...walk(path.join(ROOT, 'src', 'routes')), ...walk(path.join(ROOT, 'src', 'lib'))];
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/\son[a-z]+\s*=\s*["'\\]/.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1} inline handler`);
      if (/href\s*=\s*["']javascript:/i.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1} javascript: link`);
      if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1} inline script`);
    });
  }
  assert.deepStrictEqual(bad, []);
});

test('the policy is enforced, and the pages load their scripts from files', async () => {
  const idx = await req('GET', '/');
  assert.match(idx.headers['content-security-policy'], /script-src 'self'/);
  assert.strictEqual(idx.headers['content-security-policy-report-only'], undefined);
  assert.match(idx.text, /<script src="\/js\/sw-register\.js/);
  secondFactorOn(await as('boss'));
  for (const p of ['/api/reports/ongoing-jobs.html', '/api/access/report.html']) {
    const r = await req('GET', p, { cookie: await as('boss') });
    assert.strictEqual(r.status, 200, p);
    assert.match(r.text, /id="print"/, `${p}: the print button`);
    assert.match(r.text, /<script src="\/js\/print-page\.js"><\/script>/, `${p}: wired by a file`);
    assert.doesNotMatch(r.text, /onclick=/);
  }
  // Every outside file the screens load is allowed — and nothing else from outside.
  const policy = idx.headers['content-security-policy'];
  const outside = new Set();
  for (const f of walk(path.join(ROOT, 'public'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:src\s*=\s*|@import url\(|href\s*=\s*)['"](https:\/\/[^'"]+)['"]/g)) outside.add(m[1]);
  }
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  for (const m of css.matchAll(/@import url\('(https:\/\/[^']+)'\)/g)) outside.add(m[1]);
  assert.ok(outside.size >= 2, [...outside].join(' '));
  for (const u of outside) {
    const host = new URL(u).origin;
    assert.ok(policy.includes(u) || policy.includes(host), `${u} is allowed`);
  }
  assert.ok(!/script-src[^;]*https:\/\/cdn\.jsdelivr\.net(\s|;|$)/.test(policy), 'only the one chart file, not the whole site');
  assert.match(policy, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  const js = await req('GET', '/js/print-page.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.text, /window\.print\(\)/);
});

// ================================================================== live updates by section
function socket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie } });
    const got = [];
    ws.on('message', (m) => {
      const s = m.toString();
      if (s.startsWith('0')) ws.send('40');
      else if (s.startsWith('40')) resolve({ got, close: () => ws.close() });
      else if (s === '2') ws.send('3');
      else if (s.startsWith('42')) got.push(JSON.parse(s.slice(2)));
    });
    ws.on('error', reject);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 250));
const heard = (sock, entity) => sock.got.some(([ev, d]) => ev === 'data_changed' && d && d.entity === entity);

test('a live update reaches only the people who may see a section that shows it', async () => {
  const s = { boss: await socket(await as('boss')), sk: await socket(await as('sk')), buyer: await socket(await as('buyer')), vw: await socket(await as('vw')) };
  try {
    emitter.notify('store_item', 'update', { id: 1 });
    emitter.notify('labour_rate', 'update', { id: 2 });
    emitter.notify('user_permission', 'set', { id: 3 });
    emitter.notify('something_new', 'update', { id: 4 });
    emitter.notify('workshop', 'update', { id: 5 });
    await settle();
    assert.ok(heard(s.sk, 'store_item') && heard(s.vw, 'store_item') && heard(s.boss, 'store_item'));
    assert.ok(!heard(s.buyer, 'store_item'), 'a buyer does not see the stores');
    assert.ok(heard(s.vw, 'labour_rate') && !heard(s.sk, 'labour_rate'), 'labour rates: the viewer, not the storekeeper');
    assert.ok(heard(s.boss, 'user_permission') && !heard(s.vw, 'user_permission'), 'access changes: access managers only');
    assert.ok(heard(s.boss, 'something_new') && !heard(s.sk, 'something_new'), 'not listed: admins only');
    assert.ok(['boss', 'sk', 'buyer', 'vw'].every((k) => heard(s[k], 'workshop')), 'the workshops list: everyone');
    // Given the stores, the buyer hears about them from the next update.
    secondFactorOn(await as('boss'));
    assert.strictEqual((await call('boss', 'PUT', `/access/people/${U.buyer}/levels`, { module: 'stores', level: 'view' })).status, 200);
    s.buyer.got.length = 0;
    emitter.notify('store_item', 'update', { id: 6 });
    await settle();
    assert.ok(heard(s.buyer, 'store_item'));
    await call('boss', 'PUT', `/access/people/${U.buyer}/levels`, { module: 'stores', level: null });
  } finally { for (const k of Object.keys(s)) s[k].close(); }
});

test('every kind of record the code writes to the audit log is listed for live updates', () => {
  const kinds = new Set();
  for (const f of walk(path.join(ROOT, 'src'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/entity: '([a-z_]+)'/g)) kinds.add(m[1]);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\.notify\('([a-z_]+)'/g)) kinds.add(m[1]);
  }
  const missing = [...kinds].filter((k) => !(k in liveScope.ENTITY));
  assert.deepStrictEqual(missing, [], 'add them to src/lib/live_scope.js');
  for (const [k, who] of Object.entries(liveScope.ENTITY)) {
    if (Array.isArray(who)) for (const m of who) assert.ok(perms.MODULE_KEYS.includes(m), `${k}: ${m} is a section switch`);
  }
});

// ================================================================== libraries
test('the flagged libraries are on fixed versions', () => {
  const ver = (name, from) => require(require.resolve(`${name}/package.json`, { paths: [from] })).version.split('.').map(Number);
  const atLeast = (v, min) => { for (let i = 0; i < 3; i++) { if (v[i] !== min[i]) return v[i] > min[i]; } return true; };
  const excel = path.dirname(require.resolve('exceljs'));
  const express = path.dirname(require.resolve('express'));
  assert.ok(atLeast(ver('uuid', excel), [11, 1, 1]), 'uuid inside the Excel library');
  assert.ok(atLeast(ver('qs', express), [6, 16, 0]), 'qs inside express');
});
