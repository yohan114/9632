'use strict';

// Improvement plan, Step 2 — the rest of a workshop's own records are kept apart too.
//
//   Service records and tools belong to a workshop, like job cards (service_jobs.workshop_id,
//   workshop_tools.workshop_id). Stock and what sits on a store's shelf — oil, general items, tyres,
//   batteries, the tyre & battery ledger, the stock cockpit — belong to a store (Stage 4). With the
//   workshops kept apart, someone outside head office sees and works on their own; head office sees
//   everything; and while the workshops are not kept apart nothing changes for anyone.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step2-'));
process.env.DB_PATH = path.join(TMP, 'step2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const stores = require('../src/lib/stores');
const stock = require('../src/lib/stock');
const scope = require('../src/lib/scope');

migrate();
for (const n of ['admin', 'workshop', 'manager', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const KDY = run("INSERT INTO workshops (code, name, place) VALUES ('KDY', 'Kandy Workshop', 'Kandy')").lastInsertRowid;   // uses Central's store
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('site_clerk', 'Site clerk')");
run("INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES ('site_clerk', 'tb_reports', 'full')");
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = {
  boss: mkUser('boss', ['admin']), mgr: mkUser('mgr', ['manager']),
  skC: mkUser('skC', ['storekeeper']), skM: mkUser('skM', ['storekeeper'], MTR), wsM: mkUser('wsM', ['workshop'], MTR),
  wsK: mkUser('wsK', ['workshop'], KDY), clkM: mkUser('clkM', ['site_clerk'], MTR),
};
const actor = { id: U.boss, roles: ['admin'] };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
function job(ws) {
  const no = `2026/10/R/${900 + (++seq)}`;
  const id = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
                  VALUES (?, ?, 'repair', 'fault', 'IN_PROGRESS', 0, ?, ?)`, no, asset('V-' + seq), day(-5), ws).lastInsertRowid;
  return { id, no };
}
const J = { c: job(CW), m: job(MTR) };
const service = (jobNo, extra = {}) => run(
  `INSERT INTO service_jobs (vehicle_label, service_date, job_no, store_id, workshop_id) VALUES ('X', ?, ?, ?, ?)`,
  TODAY, jobNo, extra.store || null, extra.ws || null).lastInsertRowid;
const mechanic = (name, ws) => {
  const id = run('INSERT INTO mechanics (name, name_norm, active) VALUES (?, ?, 1)', name, name.toLowerCase()).lastInsertRowid;
  if (ws) run('INSERT INTO mechanic_workshops (mechanic_id, workshop_id, from_date) VALUES (?, ?, ?)', id, ws, '2020-01-01');
  return id;
};
const tool = (code, opts = {}) => run(
  `INSERT INTO workshop_tools (tool_code, name, type, mechanic_id, workshop_id) VALUES (?, ?, ?, ?, ?)`,
  code, 'Tool ' + code, opts.mech ? 'mechanic' : 'common', opts.mech || null, opts.ws || null).lastInsertRowid;

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
const GET = async (user, p) => req('GET', p, { cookie: await as(user) });
const separate = (on) => scope.setSwitch(actor, on);

// ================================================================== the workshop each one belongs to
test('a service record is its job card\'s workshop\'s, else the store it drew from, else the main one\'s; a tool its own, else its mechanic\'s', () => {
  stores.setStore(actor, MTR, { own: true, opened: TODAY });
  const ws = (id) => get('SELECT workshop_id w FROM service_jobs WHERE id = ?', id).w;
  assert.strictEqual(ws(service(J.m.no)), MTR, 'filed against Muthur\'s card');
  assert.strictEqual(ws(service(null, { store: MTR })), MTR, 'no card: the store it drew from');
  assert.strictEqual(ws(service(null)), CW, 'nothing to go by: the main workshop');
  assert.strictEqual(ws(service(J.m.no, { ws: CW })), CW, 'a workshop written by the route is kept');

  const mM = mechanic('Muthu', MTR);
  const tws = (id) => get('SELECT workshop_id w FROM workshop_tools WHERE id = ?', id).w;
  assert.strictEqual(tws(tool('T-BOX', { mech: mM })), MTR, 'a toolbox is its mechanic\'s workshop\'s');
  assert.strictEqual(tws(tool('T-COM')), CW);

  // The upgrade fills in what has none, by the same rule.
  run("UPDATE service_jobs SET workshop_id = NULL WHERE job_no = ?", J.m.no);
  run("UPDATE workshop_tools SET workshop_id = NULL WHERE tool_code = 'T-BOX'");
  migrate();
  assert.ok(all('SELECT workshop_id w FROM service_jobs WHERE job_no = ?', J.m.no).every((r) => r.w === MTR));
  assert.strictEqual(get("SELECT workshop_id w FROM workshop_tools WHERE tool_code = 'T-BOX'").w, MTR);
  run('DELETE FROM service_jobs'); run('DELETE FROM workshop_tools');
});

// ================================================================== fixtures for the rest
const S = {};
test('fixtures: services, tools, oil, general items, tyres and batteries in both workshops', () => {
  S.svcC = service(J.c.no); S.svcM = service(J.m.no);
  S.attC = run("INSERT INTO service_attachments (service_id, filename, mime, size_bytes, data) VALUES (?, 'c.pdf', 'application/pdf', 5, ?)",
    S.svcC, Buffer.from('%PDF-')).lastInsertRowid;
  S.mechC = mechanic('Chandra', CW); S.mechM = mechanic('Mohan', MTR);
  S.toolC = tool('TC-1', { ws: CW }); S.toolM = tool('TM-1', { ws: MTR });
  S.boxM = tool('TM-BOX', { mech: S.mechM });
  for (const [t, ws] of [[S.toolC, 'C'], [S.toolM, 'M']]) {
    run(`INSERT INTO tool_issue_logs (log_no, tool_id, issued_to_name, issue_date, issued_by) VALUES (?, ?, 'someone', ?, ?)`, 'TIL-' + ws, t, TODAY, U.boss);
    run(`INSERT INTO tool_scrap_requests (request_no, tool_id, tool_code, tool_name, damage_date, damage_reason, reported_by)
         VALUES (?, ?, 'x', 'x', ?, 'broke', ?)`, 'TSR-' + ws, t, TODAY, U.boss);
  }
  S.logC = get("SELECT id FROM tool_issue_logs WHERE log_no = 'TIL-C'").id;
  S.scrapC = get("SELECT id FROM tool_scrap_requests WHERE request_no = 'TSR-C'").id;

  // Oil: 100 L in Central's store, 30 L in Muthur's; Muthur reorders at 40.
  S.oil = run("INSERT INTO products (code, name, unit, reorder_level, unit_price, active) VALUES ('OIL-9001', 'Engine Oil 15W40', 'L', 500, 10, 1)").lastInsertRowid;
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 100, 100, 10, ?, ?)", S.oil, TODAY, CW);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 30, 130, 10, ?, ?)", S.oil, TODAY, MTR);
  require('../src/lib/lubricants').seedCatalogueAliases();   // the oil book knows its own product names
  S.oilKey = stock.itemKey('oil', 'Engine Oil 15W40', 'OIL-9001');
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'oil', ?, 40)", MTR, S.oilKey);
  // A general item: 8 in Central's store, 3 in Muthur's.
  S.rag = run("INSERT INTO store_items (name, category, is_general, balance, min_stock, unit_cost) VALUES ('Shop Rag', 'General Items', 1, 11, 2, 5)").lastInsertRowid;
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, store_id) VALUES (?, 'opening', 8, 8, ?, ?)", S.rag, TODAY, CW);
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, store_id) VALUES (?, 'opening', 3, 11, ?, ?)", S.rag, TODAY, MTR);
  S.brg = run("INSERT INTO store_items (name, category, is_general, balance) VALUES ('6204 Bearing', 'General Items', 1, 1)").lastInsertRowid;
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, store_id) VALUES (?, 'opening', 1, 1, ?, ?)", S.brg, TODAY, MTR);
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'general', ?, 5)", MTR, stock.itemKey('general', '6204 Bearing'));
  // Tyres, batteries, and an issue of each store's still waiting for its old unit.
  S.tyreC = run("INSERT INTO tyres (serial_no, state, store_id) VALUES ('TY-C', 'in_store', ?)", CW).lastInsertRowid;
  S.tyreM = run("INSERT INTO tyres (serial_no, state, store_id) VALUES ('TY-M', 'in_store', ?)", MTR).lastInsertRowid;
  S.tyreOld = run("INSERT INTO tyres (serial_no, state) VALUES ('TY-OLD', 'in_store')").lastInsertRowid;   // no store: Central's
  S.batC = run("INSERT INTO batteries (serial_no, state, store_id, warranty_date) VALUES ('BA-C', 'in_store', ?, ?)", CW, day(10)).lastInsertRowid;
  S.batM = run("INSERT INTO batteries (serial_no, state, store_id, warranty_date) VALUES ('BA-M', 'in_store', ?, ?)", MTR, day(10)).lastInsertRowid;
  S.tbC = run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, category, category_norm, source, store_id) VALUES ('tyre', ?, 1, '10R20', '10R20', 'request', ?)", TODAY, CW).lastInsertRowid;
  S.tbM = run("INSERT INTO tyre_battery_issues (kind, issue_date, qty, category, category_norm, source, store_id) VALUES ('tyre', ?, 1, '10R20', '10R20', 'request', ?)", TODAY, MTR).lastInsertRowid;
  stock.rebuild({ wipe: true });
  assert.strictEqual(stock.balanceOf('oil', S.oilKey, MTR), 30);
  assert.strictEqual(stock.balanceOf('general', stock.itemKey('general', 'Shop Rag'), MTR), 3);
});

// ================================================================== switched off: as before
test('while the workshops are not kept apart, everyone sees everything, as before', async () => {
  separate(false);
  assert.strictEqual(scope.ownStore({ id: U.skM, roles: ['storekeeper'] }), null);
  const svc = (await GET('wsM', '/api/filters/services')).body.map((s) => s.id);
  assert.ok(svc.includes(S.svcC) && svc.includes(S.svcM));
  assert.strictEqual((await GET('wsM', `/api/filters/services/${S.svcC}`)).status, 200);
  const tools = (await GET('wsM', '/api/tools')).body.tools.map((t) => t.id);
  assert.ok(tools.includes(S.toolC) && tools.includes(S.toolM));
  assert.strictEqual((await GET('skM', '/api/oil/ledger')).body.length, 2);
  assert.strictEqual((await GET('skM', '/api/filter-stock')).status, 200);
  assert.strictEqual((await GET('skM', '/api/batteries')).body.length, 2);
  assert.strictEqual((await GET('skM', '/api/auth/me')).body.ownStore, null);
});

// ================================================================== service records
test('service records: a site lists, opens, edits, prints and attaches to its own only', async () => {
  separate(true);
  const mine = (await GET('wsM', '/api/filters/services')).body;
  assert.deepStrictEqual(mine.map((s) => s.id), [S.svcM], 'Muthur lists its own service only');
  assert.strictEqual(mine[0].workshop_code, 'MTR');
  const all2 = (await GET('mgr', '/api/filters/services')).body.map((s) => s.id);
  assert.ok(all2.includes(S.svcC) && all2.includes(S.svcM), 'head office lists both');

  const no = await GET('wsM', `/api/filters/services/${S.svcC}`);
  assert.strictEqual(no.status, 403);
  assert.match(no.body.error, /Central/);
  assert.strictEqual(no.body.other_workshop.id, CW);
  assert.strictEqual((await GET('wsM', `/api/filters/services/${S.svcM}`)).status, 200);
  assert.strictEqual((await GET('wsM', `/api/filters/services/${S.svcC}/print.html`)).status, 403);
  assert.strictEqual((await GET('wsM', `/api/filters/services/${S.svcC}/attachments`)).status, 403);
  assert.strictEqual((await GET('wsM', `/api/filters/attachments/${S.attC}`)).status, 403);
  assert.strictEqual((await GET('mgr', `/api/filters/attachments/${S.attC}`)).status, 200);
  assert.strictEqual((await req('DELETE', `/api/filters/attachments/${S.attC}`, { cookie: await as('wsM') })).status, 403);
  assert.strictEqual((await GET('wsM', `/api/filters/stock-context?service_id=${S.svcC}`)).status, 403);
  assert.strictEqual((await GET('wsM', `/api/filters/stock-search?q=x&job_no=${encodeURIComponent(J.c.no)}`)).status, 403);
  assert.strictEqual((await req('PUT', `/api/filters/services/${S.svcC}`, { cookie: await as('wsM'), body: { service_date: TODAY } })).status, 403);
  const before = get('SELECT vehicle_label FROM service_jobs WHERE id = ?', S.svcC).vehicle_label;
  assert.strictEqual(before, 'X', 'refused, and nothing written');

  // A new service: never against another workshop's card; without a card, it is the writer's.
  const body = { service_date: TODAY, asset_id: asset('V-NEW'), filters: [], oils: [], parts: [] };
  assert.strictEqual((await req('POST', '/api/filters/services', { cookie: await as('wsM'), body: { ...body, job_no: J.c.no } })).status, 403);
  const made = await req('POST', '/api/filters/services', { cookie: await as('wsM'), body });
  assert.strictEqual(made.status, 201, made.text);
  assert.strictEqual(made.body.service.workshop_id, MTR);
  const kdy = await req('POST', '/api/filters/services', { cookie: await as('wsK'), body });
  assert.strictEqual(kdy.body.service.store_id, CW, 'Kandy draws from Central\'s store…');
  assert.strictEqual(kdy.body.service.workshop_id, KDY, '…and the service is still Kandy\'s');
  const onCard = await req('POST', '/api/filters/services', { cookie: await as('boss'), body: { ...body, job_no: J.m.no } });
  assert.strictEqual(onCard.body.service.workshop_id, MTR, 'head office files it against Muthur\'s card: Muthur\'s');
  // And an edit cannot move it onto another workshop's card.
  assert.strictEqual((await req('PUT', `/api/filters/services/${made.body.service.id}`, { cookie: await as('wsM'), body: { ...body, job_no: J.c.no } })).status, 403);
});

// ================================================================== tools
test('tools: a site sees its own tools, toolboxes, log and scrap requests, and works on nothing else', async () => {
  const ids = (r) => r.body.tools.map((t) => t.id).sort();
  assert.deepStrictEqual(ids(await GET('wsM', '/api/tools')), [S.toolM, S.boxM].sort());
  assert.ok(ids(await GET('mgr', '/api/tools')).includes(S.toolC));
  assert.strictEqual((await GET('wsM', '/api/tools/stats')).body.total_tools, 2);
  assert.strictEqual((await GET('wsM', '/api/tools/stats')).body.pending_scrap, 1);
  const boxes = (await GET('wsM', '/api/tools/mechanic-boxes')).body.map((m) => m.name);
  assert.ok(boxes.includes('Mohan') && !boxes.includes('Chandra'), 'the mechanics of Muthur only');

  assert.strictEqual((await GET('wsM', `/api/tools/${S.toolC}`)).status, 403);
  assert.strictEqual((await GET('wsM', `/api/tools/${S.toolM}`)).status, 200);
  // The log and the scrap list answer at all (the tool page stood in front of them) — and only Muthur's.
  const logs = await GET('wsM', '/api/tools/logs');
  assert.strictEqual(logs.status, 200);
  assert.deepStrictEqual(logs.body.map((l) => l.log_no), ['TIL-M']);
  assert.strictEqual((await GET('mgr', '/api/tools/logs')).body.length, 2);
  const scrap = await GET('wsM', '/api/tools/scrap-requests');
  assert.deepStrictEqual(scrap.body.map((s) => s.request_no), ['TSR-M']);
  assert.strictEqual((await GET('wsM', `/api/tools/scrap-requests/${S.scrapC}`)).status, 403);
  assert.strictEqual((await GET('wsM', `/api/tools/scrap-requests/${S.scrapC}/print.html`)).status, 403);

  const c = await as('skM');
  assert.strictEqual((await req('POST', '/api/tools', { cookie: c, body: { name: 'Spanner', workshop_id: CW } })).status, 403);
  assert.strictEqual((await req('POST', '/api/tools', { cookie: c, body: { name: 'Spanner', mechanic_id: S.mechC } })).status, 403, 'not into another workshop\'s toolbox');
  const made = await req('POST', '/api/tools', { cookie: c, body: { name: 'Spanner' } });
  assert.strictEqual(made.status, 201, made.text);
  assert.strictEqual(made.body.workshop_id, MTR);
  assert.strictEqual((await req('PATCH', `/api/tools/${S.toolC}`, { cookie: c, body: { name: 'Mine now' } })).status, 403);
  assert.strictEqual((await req('PATCH', `/api/tools/${S.toolM}`, { cookie: c, body: { mechanic_id: S.mechC } })).status, 403, 'not into Central\'s mechanic\'s toolbox');
  assert.strictEqual(get('SELECT mechanic_id FROM workshop_tools WHERE id = ?', S.toolM).mechanic_id, null);
  assert.strictEqual((await req('POST', '/api/tools/logs/issue', { cookie: c, body: { tool_id: S.toolC, issued_to_name: 'x' } })).status, 403);
  assert.strictEqual((await req('POST', `/api/tools/logs/${S.logC}/return`, { cookie: c, body: {} })).status, 403);
  assert.strictEqual((await req('POST', '/api/tools/scrap-requests', { cookie: c, body: { tool_id: S.toolC, damage_reason: 'x' } })).status, 403);
  assert.strictEqual((await req('DELETE', `/api/tools/${S.toolC}`, { cookie: c })).status, 403);
  assert.strictEqual(get('SELECT name FROM workshop_tools WHERE id = ?', S.toolC).name, 'Tool TC-1', 'nothing changed');
});

// ================================================================== stock, store by store
test('oil: a site reads its own store\'s ledger, shelf, reorder level and forecast; the company counts are not its', async () => {
  const c = await as('skM');
  const ledger = (await req('GET', '/api/oil/ledger', { cookie: c })).body;
  assert.deepStrictEqual(ledger.map((r) => r.store_id), [MTR]);
  assert.strictEqual((await GET('mgr', '/api/oil/ledger')).body.length, 2);
  const p = (await req('GET', '/api/oil/stock-summary', { cookie: c })).body.groups.flatMap((g) => g.products).find((x) => x.id === S.oil);
  assert.strictEqual(p.stock_qty, 30, 'Muthur\'s shelf');
  assert.strictEqual(p.reorder_level, 40, 'Muthur\'s own reorder level');
  assert.strictEqual(p.status, 'low');
  assert.deepStrictEqual((await req('GET', '/api/oil/low-stock', { cookie: c })).body.map((x) => x.id), [S.oil]);
  assert.strictEqual((await req('GET', '/api/oil/balances', { cookie: c })).body.find((x) => x.product_id === S.oil).balance, 30);
  assert.strictEqual((await req('GET', '/api/oil/forecast', { cookie: c })).body.products.find((x) => x.id === S.oil).balance, 30);
  const counts = await req('GET', '/api/oil/counts', { cookie: c });
  assert.strictEqual(counts.status, 409);
  assert.match(counts.body.error, /store by store/);
  assert.strictEqual((await req('POST', '/api/oil/counts', { cookie: c, body: { product_id: S.oil, period: '2026-10', counted_qty: 1 } })).status, 409);
  assert.strictEqual((await GET('mgr', '/api/oil/counts')).status, 200, 'head office still has the company counts');
  const x = await fetch(`http://127.0.0.1:${port}/api/oil/export/ledger.xlsx`, { headers: { Cookie: c } });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  assert.strictEqual(wb.worksheets[0].rowCount, 2, 'the header and Muthur\'s one movement');
});

test('general items: a site sees its own store\'s balance and movements; the company register is head office\'s', async () => {
  const c = await as('skM');
  const item = (await req('GET', '/api/general-stock/items', { cookie: c })).body.find((i) => i.id === S.rag);
  assert.strictEqual(item.balance, 3);
  assert.strictEqual(item.total_value, 15);
  assert.strictEqual((await GET('mgr', '/api/general-stock/items')).body.find((i) => i.id === S.rag).balance, 11, 'head office: the company');
  const one = (await req('GET', `/api/general-stock/items/${S.rag}`, { cookie: c })).body;
  assert.strictEqual(one.item.balance, 3);
  assert.strictEqual(one.ledger.length, 1, 'Muthur\'s movement only');
  assert.strictEqual((await req('GET', '/api/general-stock/summary', { cookie: c })).body.total_value >= 15, true);
  const fs409 = await req('GET', '/api/filter-stock', { cookie: c });
  assert.strictEqual(fs409.status, 409);
  assert.match(fs409.body.error, /Stores → Stock/);
  assert.strictEqual((await GET('mgr', '/api/filter-stock')).status, 200);
});

test('tyres and batteries: a site\'s register, returns and ledger are its own store\'s', async () => {
  const c = await as('skM');
  assert.deepStrictEqual((await req('GET', '/api/batteries', { cookie: c })).body.map((b) => b.id), [S.batM]);
  assert.strictEqual((await GET('mgr', '/api/batteries')).body.length, 2);
  assert.strictEqual((await req('GET', `/api/batteries/${S.batC}`, { cookie: c })).status, 403);
  assert.strictEqual((await req('GET', '/api/batteries/whereis/BA-C', { cookie: c })).status, 403);
  assert.strictEqual((await req('POST', `/api/batteries/${S.batC}/event`, { cookie: c, body: { event_type: 'decommission' } })).status, 403);
  assert.deepStrictEqual((await req('GET', '/api/batteries/warranty-radar', { cookie: c })).body.expiring.map((b) => b.id), [S.batM]);
  const reg = await req('POST', '/api/batteries', { cookie: c, body: { serial_no: 'BA-NEW' } });
  assert.strictEqual(reg.body.store_id, MTR, 'registered on Muthur\'s register');

  const tyres = (await req('GET', '/api/tb/tyres', { cookie: c })).body.map((t) => t.id);
  assert.deepStrictEqual(tyres, [S.tyreM]);
  assert.deepStrictEqual((await GET('skC', '/api/tb/tyres')).body.map((t) => t.id).sort(), [S.tyreC, S.tyreOld].sort(), 'a tyre with no store is Central\'s');
  assert.strictEqual((await req('GET', `/api/tb/tyres/${S.tyreC}`, { cookie: c })).status, 403);
  assert.strictEqual((await req('POST', `/api/tb/tyres/${S.tyreC}/event`, { cookie: c, body: { event_type: 'scrap' } })).status, 403);
  assert.strictEqual(get('SELECT state FROM tyres WHERE id = ?', S.tyreC).state, 'in_store');
  assert.deepStrictEqual((await req('GET', '/api/tb/returns/outstanding', { cookie: c })).body.map((r) => r.issue_id), [S.tbM]);
  assert.strictEqual((await req('POST', '/api/tb/returns', { cookie: c, body: { issue_id: S.tbC, condition: 'scrap' } })).status, 403);

  const led = (await req('GET', '/api/tyre-battery/issues?kind=tyre', { cookie: c })).body;
  assert.deepStrictEqual(led.issues.map((i) => i.id), [S.tbM]);
  assert.strictEqual((await req('GET', '/api/tyre-battery/summary', { cookie: c })).body.tyre.issues, 1);
  assert.strictEqual((await GET('mgr', '/api/tyre-battery/summary')).body.tyre.issues, 2);
  const clk = await as('clkM');
  assert.strictEqual((await req('PATCH', `/api/tyre-battery/issues/${S.tbM}`, { cookie: clk, body: { unit_price: 1 } })).status, 200, 'its own store\'s');
  assert.strictEqual((await req('PATCH', `/api/tyre-battery/issues/${S.tbC}`, { cookie: clk, body: { unit_price: 1 } })).status, 403);
  assert.strictEqual(get('SELECT unit_price FROM tyre_battery_issues WHERE id = ?', S.tbC).unit_price, null);
});

test('the stock cockpit: a site\'s board is its own store\'s; head office keeps the company\'s', async () => {
  const c = await as('skM');
  const ov = (await req('GET', '/api/stock-cockpit/overview', { cookie: c })).body;
  assert.strictEqual(ov.store_id, MTR);
  assert.strictEqual(ov.valuation_breakdown.oil, 300, '30 L at Rs 10');
  assert.strictEqual(ov.sku_counts.in_store_batteries, 2, 'BA-M and the one just registered');
  const alert = ov.reorder_alerts.find((a) => a.section === 'oil');
  assert.strictEqual(alert.current_stock, 30);
  assert.strictEqual(alert.reorder_level, 40);
  const brg = ov.reorder_alerts.find((a) => a.name === '6204 Bearing');
  assert.ok(brg, 'Muthur\'s bearing is under its level');
  assert.ok(Number.isNaN(Number.parseInt(brg.item_id, 10)), 'a key like 6204BEARING is never read as store_items id 6204');
  const found = (await req('GET', '/api/stock-cockpit/search?q=BA-', { cookie: c })).body.map((r) => r.code);
  assert.ok(found.includes('BA-M') && !found.includes('BA-C'));
  const hq = (await GET('mgr', '/api/stock-cockpit/overview')).body;
  assert.strictEqual(hq.store_id, undefined, 'head office: the company board, as before');
  assert.ok((await GET('mgr', '/api/stock-cockpit/search?q=BA-')).body.some((r) => r.code === 'BA-C'));
});

test('the dashboard and the Stores Monitor count a site\'s own oil and batteries; sign-in and /auth/me name its store', async () => {
  const d = (await GET('skM', '/api/reports/dashboard')).body;
  assert.deepStrictEqual(d.low_stock_oil.map((p) => p.balance), [30]);
  assert.deepStrictEqual(d.batteries_warranty.map((b) => b.serial_no), ['BA-M']);
  assert.strictEqual((await GET('skM', '/api/auth/me')).body.ownStore, MTR);
  assert.strictEqual((await GET('mgr', '/api/auth/me')).body.ownStore, null);
  // The sign-in reply says the same, so the screens are right before the page is next reloaded.
  const signIn = (u) => req('POST', '/api/auth/login', { body: { username: u, password: PW } });
  const fresh = (await signIn('skM')).body;
  const me = (await GET('skM', '/api/auth/me')).body;
  for (const k of ['workshop', 'workshopsMulti', 'seesAllWorkshops', 'workshopsSeen', 'ownStore']) {
    assert.deepStrictEqual(fresh[k], me[k], k);
  }
  assert.strictEqual(fresh.ownStore, MTR);
  assert.strictEqual(fresh.workshopsMulti, true);
  const boss = (await signIn('boss')).body;
  assert.strictEqual(boss.ownStore, null);
  assert.strictEqual(boss.seesAllWorkshops, true);
  const mon = (await GET('skM', '/api/stores/flow/monitor')).body;
  assert.strictEqual(mon.battery_warranty, 1);
});
