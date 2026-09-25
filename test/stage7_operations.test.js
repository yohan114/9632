'use strict';

// Multi-site Stage 7 — operations (src/lib/operations.js).
//
//   A machine moves to another project or site on a date, and every move is kept. The site fleet
//   board shows what each machine is doing now and the month's availability in machine-days, each
//   day counted where the machine stood. Head office sees every workshop at a glance. A job card
//   sent to another workshop needs a reason, and the move is kept.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s7-'));
process.env.DB_PATH = path.join(TMP, 's7.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');
const ops = require('../src/lib/operations');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'transport_manager', 'assistant_transport_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'lantern-orchard-basalt';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), wsC: mkUser('wsC', ['workshop']), wsM: mkUser('wsM', ['workshop'], MTR),
  sk: mkUser('sk', ['storekeeper']), tm: mkUser('tm', ['transport_manager']), atm: mkUser('atm', ['assistant_transport_manager']),
  mgr: mkUser('mgr', ['manager']),
};
const pad = (n) => String(n).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
// The month before this one — every day of it is over.
const PREV = (() => { const [y, m] = TODAY.slice(0, 7).split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; })();
const L = new Date(Number(PREV.slice(0, 4)), Number(PREV.slice(5, 7)), 0).getDate();   // days in PREV
const P1 = run("INSERT INTO projects (name) VALUES ('Canal Project')").lastInsertRowid;
const P2 = run("INSERT INTO projects (name) VALUES ('Dam Project')").lastInsertRowid;
const S2 = run("INSERT INTO sites (project_id, name) VALUES (?, 'Spillway')", P2).lastInsertRowid;
const asset = (code, projectId, extra = {}) => run(
  `INSERT INTO assets (code, code_norm, registration, status, in_register, current_project_id, current_site_id, type)
   VALUES (?, ?, ?, ?, 1, ?, ?, 'Excavator')`, code, code.replace(/\W/g, ''), code, extra.status || 'active', projectId, extra.site || null).lastInsertRowid;
const M = {
  x: asset('XC-1', P1), y: asset('XC-2', P2, { site: S2 }), z: asset('XC-3', P2),
  idle: asset('XC-4', P1, { status: 'idle' }), gone: asset('XC-5', P1, { status: 'decommissioned' }),
};
let seq = 0;
function job(assetId, f = {}) {
  seq++;
  return run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, completed_at, workshop_id, is_historical,
                                     field, reported_at, working_at)
              VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  `2026/9/R/${700 + seq}`, assetId, f.type || 'repair', f.status || 'IN_PROGRESS', f.requested_at || TODAY, f.completed_at || null,
  f.ws || CW, f.historical ? 1 : 0, f.field ? 1 : 0, f.reported_at || null, f.working_at || null).lastInsertRowid;
}

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
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
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
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
    cookies[user] = r.cookie;
  }
  return cookies[user];
}
const A = (id) => get('SELECT * FROM assets WHERE id = ?', id);
const rowOf = (board, key) => board.rows.find((r) => r.key === key);

// ================================================================== machine moves
test('a machine moves to a project or site on a date; each move is kept, in order', async () => {
  const tm = await as('tm');
  const mv = (id, body, who = tm) => req('POST', `/api/operations/machines/${id}/move`, { cookie: who, body });
  assert.strictEqual((await mv(M.x, { place: `p:${P2}` }, await as('atm'))).status, 403, 'the assistant cannot move machines');
  assert.strictEqual((await mv(M.x, { place: `p:${P2}` }, await as('sk'))).status, 403);
  const bad = async (body, re) => { const r = await mv(M.x, body); assert.strictEqual(r.status, 400, r.text); assert.match(r.body.error, re); };
  await bad({}, /Choose where the machine goes/);
  await bad({ place: `w:${CW}` }, /not to a workshop/);
  await bad({ place: 'p:99999' }, /not on the list/);
  await bad({ place: `p:${P2}`, move_date: day(1) }, /future/);
  await bad({ place: `p:${P1}` }, /already there/);
  // Moved on the 11th of last month: from then on it stood at the Dam Project.
  const r = await mv(M.x, { place: `p:${P2}`, move_date: `${PREV}-11`, note: 'low-bed' });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual([A(M.x).current_project_id, A(M.x).current_site_id], [P2, null]);
  assert.deepStrictEqual(r.body.moves.map((m) => [m.move_date, m.from, m.to, m.note]), [[`${PREV}-11`, 'Canal Project', 'Dam Project', 'low-bed']]);
  await bad({ place: `p:${P1}`, move_date: `${PREV}-05` }, /last moved on/);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'asset' AND action = 'move' AND entity_id = ?", M.x));
});

