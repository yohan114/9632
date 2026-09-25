'use strict';

// Stores plan, Part 4 — tyres and batteries by serial number, and disposal notes
// (src/lib/tb_units.js, src/lib/disposal.js, src/routes/tyre_battery_requests.js).
//
//   A tyre or a battery goes out by its serial number and is fixed to the vehicle at that moment
//   (ST-D6, D7): a tyre also names its wheel, and the one that was there comes off. What became of
//   the old one is written down before the next one goes on (ST-D8), and moves it on in its
//   register. Once a store has counted them in full, none goes out unless the shelf holds it
//   (ST-D12). Scrap leaves on a disposal note a manager approves, with the buyer, the amount and
//   the date (ST-D9).

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-sp4-'));
process.env.DB_PATH = path.join(TMP, 'sp4.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const scope = require('../src/lib/scope');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper', 'operational_manager']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
require('../src/lib/capabilities').seedCapabilities();
require('../src/lib/permissions').seedDefaults();
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name) VALUES ('MTR', 'Muthur Workshop')").lastInsertRowid;
const PW = 'copper-lantern-gravel';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']), sk: mkUser('sk', ['storekeeper']),
  skM: mkUser('skM', ['storekeeper'], MTR) };
// A store supervisor given the right to approve disposal notes — but not head office.
run("INSERT INTO roles (name, label) VALUES ('storelead', 'Store supervisor')");
require('../src/lib/permissions').setPermission('storelead', 'stores', 'edit');
require('../src/lib/capabilities').setCapability('storelead', 'stores.disposal.approve', true);
mkUser('lead', ['storelead'], MTR);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);

const ASSET = run("INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES ('WP-4001', 'WP4001', 'WP-4001', 'active', 1)").lastInsertRowid;
const ASSET2 = run("INSERT INTO assets (code, code_norm, registration, status, in_register) VALUES ('WP-4002', 'WP4002', 'WP-4002', 'active', 1)").lastInsertRowid;
const TYRE = run("INSERT INTO tb_specs (kind, size, label, spec_key, unit_price, source) VALUES ('tyre', '1000 X 20', 'Tyre 1000 X 20', 'T1000X20', 21000, 'test')").lastInsertRowid;
const TUBE = run("INSERT INTO tb_specs (kind, size, label, spec_key, source) VALUES ('tube', '1000 X 20', 'Tube 1000 X 20', 'U1000X20', 'test')").lastInsertRowid;
const BATT = run("INSERT INTO tb_specs (kind, rating, label, spec_key, unit_price, source) VALUES ('battery', '95 Amp', 'Battery 95 Amp', 'B95', 38000, 'test')").lastInsertRowid;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
        resolve({ status: res.statusCode, body: json, text: buf });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    cookies[user] = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ username: user, password: PW });
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0]));
      });
      q.on('error', reject); q.write(data); q.end();
    });
  }
  return cookies[user];
}
const call = async (user, method, p, body) => req(method, '/api' + p, { cookie: await as(user), body });
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, r.text); return r.body; };
const refused = (r, status, re) => { assert.strictEqual(r.status, status, r.text); if (re) assert.match(r.body.error, re); };

// An approved tyre or battery request line for a vehicle.
let seq = 0;
function request(kind, qty, { asset = ASSET, position = null, store = CW } = {}) {
  const m = run("INSERT INTO mrn (mrn_no, req_date, requested_by, approval_status, workshop_id, tb_kind, asset_id) VALUES (?, ?, 'Kasun', 'approved', ?, ?, ?)",
    `TB-${++seq}`, day(-5), store, kind === 'battery' ? 'battery' : 'tyre', asset).lastInsertRowid;
  const l = run("INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, ?, ?)",
    m, kind === 'tyre' ? 'Tyre 1000 X 20' : 'Battery 95 Amp', qty, kind === 'tyre' ? 'Tyres' : 'Batteries').lastInsertRowid;
  run("INSERT INTO tb_request_lines (mrn_line_id, kind, spec_id, asset_id, reason, position) VALUES (?, ?, ?, ?, 'worn', ?)",
    l, kind, { tyre: TYRE, tube: TUBE, battery: BATT }[kind], asset, position);
  return { m, l };
}
const issue = (r, body, who = 'sk') => call(who, 'POST', '/tb/issue', { mrn_line_id: r.l, ...body });
const tyre = (serial) => get('SELECT * FROM tyres WHERE serial_no = ?', serial);
const battery = (serial) => get('SELECT * FROM batteries WHERE serial_no = ?', serial);
const tyreEvents = (serial) => all('SELECT event_type FROM tyre_events WHERE tyre_id = ? ORDER BY id', tyre(serial).id).map((e) => e.event_type);
const G = {};

// ================================================================== a tyre goes out by its serial
test('a tyre goes out by its serial number, to a wheel, and is fixed to the vehicle', async () => {
  refused(await issue(request('tyre', 1, { asset: null, position: 'FL' }), { qty: 1, serial_no: 'TY-X' }), 400, /names no vehicle/);
  G.t1 = request('tyre', 1);
  refused(await issue(G.t1, { qty: 1 }), 400, /serial number of each tyre/);
  refused(await issue(G.t1, { qty: 1, serial_no: 'TY-A' }), 400, /wheel position of tyre TY-A/);
  const r = ok(await issue(G.t1, { qty: 1, serial_no: 'TY-A', position: 'fl', issue_date: day(-3) }), 201);
  assert.strictEqual(r.old_unit_due, true, 'the store is told the old one is still to be written down');
  const t = tyre('TY-A');
  assert.deepStrictEqual([t.state, t.current_asset_id, t.position, t.spec_id, t.store_id], ['installed', ASSET, 'FL', TYRE, CW]);
  const row = get('SELECT * FROM tyre_battery_issues WHERE id = ?', r.id);
  assert.deepStrictEqual([row.unit_id, row.old_unit_id, row.serial_no, row.position], [t.id, null, 'TY-A', 'FL']);
  assert.deepStrictEqual(all('SELECT event_type, to_asset_id, position, issue_id FROM tyre_events WHERE tyre_id = ? ORDER BY id', t.id)
    .map((e) => [e.event_type, e.to_asset_id, e.position, e.issue_id]), [['add', ASSET, null, r.id], ['install', ASSET, 'FL', r.id]]);
  G.t1.issue = r.id;
});

test('a tyre on one vehicle cannot be issued to another', async () => {
  const r = request('tyre', 1, { asset: ASSET2, position: 'FL' });
  refused(await issue(r, { qty: 1, serial_no: 'ty-a' }), 409, /Tyre TY-A is on WP-4001/);
  G.t2 = ok(await issue(r, { qty: 1, serial_no: 'TY-C', issue_date: day(-3) }), 201).id;
  assert.strictEqual(tyre('TY-C').current_asset_id, ASSET2);
});

test('the old tyre is written down before the next one goes on; the new one takes it off', async () => {
  const r = request('tyre', 1, { position: 'FL' });
  refused(await issue(r, { qty: 1, serial_no: 'TY-B', issue_date: day(-1) }), 409, /Record what came off WP-4001 first/);
  assert.strictEqual(tyre('TY-B'), undefined, 'nothing was written');
  // "Not returned" has to say why.
  refused(await call('sk', 'POST', '/tb/returns', { issue_id: G.t1.issue, condition: 'not_returned' }), 400, /why/);
  ok(await call('sk', 'POST', '/tb/returns', { issue_id: G.t1.issue, condition: 'not_returned', exception_reason: 'First fit in the system' }), 201);
  const done = ok(await issue(r, { qty: 1, serial_no: 'TY-B', issue_date: day(-1) }), 201);
  const a = tyre('TY-A');
  assert.deepStrictEqual([a.state, a.current_asset_id, a.position], ['removed', null, null], 'the one at FL came off');
  assert.deepStrictEqual([tyre('TY-B').state, tyre('TY-B').position], ['installed', 'FL']);
  assert.strictEqual(get('SELECT old_unit_id FROM tyre_battery_issues WHERE id = ?', done.id).old_unit_id, a.id);
  // What came off is scrap: it moves on in its register.
  ok(await call('sk', 'POST', '/tb/returns', { issue_id: done.id, condition: 'scrap' }), 201);
  assert.strictEqual(tyre('TY-A').state, 'scrap');
  assert.deepStrictEqual(tyreEvents('TY-A'), ['add', 'install', 'remove', 'scrap']);
});