test('the machine page: where it stands (a site of its project) and its moves; a project set by Edit is a move too', async () => {
  const boss = await as('boss');
  let a = (await req('GET', `/api/assets/${M.y}`, { cookie: await as('tm') })).body;
  assert.deepStrictEqual([a.place.key, a.place.label, a.moves.length], [`s:${S2}`, 'Spillway (Dam Project)', 0]);
  // Edit the machine's project: a move today, and the site of the old project is dropped.
  const r = await req('PATCH', `/api/assets/${M.y}`, { cookie: boss, body: { current_project_id: P1 } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([A(M.y).current_project_id, A(M.y).current_site_id], [P1, null]);
  a = (await req('GET', `/api/assets/${M.y}`, { cookie: boss })).body;
  assert.deepStrictEqual(a.moves.map((m) => [m.move_date, m.from, m.to, m.note]), [[TODAY, 'Spillway (Dam Project)', 'Canal Project', 'Changed on the machine page']]);
  // Other edits are not moves.
  await req('PATCH', `/api/assets/${M.y}`, { cookie: boss, body: { brand: 'CAT' } });
  assert.strictEqual(all('SELECT id FROM asset_moves WHERE asset_id = ?', M.y).length, 1);
  // And back to the site, with the move button.
  assert.strictEqual((await req('POST', `/api/operations/machines/${M.y}/move`, { cookie: boss, body: { place: `s:${S2}` } })).status, 201);
  assert.deepStrictEqual([A(M.y).current_project_id, A(M.y).current_site_id], [P2, S2]);
  // Back on the first day of last month it was at the site — before its first recorded move.
  const mv = all('SELECT * FROM asset_moves WHERE asset_id = ? ORDER BY move_date, id', M.y);
  assert.strictEqual(ops.placeOn(mv, `s:${S2}`, `${PREV}-01`), `s:${S2}`);
  assert.strictEqual(ops.placeOn([], `p:${P1}`, `${PREV}-01`), `p:${P1}`, 'never moved: where it is');
});

// ================================================================== the site fleet board
test('availability: machine-days with no open repair, each day at the site the machine stood', async () => {
  // Last month: XC-1 was down the 5th to the 7th at the Canal Project; it moved to the Dam on the 11th.
  job(M.x, { status: 'WORK_COMPLETE', requested_at: `${PREV}-05`, completed_at: `${PREV}-07 10:00:00` });
  // XC-2, at the Spillway: stopped on the 20th in the evening, the card opened the next morning, working
  // again on the 22nd (the card is still open) — down the 20th, 21st and 22nd.
  job(M.y, { status: 'IN_PROGRESS', field: true, requested_at: `${PREV}-21 06:30:00`, reported_at: `${PREV}-20 18:00`, working_at: `${PREV}-22 15:00` });
  // Not downtime: a service, an imported card, a rejected one.
  job(M.y, { type: 'service', status: 'CLOSED', requested_at: `${PREV}-01`, completed_at: `${PREV}-03` });
  job(M.x, { status: 'CLOSED', requested_at: `${PREV}-01`, completed_at: `${PREV}-28`, historical: true });
  job(M.z, { status: 'REJECTED', requested_at: `${PREV}-02` });
  const b = (await req('GET', `/api/operations/fleet?month=${PREV}`, { cookie: await as('wsC') })).body;
  const canal = rowOf(b, `p:${P1}`); const dam = rowOf(b, `p:${P2}`); const spill = rowOf(b, `s:${S2}`);
  // Canal: XC-1 the 1st to the 10th, XC-4 (idle) all month; XC-5 is out of use and not counted.
  assert.deepStrictEqual([canal.machine_days, canal.down_days], [10 + L, 3]);
  assert.strictEqual(canal.availability, Math.round(((10 + L - 3) / (10 + L)) * 1000) / 10);
  assert.deepStrictEqual([dam.machine_days, dam.down_days, dam.availability], [L - 10 + L, 0, 100]);
  assert.deepStrictEqual([spill.machine_days, spill.down_days], [L, 3]);
  assert.deepStrictEqual([b.total.machine_days, b.total.down_days], [10 + L + (2 * L - 10) + L, 6]);
  assert.strictEqual(b.days, L);
  // Now: the Canal has the idle one and the one out of use; XC-1 stands at the Dam.
  assert.deepStrictEqual([canal.machines, canal.idle, canal.out_of_use], [2, 1, 1]);
  assert.deepStrictEqual(dam.list.map((m) => [m.code, m.state]).sort(), [['XC-1', 'working'], ['XC-3', 'working']]);
  assert.strictEqual(canal.list.find((m) => m.code === 'XC-5').down_days, null);
  assert.strictEqual((await req('GET', '/api/operations/fleet?month=2999-01', { cookie: await as('wsC') })).status, 400);
});

test('now: an open repair holds its machine (workshop or field); the job of another workshop shows no link', async () => {
  const w = asset('XC-6', P2, { site: S2 });
  const zj = job(M.z, { status: 'IN_PROGRESS', requested_at: day(-2), ws: MTR });
  job(w, { status: 'REQUESTED', field: true, requested_at: TODAY, reported_at: `${TODAY} 07:00` });
  job(M.idle, { status: 'WORK_COMPLETE', requested_at: day(-1), completed_at: TODAY });   // done: not down
  const b = (await req('GET', '/api/operations/fleet', { cookie: await as('mgr') })).body;
  const z = rowOf(b, `p:${P2}`).list.find((m) => m.code === 'XC-3');
  assert.deepStrictEqual([z.state, z.job.job_no, z.job.reachable], ['down_workshop', get('SELECT job_no FROM job_cards WHERE id = ?', zj).job_no, true]);
  const monthStart = `${TODAY.slice(0, 7)}-01`;
  const expect = [day(-2), day(-1), TODAY].filter((d) => d >= monthStart).length;
  assert.strictEqual(z.down_days, expect, 'down each day since the card was opened, today included');
  assert.strictEqual(rowOf(b, `s:${S2}`).list.find((m) => m.code === 'XC-6').state, 'down_field');
  const y = rowOf(b, `s:${S2}`).list.find((m) => m.code === 'XC-2');
  assert.deepStrictEqual([y.state, y.job], ['working', null], 'working again, though its card is still open');
  assert.strictEqual(rowOf(b, `p:${P1}`).list.find((m) => m.code === 'XC-4').state, 'idle');
  // Workshops kept apart: Central sees Muthur's card number and workshop, not the card.
  scope.setSwitch({ id: U.boss }, true);
  const c = (await req('GET', '/api/operations/fleet', { cookie: await as('wsC') })).body;
  const zc = rowOf(c, `p:${P2}`).list.find((m) => m.code === 'XC-3');
  assert.deepStrictEqual([zc.job.reachable, zc.job.id, zc.job.workshop_name], [false, undefined, 'Muthur Workshop']);
  scope.setSwitch({ id: U.boss }, false);
  // Who may read: Assets view.
  run("INSERT OR IGNORE INTO roles (name, label) VALUES ('noassets', 'No assets')");
  require('../src/lib/permissions').setPermission('noassets', 'assets', 'none');
  mkUser('na', ['noassets']);
  assert.strictEqual((await req('GET', '/api/operations/fleet', { cookie: await as('na') })).status, 403);
});

// ================================================================== workshops at a glance
test('workshops at a glance: head office only; each number is its list', async () => {
  const zj = get("SELECT id FROM job_cards WHERE asset_id = ? AND status = 'IN_PROGRESS' AND workshop_id = ?", M.z, MTR).id;
  // Muthur: parts outstanding on its open card; a request fully received and one rejected do not count.
  const mrn = (no, f) => run(`INSERT INTO mrn (mrn_no, req_date, asset_id, job_id, requested_by, workshop_id, approval_status)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`, no, TODAY, M.z, f.job || null, f.by === undefined ? 'Kasun' : f.by, f.ws || MTR, f.status || 'approved').lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Seal kit', 2, 0)", mrn('M-1', { job: zj }));
  const k2 = job(asset('XC-8', P2), { ws: MTR });
  const k3 = job(asset('XC-9', P2), { ws: MTR });
  job(asset('XC-10', P2), { ws: MTR, status: 'WORK_COMPLETE', completed_at: TODAY });   // open, but the machine is out
  run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Filter', 1, 1)", mrn('M-2', { job: k2 }));
  run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Hose', 1, 0)", mrn('M-3', { job: k3, status: 'rejected' }));
  // Waiting for approval: an in-flow request and a job request; an imported request (no requester) is not.
  mrn('M-4', { status: 'requested' });
  mrn('M-5', { status: 'requested', by: null });
  run("INSERT INTO job_requests (jr_no, asset_id, description, approval_status, workshop_id) VALUES ('JR-1', ?, 'noise', 'requested', ?)", M.z, MTR);
  // A mechanic with work booked today (attendance is off).
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Nimal', 3)", zj, TODAY);
  assert.strictEqual((await req('GET', '/api/operations/glance', { cookie: await as('wsC') })).status, 403);
  assert.strictEqual((await req('GET', `/api/operations/glance/${MTR}/open`, { cookie: await as('wsC') })).status, 403);
  const g = await req('GET', '/api/operations/glance', { cookie: await as('mgr') });
  assert.strictEqual(g.status, 200, g.text);
  const m = g.body.rows.find((r) => r.workshop_id === MTR);
  assert.deepStrictEqual([m.open_jobs, m.machines_down, m.waiting_parts, m.approvals, m.present, m.present_mode, m.unsigned_days],
    [4, 3, 1, 2, 1, 'daily_work', null]);
  assert.strictEqual(typeof m.cost_month, 'number');
  const list = async (ws, what) => (await req('GET', `/api/operations/glance/${ws}/${what}`, { cookie: await as('mgr') })).body;
  assert.deepStrictEqual((await list(MTR, 'parts')).map((j) => j.id), [zj]);
  assert.deepStrictEqual((await list(MTR, 'approvals')).map((r) => r.ref).sort(), ['JR-1', 'M-4']);
  assert.deepStrictEqual(await list(MTR, 'present'), [{ name: 'Nimal', detail: '3 h booked' }]);
  const c = g.body.rows.find((r) => r.workshop_id === CW);
  assert.strictEqual(c.machines_down, (await list(CW, 'down')).length);
  assert.strictEqual(c.open_jobs, (await list(CW, 'open')).length);
  assert.strictEqual((await req('GET', `/api/operations/glance/${MTR}/nothing`, { cookie: await as('mgr') })).status, 404);
  assert.strictEqual((await req('GET', '/api/operations/glance/99999/open', { cookie: await as('mgr') })).status, 404);
});

// ================================================================== handovers
test('a job card sent to another workshop needs a reason; both workshops see the move', async () => {
  const h = job(asset('XC-7', P1), { status: 'IN_WORKSHOP' });
  const wsC = await as('wsC');
  const send = (body) => req('PATCH', `/api/jobs/${h}`, { cookie: wsC, body });
  let r = await send({ workshop_id: MTR });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /Say why/);
  assert.strictEqual((await send({ workshop_id: MTR, workshop_reason: 'x' })).status, 400);
  assert.strictEqual(get('SELECT workshop_id FROM job_cards WHERE id = ?', h).workshop_id, CW, 'nothing changed');
  r = await send({ workshop_id: MTR, workshop_reason: 'Muthur has the crane' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual({ ...get('SELECT from_workshop_id f, to_workshop_id t, reason, moved_by FROM job_workshop_moves WHERE job_id = ?', h) },
    { f: CW, t: MTR, reason: 'Muthur has the crane', moved_by: U.wsC });
  const detail = (await req('GET', `/api/jobs/${h}`, { cookie: await as('mgr') })).body;
  assert.deepStrictEqual(detail.handovers.map((x) => [x.from_name, x.to_name, x.reason]), [[workshops.byId(CW).name, 'Muthur Workshop', 'Muthur has the crane']]);
  // Other edits need no reason.
  assert.strictEqual((await req('PATCH', `/api/jobs/${h}`, { cookie: await as('mgr'), body: { description: 'boom cylinder' } })).status, 200);
  scope.setSwitch({ id: U.boss }, true);
  const sent = (await req('GET', '/api/operations/handovers', { cookie: wsC })).body.find((x) => x.job_id === h);
  assert.deepStrictEqual([sent.to_name, sent.reachable], ['Muthur Workshop', false], 'the sender sees where it went, without the card');
  assert.strictEqual((await req('GET', '/api/operations/handovers', { cookie: await as('wsM') })).body.find((x) => x.job_id === h).reachable, true);
  scope.setSwitch({ id: U.boss }, false);
});