test('two tyres in one issue: each has its own serial and its own wheel; a bad photo stops the lot', async () => {
  const r = request('tyre', 2, { position: 'RL1' });
  refused(await issue(r, { qty: 2, units: [{ serial_no: 'TY-D' }] }), 400, /serial number of each tyre going out \(2\)/);
  refused(await issue(r, { qty: 2, units: [{ serial_no: 'TY-D' }, { serial_no: 'TY-E' }] }), 400, /Two tyres cannot go on at RL1/);
  refused(await issue(r, { qty: 2, units: [{ serial_no: 'TY-D' }, { serial_no: 'ty-d', position: 'RL2' }] }), 400, /same serial number is given twice/);
  refused(await issue(r, { qty: 2, units: [{ serial_no: 'TY-D' }, { serial_no: 'TY-E', position: 'RL2', old_serial: 'TY-D' }] }), 400, /both going on and coming off/);
  refused(await issue(r, { qty: 2, units: [{ serial_no: 'TY-D' }, { serial_no: 'TY-E', position: 'RL2', photo: 'data:text/plain;base64,AAAA' }] }), 400, /PNG, JPEG or WebP/);
  assert.deepStrictEqual([tyre('TY-D'), get('SELECT COUNT(*) n FROM tyre_battery_issues WHERE mrn_line_id = ?', r.l).n], [undefined, 0],
    'the whole issue is undone, not just the second tyre');
  const done = ok(await issue(r, { qty: 2, issue_date: day(-1), units: [{ serial_no: 'TY-D' }, { serial_no: 'TY-E', position: 'rl2', photo: PNG }] }), 201);
  assert.strictEqual(done.ids.length, 2, 'one row a tyre');
  G.t4 = done.ids;
  const listed = ok(await call('sk', 'GET', '/tb/requests?kind=tyre')).find((x) => x.id === r.m);
  assert.deepStrictEqual([listed.lines, listed.issued_lines], [1, 1], 'one line, all of it gone out — not two'); 
  assert.deepStrictEqual([tyre('TY-D').position, tyre('TY-E').position], ['RL1', 'RL2']);
  assert.strictEqual(get('SELECT COUNT(*) n FROM tyre_photos WHERE tyre_id = ?', tyre('TY-E').id).n, 1);
  assert.strictEqual(tyre('TY-E').photo_path, PNG, 'the first photo is its cover');
  assert.strictEqual(get('SELECT qty_received FROM mrn_lines WHERE id = ?', r.l).qty_received, 2);
});

// ================================================================== the tyre register
test('the tyre register: find a tyre, see its story, add photos, rotate it, scrap it', async () => {
  assert.deepStrictEqual(ok(await call('mgr', 'GET', '/tb/tyres?q=TY-A')).map((t) => [t.serial_no, t.state]), [['TY-A', 'scrap']]);
  assert.deepStrictEqual(ok(await call('mgr', 'GET', '/tb/tyres?state=installed')).map((t) => t.serial_no).sort(), ['TY-B', 'TY-C', 'TY-D', 'TY-E']);
  const D = tyre('TY-D').id;
  const d = ok(await call('mgr', 'GET', `/tb/tyres/${D}`));
  assert.deepStrictEqual([d.tyre.asset_code, d.tyre.spec, d.events.length, d.photos.length], ['WP-4001', 'Tyre 1000 X 20', 2, 0]);
  refused(await call('mgr', 'POST', `/tb/tyres/${D}/photos`, { photo: PNG }), 403);
  assert.strictEqual(ok(await call('sk', 'POST', `/tb/tyres/${D}/photos`, { photos: [PNG, PNG] }), 201).length, 2);
  const left = ok(await call('sk', 'DELETE', `/tb/tyres/${D}/photos/${get('SELECT id FROM tyre_photos WHERE tyre_id = ? AND seq = 1', D).id}`));
  assert.deepStrictEqual(left.map((p) => p.seq), [1], 'the gap is closed');
  // A rotation: off RL1, on at RR2.
  ok(await call('sk', 'POST', `/tb/tyres/${D}/event`, { event_type: 'remove', reason: 'rotation' }), 201);
  refused(await call('sk', 'POST', `/tb/tyres/${D}/event`, { event_type: 'remove' }), 409, /TY-D is not on a vehicle/);
  refused(await call('sk', 'POST', `/tb/tyres/${D}/event`, { event_type: 'install', to_asset_id: ASSET, position: 'FL' }), 409, /TY-B is at FL/);
  ok(await call('sk', 'POST', `/tb/tyres/${D}/event`, { event_type: 'install', to_asset_id: ASSET, position: 'RR2' }), 201);
  assert.deepStrictEqual([tyre('TY-D').state, tyre('TY-D').position], ['installed', 'RR2']);
  // Scrapped while on the vehicle: it comes off first, and cannot be fitted again.
  const E = tyre('TY-E').id;
  ok(await call('sk', 'POST', `/tb/tyres/${E}/event`, { event_type: 'scrap', reason: 'sidewall cut' }), 201);
  assert.deepStrictEqual([tyre('TY-E').state, tyre('TY-E').current_asset_id], ['scrap', null]);
  refused(await call('sk', 'POST', `/tb/tyres/${E}/event`, { event_type: 'install', to_asset_id: ASSET, position: 'RL2' }), 409, /Only a tyre in the store/);
  refused(await call('sk', 'POST', `/tb/tyres/${E}/event`, { event_type: 'thrown' }), 400);
  refused(await call('sk', 'POST', `/tb/tyres/${E}/event`, { event_type: 'repair' }), 409, /TY-E is scrap/);
});

// ================================================================== batteries, and the stock rule
test('batteries: a serial each, two to a machine, the old one named — and only what the shelf holds', async () => {
  // Batteries are counted in full at the main store: from now on none leaves unless it is on the shelf.
  run("INSERT INTO count_sessions (count_no, store_id, kind, scope, status, count_date, decided_at) VALUES ('ST-B1', ?, 'battery', 'full', 'approved', ?, datetime('now'))", CW, TODAY);
  const r = request('battery', 2);
  const first = { qty: 2, units: [
    { serial_no: 'B-1', old_condition: 'not_returned', old_reason: 'New machine' },
    { serial_no: 'B-2', old_condition: 'not_returned', old_reason: 'New machine', photo: PNG }] };
  refused(await issue(r, first), 409, /Battery 95 Amp: 0 in stock/);
  assert.strictEqual(battery('B-1'), undefined, 'nothing was fitted');
  ok(await call('sk', 'POST', '/stores/grn', { mrn_id: r.m, mrn_line_id: r.l, qty: 2, unit_price: 38000 }), 201);
  const done = ok(await issue(r, first), 201);
  assert.strictEqual(done.old_unit_due, false, 'what came off was said at the issue');
  assert.deepStrictEqual([battery('B-1').state, battery('B-2').current_asset_id, battery('B-2').spec_id], ['installed', ASSET, BATT]);
  assert.strictEqual(get('SELECT COUNT(*) n FROM battery_photos WHERE battery_id = ?', battery('B-2').id).n, 1);
  assert.strictEqual(get('SELECT COUNT(*) n FROM tb_returns WHERE issue_id IN (' + done.ids.join(',') + ')').n, 2);

  const r2 = request('battery', 1);
  ok(await call('sk', 'POST', '/stores/grn', { mrn_id: r2.m, mrn_line_id: r2.l, qty: 1, unit_price: 38000 }), 201);
  refused(await issue(r2, { qty: 1 }), 400, /serial number of each battery/);
  refused(await issue(r2, { qty: 1, serial_no: 'B-3' }), 409, /WP-4001 already has 2 batteries \(B-1, B-2\)\. Say which one is coming off/);
  refused(await issue(r2, { qty: 1, serial_no: 'B-3', old_serial: 'B-9' }), 404, /no battery B-9/);
  ok(await issue(r2, { qty: 1, serial_no: 'B-3', old_serial: 'B-1', old_condition: 'warranty' }), 201);
  assert.deepStrictEqual([battery('B-1').state, battery('B-1').current_asset_id], ['handed_over', null], 'gone back to the supplier on warranty');
  assert.strictEqual(battery('B-3').current_asset_id, ASSET);
  assert.deepStrictEqual(all('SELECT event_type FROM battery_events WHERE battery_id = ? ORDER BY id', battery('B-1').id).map((e) => e.event_type),
    ['add', 'install', 'remove', 'warranty']);

  const r3 = request('battery', 1);
  ok(await call('sk', 'POST', '/stores/grn', { mrn_id: r3.m, mrn_line_id: r3.l, qty: 1, unit_price: 38000 }), 201);
  ok(await issue(r3, { qty: 1, serial_no: 'B-4', old_serial: 'B-2', old_condition: 'scrap' }), 201);
  assert.strictEqual(battery('B-2').state, 'scrap');
  refused(await issue(request('battery', 1), { qty: 1, serial_no: 'B-5', old_serial: 'B-3', old_condition: 'scrap' }), 409, /0 in stock/);
  assert.strictEqual(battery('B-3').current_asset_id, ASSET, 'refused as a whole: the old one stays on');
});

test('the vehicle view: what it carries now, and every tyre and battery issued to it', async () => {
  const v = ok(await call('mgr', 'GET', `/tb/vehicle/${ASSET}`));
  assert.deepStrictEqual(v.tyres.map((t) => [t.position, t.serial_no]), [['FL', 'TY-B'], ['RR2', 'TY-D']]);
  assert.deepStrictEqual(v.batteries.map((b) => b.serial_no), ['B-3', 'B-4']);
  assert.strictEqual(v.tyres[0].spec, 'Tyre 1000 X 20');
  assert.strictEqual(v.issues.length, 8, 'four tyres and four batteries');
  assert.strictEqual(v.old_due, 2, 'the two tyres that went on at RL1 and RL2');
  refused(await call('mgr', 'GET', '/tb/vehicle/999999'), 404);
});

test('a tube goes out by count, and has no old unit to write down', async () => {
  const r = request('tube', 2);
  const t = ok(await issue(r, { qty: 2 }), 201);
  assert.strictEqual(t.old_unit_due, false);
  assert.ok(!ok(await call('sk', 'GET', '/tb/returns/outstanding')).some((o) => o.issue_id === t.id), 'only tyres and batteries wait for what came off');
  assert.strictEqual(ok(await call('sk', 'GET', `/tb/requests/${r.m}`)).lines[0].issued, 2, 'counted by quantity, not by rows');
  const v = ok(await call('mgr', 'GET', `/tb/vehicle/${ASSET}`));
  assert.deepStrictEqual([v.issues.length, v.old_due], [9, 2], 'the tube is listed, but is not an old unit to record');
});

// ================================================================== disposal notes
test('a disposal note lists scrap tyres and batteries, parts and waste oil', async () => {
  const scrap = ok(await call('sk', 'GET', '/stores/disposals/scrap'));
  assert.deepStrictEqual([scrap.tyres.map((t) => t.serial_no), scrap.batteries.map((b) => b.serial_no)], [['TY-A', 'TY-E'], ['B-2']]);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [] }), 400, /at least one/);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-B').id }] }), 409, /TY-B is installed, not scrap/);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'waste_oil' }] }), 400, /how much/);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'part', qty: 2 }] }), 400, /say what the part is/);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'scrap' }] }), 400, /say what it is/);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-E').id }, { kind: 'tyre', tyre_id: tyre('TY-E').id }] }), 400, /twice/);
  refused(await call('mgr', 'POST', '/stores/disposals', { lines: [{ kind: 'part', description: 'Drums', qty: 1 }] }), 403);
  const n = ok(await call('sk', 'POST', '/stores/disposals', { note: 'Yard clear-out', lines: [
    { kind: 'tyre', tyre_id: tyre('TY-A').id }, { kind: 'battery', battery_id: battery('B-2').id },
    { kind: 'part', description: 'Brake drums', qty: 4 }, { kind: 'waste_oil', qty: 200 }] }), 201);
  assert.match(n.disposal_no, /^DN-\d{4}-0001$/);
  assert.deepStrictEqual([n.status, n.store_id, n.lines.length, n.waste_oil_litres, n.can.approve, n.can.edit], ['open', CW, 4, 200, false, true]);
  assert.deepStrictEqual(n.lines.map((l) => [l.kind, l.qty, l.unit]), [['tyre', 1, 'nos'], ['battery', 1, 'nos'], ['part', 4, 'nos'], ['waste_oil', 200, 'L']]);
  refused(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-A').id }] }), 409, /TY-A is already on disposal note DN-/);
  assert.deepStrictEqual(ok(await call('sk', 'GET', '/stores/disposals/scrap')).tyres.map((t) => t.serial_no), ['TY-E'], 'what is on a note is not offered again');
  // The buyer can be written in while it is open.
  assert.strictEqual(ok(await call('sk', 'PUT', `/stores/disposals/${n.id}`, { buyer: 'Lanka Metal' })).buyer, 'Lanka Metal');
  G.note = n.id;
});

test('the Monitor counts old units still to write down and notes waiting for a manager', async () => {
  const m = ok(await call('sk', 'GET', '/stores/flow/monitor'));
  assert.deepStrictEqual([m.old_units_due, m.disposals], [{ tyre: 3, battery: 0 }, 1], 'TY-C on WP-4002, and TY-D and TY-E on WP-4001');
});

test('a manager approves with the buyer, the amount and the date; the units are disposed of', async () => {
  refused(await call('sk', 'POST', `/stores/disposals/${G.note}/approve`, { amount: 1, sale_date: TODAY }), 403);
  assert.strictEqual(ok(await call('mgr', 'GET', `/stores/disposals/${G.note}`)).can.approve, true);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { buyer: '' }), 400, /Who is buying/);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, {}), 400, /For how much/);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { amount: 18500, sale_date: '25/09/2026' }), 400, /YYYY-MM-DD/);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { amount: 18500 }), 400, /what date/);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { amount: -5, sale_date: TODAY }), 400, /0 or more/);
  const a = ok(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { amount: 18500, sale_date: TODAY }));
  assert.deepStrictEqual([a.status, a.buyer, a.amount, a.sale_date, a.decided_by_name], ['approved', 'Lanka Metal', 18500, TODAY, 'mgr']);
  assert.deepStrictEqual([tyre('TY-A').state, battery('B-2').state], ['disposed', 'disposed']);
  assert.match(get("SELECT reason FROM tyre_events WHERE tyre_id = ? AND event_type = 'dispose'", tyre('TY-A').id).reason, /DN-\d{4}-0001 · Lanka Metal/);
  refused(await call('mgr', 'POST', `/stores/disposals/${G.note}/approve`, { amount: 1, sale_date: TODAY }), 409, /is approved/);
  refused(await call('sk', 'PUT', `/stores/disposals/${G.note}`, { buyer: 'x' }), 409);
  // A disposed tyre is never fitted again.
  refused(await issue(request('tyre', 1, { position: 'RR1' }), { qty: 1, serial_no: 'TY-A', issue_date: day(-1) }), 409, /TY-A is disposed/);
  assert.strictEqual(ok(await call('sk', 'GET', '/stores/flow/monitor')).disposals, 0);
});

test('a note is cancelled with a reason; its units are free for the next one', async () => {
  const n = ok(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-E').id }] }), 201);
  refused(await call('sk', 'POST', `/stores/disposals/${n.id}/cancel`, {}), 400, /why/);
  const c = ok(await call('sk', 'POST', `/stores/disposals/${n.id}/cancel`, { reason: 'Buyer did not come' }));
  assert.deepStrictEqual([c.status, c.decision_note, c.can.edit], ['cancelled', 'Buyer did not come', false]);
  assert.strictEqual(tyre('TY-E').state, 'scrap', 'still scrap, still in the yard');
  const again = ok(await call('sk', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-E').id }] }), 201);
  // A unit that is no longer scrap (put right by hand here) cannot be approved away.
  run("UPDATE tyres SET state = 'retread' WHERE serial_no = 'TY-E'");
  refused(await call('mgr', 'POST', `/stores/disposals/${again.id}/approve`, { buyer: 'x', amount: 0, sale_date: TODAY }), 409, /no longer scrap/);
  assert.strictEqual(ok(await call('mgr', 'GET', `/stores/disposals/${again.id}`)).status, 'open', 'nothing was approved');
  run("UPDATE tyres SET state = 'scrap' WHERE serial_no = 'TY-E'");
  refused(await call('sk', 'POST', `/stores/disposals/${G.note}/cancel`, { reason: 'too late' }), 409, /is approved/);
  // A manager cancels from stores=view.
  ok(await call('mgr', 'POST', `/stores/disposals/${again.id}/cancel`, { reason: 'Wrong buyer' }));
  const list = ok(await call('mgr', 'GET', '/stores/disposals'));
  assert.deepStrictEqual(list.map((d) => d.status), ['cancelled', 'cancelled', 'approved'], 'newest first');
  assert.deepStrictEqual(ok(await call('mgr', 'GET', '/stores/disposals?status=approved')).map((d) => d.id), [G.note]);
});

// ================================================================== store by store
test('with a store in each workshop, each store writes its own notes; head office sees all', async () => {
  run('UPDATE workshops SET own_store = 1 WHERE id = ?', MTR);
  scope.setSwitch({ id: U.boss }, true);
  try {
    assert.deepStrictEqual(ok(await call('skM', 'GET', '/stores/disposals')), [], 'Muthur sees none of the main store\'s');
    refused(await call('skM', 'GET', `/stores/disposals/${G.note}`), 403, /You see only your own store/);
    assert.deepStrictEqual(ok(await call('skM', 'GET', '/stores/disposals/scrap')).tyres, [], 'the main store\'s scrap is not Muthur\'s');
    refused(await call('skM', 'POST', '/stores/disposals', { lines: [{ kind: 'tyre', tyre_id: tyre('TY-E').id }] }), 409, /belongs to /);
    const n = ok(await call('skM', 'POST', '/stores/disposals', { store_id: CW, lines: [{ kind: 'waste_oil', qty: 60 }] }), 201);
    assert.strictEqual(n.store_id, MTR, 'store staff: their own store, whatever is asked');
    assert.deepStrictEqual(ok(await call('skM', 'GET', '/stores/flow/monitor')).disposals, 1);
    assert.strictEqual(ok(await call('sk', 'GET', '/stores/flow/monitor')).disposals, 0, 'the main store has none waiting');
    assert.ok(ok(await call('mgr', 'GET', '/stores/disposals')).some((d) => d.store_id === MTR), 'head office: every store');
    // Only head office approves — not the store's own supervisor, even with the right to approve.
    refused(await call('skM', 'POST', `/stores/disposals/${n.id}/approve`, { buyer: 'x', amount: 0, sale_date: TODAY }), 403);
    refused(await call('lead', 'POST', `/stores/disposals/${n.id}/approve`, { buyer: 'x', amount: 0, sale_date: TODAY }), 403, /A manager approves/);
    assert.strictEqual(ok(await call('lead', 'GET', `/stores/disposals/${n.id}`)).can.approve, false);
    ok(await call('mgr', 'POST', `/stores/disposals/${n.id}/approve`, { buyer: 'Oil Recyclers', amount: 0, sale_date: TODAY }));
  } finally {
    scope.setSwitch({ id: U.boss }, false);
    run('UPDATE workshops SET own_store = 0 WHERE id = ?', MTR);
  }
});

// ================================================================== what came off, named later
test('what came off can name a tyre the register knows — or one it never knew', async () => {
  // TY-B is on WP-4001 at FL; the fitter says it is what came off for TY-D.
  ok(await call('sk', 'POST', '/tb/returns', { issue_id: G.t4[0], condition: 'repairable', serial_no: 'TY-B' }), 201);
  assert.deepStrictEqual([tyre('TY-B').state, tyre('TY-B').current_asset_id], ['repair', null], 'taken off, and at repair');
  assert.deepStrictEqual(tyreEvents('TY-B').slice(-2), ['remove', 'repairable']);
  // A tyre the register never knew is recorded now, so it can still leave on a disposal note.
  ok(await call('sk', 'POST', '/tb/returns', { issue_id: G.t2, condition: 'scrap', serial_no: 'TY-Z9' }), 201);
  assert.deepStrictEqual([tyre('TY-Z9').state, tyre('TY-Z9').spec_id], ['scrap', TYRE]);
  assert.strictEqual(get('SELECT old_unit_id FROM tyre_battery_issues WHERE id = ?', G.t2).old_unit_id, tyre('TY-Z9').id);
  assert.ok(ok(await call('sk', 'GET', '/stores/disposals/scrap')).tyres.some((t) => t.serial_no === 'TY-Z9'));
});

// ================================================================== the books already kept
test('tyre and battery receipts already on the books are moved to their size once, at start', () => {
  const g = get('SELECT g.id FROM grn g JOIN tb_request_lines r ON r.mrn_line_id = g.mrn_line_id ORDER BY g.id LIMIT 1').id;
  const key = get("SELECT item_key FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", g).item_key;
  run("UPDATE stock_moves SET item_key = 'AS FILED BEFORE' WHERE source_table = 'grn' AND source_id = ?", g);
  run("DELETE FROM settings WHERE key = 'stock_tb_by_spec'");
  migrate();
  assert.strictEqual(get("SELECT item_key FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", g).item_key, key);
  run("UPDATE stock_moves SET item_key = 'AS FILED BEFORE' WHERE source_table = 'grn' AND source_id = ?", g);
  migrate();
  assert.strictEqual(get("SELECT item_key FROM stock_moves WHERE source_table = 'grn' AND source_id = ?", g).item_key, 'AS FILED BEFORE', 'once only');
  run('DELETE FROM stock_moves WHERE source_table = ? AND source_id = ?', 'grn', g);
  require('../src/lib/stock').sync({ grn: [g] });
});
