'use strict';

// Improvement plan, Step 2c — the Stores and purchasing lists are kept apart too.
//
//   With the workshops kept apart, someone outside head office sees and works on their own
//   workshops' receipts, receipt vouchers, issues, issue notes, transfer notes, pending request lines
//   and purchase lines; item lists show their own store's balances. A receipt is its request's
//   workshop's, else its store's; an issue its job card's, else its store's; an issue note and a
//   transfer note carry a workshop of their own. Head office still sees everything, and while the
//   workshops are not kept apart nothing changes for anyone.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-step2c-'));
process.env.DB_PATH = path.join(TMP, 'step2c.db');
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
for (const n of ['admin', 'workshop', 'storekeeper']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
// A Muthur store keeper who also signs for the workshop, and opens the other sections these lists live in.
run("INSERT OR IGNORE INTO roles (name, label) VALUES ('site_extra', 'Site extra')");
for (const [m, l] of [['stores', 'full'], ['jobs', 'view'], ['labour', 'view'], ['purchasing', 'view'], ['oil', 'view']]) {
  run('INSERT OR REPLACE INTO role_permissions (role, module, level) VALUES (?, ?, ?)', 'site_extra', m, l);
}
const CW = workshops.defaultId();
const MTR = run("INSERT INTO workshops (code, name, place) VALUES ('MTR', 'Muthur Workshop', 'Muthur')").lastInsertRowid;
const PW = 'ember-harbour-quarry';
function mkUser(username, roles, ws = CW) {
  const id = run('INSERT INTO users (username, password_hash, active, workshop_id) VALUES (?, ?, 1, ?)', username, auth.hashPassword(PW), ws).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), kM: mkUser('kM', ['storekeeper', 'workshop', 'site_extra'], MTR) };
const actor = { id: U.boss, roles: ['admin'] };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const TODAY = day(0);
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;

// ================================================================== fixtures
const S = {};
test('fixtures: each workshop with a card, a request, a receipt, a voucher, an issue, an issue note and transfers', () => {
  stores.setStore(actor, MTR, { own: true, opened: TODAY });
  const job = (ws) => {
    const no = `2026/10/R/${700 + (++seq)}`;
    return { id: run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, is_historical, requested_at, workshop_id)
                     VALUES (?, ?, 'repair', 'fault', 'IN_PROGRESS', 0, ?, ?)`, no, asset('V-' + seq), TODAY, ws).lastInsertRowid, no };
  };
  S.jC = job(CW); S.jM = job(MTR);
  const mrn = (no, ws, jobId) => run(`INSERT INTO mrn (mrn_no, job_id, workshop_id, req_date, approval_status, requested_by)
                                      VALUES (?, ?, ?, ?, 'approved', 'someone')`, no, jobId, ws, TODAY).lastInsertRowid;
  const line = (m, desc) => run('INSERT INTO mrn_lines (mrn_id, description, qty) VALUES (?, ?, 5)', m, desc).lastInsertRowid;
  S.mC = mrn('900001', CW, S.jC.id); S.mM = mrn('900002', MTR, S.jM.id);
  S.lC = line(S.mC, 'Central gasket'); S.lM = line(S.mM, 'Muthur seal');
  S.lC2 = line(S.mC, 'Central bolt'); S.lM2 = line(S.mM, 'Muthur nut');
  const grn = (m, l, desc, store) => run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, delivery_date, store_id)
                                          VALUES (?, ?, ?, ?, 1, ?, ?)`, 'G-' + (++seq), m, l, desc, TODAY, store).lastInsertRowid;
  S.gC = grn(S.mC, S.lC, 'Central gasket', CW); S.gM = grn(S.mM, S.lM, 'Muthur seal', MTR);
  // A request with no card, received at Central: Central's.
  S.mCnj = mrn('900003', CW, null);
  S.gCnj = grn(S.mCnj, line(S.mCnj, 'Central loose part'), 'Central loose part', CW);
  const voucher = (no, g) => { const v = run("INSERT INTO grn_vouchers (grn_no, received_date, status) VALUES (?, ?, 'pending_approval')", no, TODAY).lastInsertRowid;
    run('UPDATE grn SET voucher_id = ?, grn_no = ? WHERE id = ?', v, no, g); return v; };
  S.vC = voucher('GRN-C1', S.gC); S.vM = voucher('GRN-M1', S.gM);
  const issue = (jobId, desc, store) => run(`INSERT INTO issues (asset_id, job_id, description, qty, unit_price, issue_date, store_id)
                                              VALUES (NULL, ?, ?, 1, 10, ?, ?)`, jobId, desc, TODAY, store).lastInsertRowid;
  S.iC = issue(S.jC.id, 'Central rag', CW); S.iM = issue(S.jM.id, 'Muthur rag', MTR);
  // Issue notes written outside the route take their card's workshop.
  const note = (no, jobId) => run("INSERT INTO min_notes (min_no, issue_date, job_id, status) VALUES (?, ?, ?, 'requested')", no, TODAY, jobId).lastInsertRowid;
  S.nC = note('MIN-C1', S.jC.id); S.nM = note('MIN-M1', S.jM.id);
  assert.deepStrictEqual([get('SELECT workshop_id w FROM min_notes WHERE id = ?', S.nC).w, get('SELECT workshop_id w FROM min_notes WHERE id = ?', S.nM).w], [CW, MTR]);
  // Transfer notes: Central to a site, Muthur to a site, Central to Muthur.
  const mtn = (no, from, to) => { const t = run(`INSERT INTO mtn (mtn_no, txn_date, description, qty, from_place, to_place, status)
                                                VALUES (?, ?, 'stuff', 1, ?, ?, 'draft')`, no, TODAY, from, to).lastInsertRowid;
    S['l' + no] = run("INSERT INTO mtn_lines (mtn_id, line_no, description, qty) VALUES (?, 1, 'stuff', 1)", t).lastInsertRowid; return t; };
  S.tC = mtn('91001', `w:${CW}`, null); S.tM = mtn('91002', `w:${MTR}`, null); S.tCM = mtn('91003', `w:${CW}`, `w:${MTR}`);
  assert.deepStrictEqual([S.tC, S.tM, S.tCM].map((id) => get('SELECT workshop_id w FROM mtn WHERE id = ?', id).w), [CW, MTR, CW], 'the sending workshop');
  // A general item on both shelves: Central 8, Muthur 3; Muthur reorders at 5, the company at 10 (11: not yet). An oil: Central 100 L, Muthur 30 L.
  S.rag = run("INSERT INTO store_items (name, category, is_general, balance, min_stock) VALUES ('Shop Rag', 'General Items', 1, 11, 10)").lastInsertRowid;
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, store_id) VALUES (?, 'opening', 8, 8, ?, ?)", S.rag, TODAY, CW);
  run("INSERT INTO general_item_txns (store_item_id, txn_type, qty, balance_after, txn_date, store_id) VALUES (?, 'opening', 3, 11, ?, ?)", S.rag, TODAY, MTR);
  run("INSERT INTO store_reorder (store_id, section, item_key, level) VALUES (?, 'general', ?, 5)", MTR, stock.itemKey('general', 'Shop Rag'));
  S.oil = run("INSERT INTO products (code, name, unit, unit_price, active, stock_qty) VALUES ('OIL-9001', 'Engine Oil 15W40', 'L', 10, 1, 130)").lastInsertRowid;
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 100, 100, 10, ?, ?)", S.oil, TODAY, CW);
  run("INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, txn_date, store_id) VALUES (?, 'receipt', 30, 130, 10, ?, ?)", S.oil, TODAY, MTR);
  require('../src/lib/lubricants').seedCatalogueAliases();
  stock.rebuild({ wipe: true });
  // Daily work with mechanics who have no rate yet; a scrap tyre with no store (Central's).
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Chandra', 2)", S.jC.id, TODAY);
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Mohan', 2)", S.jM.id, TODAY);
  S.scrapTyre = run("INSERT INTO tyres (serial_no, state) VALUES ('TY-OLD', 'scrap')").lastInsertRowid;
});

// ================================================================== HTTP
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
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, raw, text: raw.toString('utf8'), cookie: sc ? sc[0].split(';')[0] : null });
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
const call = async (user, method, p, body) => req(method, p, { body, cookie: await as(user) });
const GET = (user, p) => call(user, 'GET', p);
const separate = (on) => scope.setSwitch(actor, on);
const ids = (rows) => rows.map((r) => r.id);

// ================================================================== switched off: as before
test('while the workshops are not kept apart, the Muthur store keeper sees every workshop\'s, as before', async () => {
  separate(false);
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/grn')).body).sort(), [S.gC, S.gM, S.gCnj].sort());
  assert.strictEqual((await GET('kM', `/api/stores/grn/${S.gC}`)).status, 200);
  assert.strictEqual((await GET('kM', `/api/stores/min/${S.nC}`)).status, 200);
  assert.strictEqual((await GET('kM', `/api/stores/mtn/${S.tC}`)).status, 200);
  assert.strictEqual((await GET('kM', `/api/purchasing/lines/${S.lC}`)).status, 200);
  assert.strictEqual((await GET('kM', '/api/stores/items')).body.find((r) => r.id === S.rag).balance, 11, 'the company figure');
  separate(true);
});

// ================================================================== receipts
test('receipts: the lists, counts and exports are your own workshops\'; another\'s receipt cannot be opened or changed', async () => {
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/grn')).body), [S.gM]);
  assert.strictEqual(ids((await GET('boss', '/api/stores/grn')).body).length, 3);
  const c = (await GET('kM', '/api/stores/grn/counts')).body;
  assert.deepStrictEqual([c.all, c.to_price], [1, 1]);
  const ac = (await GET('kM', '/api/stores/grn/awaiting-count')).body;
  assert.deepStrictEqual([ac.awaiting, ac.total, ac.awaiting_grn], [1, 1, 2]);
  assert.deepStrictEqual((await GET('kM', '/api/stores/awaiting-grn')).body.map((r) => r.description).sort(), ['Muthur nut', 'Muthur seal']);
  assert.deepStrictEqual((await GET('kM', '/api/stores/pending')).body.map((r) => r.description).sort(), ['Muthur nut', 'Muthur seal']);
  assert.deepStrictEqual((await GET('kM', '/api/stores/pending/summary')).body.reduce((n, r) => n + r.count, 0), 2);
  assert.ok(!(await GET('kM', '/api/stores/pending/print.html')).text.includes('Central'));
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/awaiting-price')).body), [S.gM]);
  assert.strictEqual((await GET('kM', '/api/stores/awaiting-price/summary')).body.reduce((n, r) => n + r.count, 0), 1);
  assert.ok(!(await GET('kM', '/api/stores/awaiting-price/print.html')).text.includes('Central'));
  assert.deepStrictEqual((await GET('kM', '/api/stores/search')).body.map((r) => r.description).sort(), ['Muthur nut', 'Muthur seal']);

  for (const p of [`/api/stores/grn/${S.gC}`, `/api/stores/grn/${S.gC}/print.html`]) {
    const r = await GET('kM', p);
    assert.strictEqual(r.status, 403, p);
  }
  assert.match((await GET('kM', `/api/stores/grn/${S.gC}`)).body.error, /receipt belongs to Central/);
  assert.strictEqual((await GET('kM', `/api/stores/grn/${S.gM}`)).status, 200);
  assert.strictEqual((await call('kM', 'PATCH', `/api/stores/grn/${S.gC}`, { supplier: 'x' })).status, 403);
  assert.strictEqual((await call('kM', 'POST', `/api/stores/grn/${S.gC}/approve`, {})).status, 403);
  assert.strictEqual((await call('kM', 'POST', `/api/stores/grn/${S.gC}/reject`, { reason: 'x' })).status, 403);
  // Receiving: only against your own workshops' requests.
  assert.strictEqual((await call('kM', 'POST', '/api/stores/grn', { mrn_id: S.mC, mrn_line_id: S.lC2, description: 'Central bolt', qty: 1 })).status, 403);
  assert.strictEqual((await call('kM', 'POST', '/api/stores/grn', { mrn_id: S.mM, mrn_line_id: S.lM2, description: 'Muthur nut', qty: 1 })).status, 201);
  const bulk = (await call('kM', 'POST', '/api/stores/grn/bulk-receive', { rows: [{ mrn_line_id: S.lC2, qty: 1 }] })).body;
  assert.match(JSON.stringify(bulk.skipped), /belongs to Central/);
  assert.strictEqual(get('SELECT qty_received q FROM mrn_lines WHERE id = ?', S.lC2).q, 0);
  await call('kM', 'POST', '/api/stores/grn/bulk-price', { rows: [{ id: S.gC, unit_price: 99 }, { id: S.gM, unit_price: 7 }] });
  assert.deepStrictEqual([get('SELECT unit_price p FROM grn WHERE id = ?', S.gC).p, get('SELECT unit_price p FROM grn WHERE id = ?', S.gM).p], [null, 7]);
});

test('receipt vouchers: your own workshops\' only, and only your own lines and receipts go on a new one', async () => {
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/grn-vouchers')).body), [S.vM]);
  for (const [m, p, b] of [['GET', `/api/stores/grn-vouchers/${S.vC}`], ['GET', `/api/stores/grn-vouchers/${S.vC}/print.html`],
    ['POST', `/api/stores/grn-vouchers/${S.vC}/approve`, {}], ['POST', `/api/stores/grn-vouchers/${S.vC}/reject`, { reason: 'x' }],
    ['POST', `/api/stores/grn-vouchers/${S.vC}/sign`, {}]]) {
    assert.strictEqual((await call('kM', m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await GET('kM', `/api/stores/grn-vouchers/${S.vM}`)).status, 200);
  assert.strictEqual((await call('kM', 'POST', '/api/stores/grn-vouchers', { lines: [{ mrn_line_id: S.lC2, description: 'Central bolt', qty: 1 }] })).status, 403);
  assert.strictEqual((await call('kM', 'POST', '/api/stores/grn-vouchers', { grn_ids: [S.gCnj] })).status, 403);
  assert.strictEqual((await call('kM', 'POST', '/api/stores/grn-vouchers', { grn_ids: [S.gM] })).status, 201);
});

// ================================================================== issues, issue notes, the general card
test('issues and issue notes: your own workshops\'; a site issues to its own general card', async () => {
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/issues')).body), [S.iM]);
  const c = (await GET('kM', '/api/stores/issues/counts')).body;
  assert.strictEqual(c.all, 1);
  const k = (await GET('kM', '/api/stores/issues/kpis')).body;
  assert.deepStrictEqual([k.issues_today, k.cost_today], [1, 10]);
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/min')).body), [S.nM]);
  for (const [m, p, b] of [['GET', `/api/stores/min/${S.nC}`], ['GET', `/api/stores/min/${S.nC}/print.html`],
    ['POST', `/api/stores/min/${S.nC}/approve`, {}], ['POST', `/api/stores/min/${S.nC}/reject`, { reason: 'x' }],
    ['POST', `/api/stores/min/${S.nC}/receive`, {}], ['POST', `/api/stores/min/${S.nC}/sign`, {}],
    ['GET', `/api/stores/issues/${S.iC}/print.html`]]) {
    assert.strictEqual((await call('kM', m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await GET('kM', `/api/stores/min/${S.nM}`)).status, 200);
  // Writing: only on your own workshops' cards; a note with no card is the writer's workshop's.
  assert.strictEqual((await call('kM', 'POST', '/api/stores/issues', { job_id: S.jC.id, description: 'x', qty: 1 })).status, 403);
  assert.strictEqual((await call('kM', 'POST', '/api/stores/min', { job_id: S.jC.id, items: [{ description: 'x', qty: 1 }] })).status, 403);
  const n = await call('kM', 'POST', '/api/stores/min', { items: [{ description: 'Loose rag', qty: 1 }] });
  assert.strictEqual(n.status, 201, n.text);
  assert.strictEqual(get('SELECT workshop_id w FROM min_notes WHERE min_no = ?', n.body.min_no || get('SELECT min_no FROM min_notes ORDER BY id DESC LIMIT 1').min_no).w, MTR);
  assert.ok(ids((await GET('kM', '/api/stores/min')).body).length === 2);
  // The general card is the site's own.
  const g = (await GET('kM', '/api/stores/general-job')).body;
  assert.strictEqual(get('SELECT workshop_id w FROM job_cards WHERE id = ?', g.id).w, MTR);
  assert.strictEqual((await GET('boss', '/api/stores/general-job')).body.job_no, 'GENERAL-WS', 'head office\'s home is the main workshop: its card, as before');
});

// ================================================================== transfers
test('transfer notes: the ones your own workshop wrote or sends to or receives from', async () => {
  assert.deepStrictEqual(ids((await GET('kM', '/api/stores/mtn')).body).sort(), [S.tM, S.tCM].sort());
  assert.strictEqual(ids((await GET('boss', '/api/stores/mtn')).body).length, 3);
  assert.strictEqual((await GET('kM', '/api/stores/mtn/counts')).body.all, 2);
  for (const [m, p, b] of [['GET', `/api/stores/mtn/${S.tC}`], ['GET', `/api/stores/mtn/${S.tC}/print.html`],
    ['POST', `/api/stores/mtn/${S.tC}/approve`, {}], ['POST', `/api/stores/mtn/${S.tC}/reject`, { reason: 'x' }],
    ['PATCH', `/api/stores/mtn/${S.tC}`, { reason: 'x' }], ['POST', `/api/stores/mtn/${S.tC}/lines`, { description: 'x', qty: 1 }],
    ['PATCH', `/api/stores/mtn/line/${S.l91001}`, { qty: 2 }], ['DELETE', `/api/stores/mtn/line/${S.l91001}`]]) {
    const r = await call('kM', m, p, b);
    assert.strictEqual(r.status, 403, `${m} ${p}`);
    assert.match(r.body.error, /transfer note belongs to Central/);
  }
  assert.strictEqual((await GET('kM', `/api/stores/mtn/${S.tCM}`)).status, 200, 'it comes to Muthur');
  // A note between two sites is the workshop that writes it.
  const t = await call('kM', 'POST', '/api/stores/mtn', { description: 'Shovel', qty: 1, from_location: 'Some quarry', to_location: 'Another quarry' });
  assert.strictEqual(t.status, 201, t.text);
  const newId = t.body.id || get('SELECT id FROM mtn ORDER BY id DESC LIMIT 1').id;
  assert.strictEqual(get('SELECT workshop_id w FROM mtn WHERE id = ?', newId).w, MTR);
  assert.ok(ids((await GET('kM', '/api/stores/mtn')).body).includes(newId));
});

// ================================================================== items, oil, pipeline, exports
test('item lists show your own store\'s balance; the pipeline, trace and request export are your own workshops\'', async () => {
  const item = (rows) => rows.find((r) => r.id === S.rag);
  assert.deepStrictEqual([item((await GET('kM', '/api/stores/items')).body).balance, item((await GET('kM', '/api/stores/items')).body).min_stock], [3, 5]);
  assert.strictEqual(item((await GET('boss', '/api/stores/items')).body).balance, 11);
  assert.deepStrictEqual((await GET('kM', '/api/stores/reorder')).body.map((r) => r.id), [S.rag], 'Muthur: 3 at a level of 5');
  assert.deepStrictEqual((await GET('boss', '/api/stores/reorder')).body.map((r) => r.id), [], 'the company: 11 at a level of 10');
  assert.deepStrictEqual((await GET('kM', `/api/stores/items/${S.rag}/ledger`)).body.map((r) => r.qty), [3]);
  assert.strictEqual(item((await GET('kM', '/api/stores/items/search?q=Shop')).body).balance, 3);
  run("UPDATE store_items SET item_no = 'GEN-0001' WHERE id = ?", S.rag);
  assert.strictEqual(item((await GET('kM', '/api/stores/catalogue')).body).balance, 3);
  const oil = (await GET('kM', '/api/oil/products')).body.find((p) => p.id === S.oil);
  assert.deepStrictEqual([oil.stock_qty, oil.current_balance], [30, 30]);

  const ps = (await GET('kM', '/api/stores/pipeline/summary')).body;
  const pb = (await GET('boss', '/api/stores/pipeline/summary')).body;
  assert.ok(ps.awaiting_delivery < pb.awaiting_delivery && ps.issued_today < pb.issued_today);
  for (const q of [`grn_id=${S.gC}`, `issue_id=${S.iC}`, `mrn_id=${S.mC}`, `job_id=${S.jC.id}`]) {
    assert.strictEqual((await GET('kM', `/api/stores/pipeline/trace?${q}`)).status, 403, q);
  }
  assert.strictEqual((await GET('kM', `/api/stores/pipeline/trace?grn_id=${S.gM}`)).status, 200);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await GET('kM', '/api/stores/export/mrn.xlsx')).raw);
  const nos = []; wb.worksheets[0].eachRow((r, i) => { if (i > 1) nos.push(String(r.getCell(1).value)); });
  assert.deepStrictEqual(nos, ['900002']);
  // A request on another workshop's card is refused.
  assert.strictEqual((await call('kM', 'POST', '/api/stores/mrn', { job_id: S.jC.id, lines: [{ description: 'x', qty: 1 }] })).status, 403);
});

// ================================================================== purchasing, the job card pickers, disposal
test('purchase lines, unassigned receipts, mechanic names and scrap are your own workshops\' or store\'s', async () => {
  for (const [m, p, b] of [['GET', `/api/purchasing/lines/${S.lC}`], ['POST', `/api/purchasing/lines/${S.lC}/priority`, { buying_priority: 'P1_CRITICAL' }],
    ['GET', `/api/purchasing/lines/${S.lC}/priority-history`]]) {
    assert.strictEqual((await call('kM', m, p, b)).status, 403, `${m} ${p}`);
  }
  assert.strictEqual((await GET('kM', `/api/purchasing/lines/${S.lM}`)).status, 200);
  assert.strictEqual((await GET('boss', `/api/purchasing/lines/${S.lC}`)).status, 200);
  // Goods received against a request with no card: Central's loose receipt is not Muthur's to put on a card.
  const loose = async (user) => ids((await GET(user, '/api/jobs/unassigned/parts')).body.receipts);
  assert.deepStrictEqual(await loose('kM'), []);
  assert.deepStrictEqual(await loose('boss'), [S.gCnj]);
  assert.deepStrictEqual((await GET('kM', '/api/mechanics/unassigned')).body.map((m) => m.name), ['Mohan']);
  const scrap = (await GET('kM', '/api/stores/disposals/scrap')).body;
  assert.ok(!scrap.tyres.some((t) => t.id === S.scrapTyre), 'a tyre with no store is the main store\'s');
  assert.ok((await GET('boss', `/api/stores/disposals/scrap?store_id=${CW}`)).body.tyres.some((t) => t.id === S.scrapTyre));
});

// ================================================================== the rest: exports, downloads, transfer steps, returns
test('exports, downloads, transfer steps, returns and vehicle costs keep to your own workshops', async () => {
  const ExcelJS = require('exceljs');
  const sheetText = async (p) => {
    const r = await GET('kM', p);
    assert.strictEqual(r.status, 200, p);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.raw);
    const out = []; wb.worksheets.forEach((ws) => ws.eachRow((row) => out.push(JSON.stringify(row.values)))); return out.join('\n');
  };
  for (const p of ['/api/stores/pending/export.xlsx', '/api/stores/search/export.xlsx']) {
    const t = await sheetText(p);
    assert.ok(t.includes('Muthur') && !t.includes('Central'), p);
  }
  run('UPDATE grn SET unit_price = NULL WHERE id = ?', S.gM);
  { const t = await sheetText('/api/stores/awaiting-price/export.xlsx'); assert.ok(t.includes('Muthur seal') && !t.includes('Central'), t); }

  // Downloads are refused before anything is drawn.
  for (const p of [`/api/stores/grn/${S.gC}/download.pdf`, `/api/stores/grn-vouchers/${S.vC}/download.pdf`,
    `/api/stores/min/${S.nC}/download.pdf`, `/api/stores/issues/${S.iC}/download.pdf`, `/api/stores/mtn/${S.tC}/download.pdf`]) {
    assert.strictEqual((await GET('kM', p)).status, 403, p);
  }
  for (const step of ['dispatch', 'receive', 'accept', 'sign']) {
    assert.strictEqual((await call('kM', 'POST', `/api/stores/mtn/${S.tC}/${step}`, {})).status, 403, step);
  }

  // A return to another workshop's store, even of an issue with no card.
  const loose = run(`INSERT INTO issues (job_id, description, qty, unit_price, issue_date, store_id) VALUES (NULL, 'Central loose rag', 2, 10, ?, ?)`, TODAY, CW).lastInsertRowid;
  for (const id of [S.iC, loose]) {
    assert.strictEqual((await call('kM', 'POST', `/api/stores/issues/${id}/return`, { qty: 1 })).status, 403, String(id));
  }
  assert.strictEqual(get('SELECT COUNT(*) c FROM issue_returns').c, 0);
  // A general item onto another workshop's card.
  assert.strictEqual((await call('kM', 'POST', `/api/stores/items/${S.rag}/txn`, { txn_type: 'issue', qty: 1, job_id: S.jC.id })).status, 403);

  // Vehicle costs: the categories of your own workshops' issues; the company rollup is head office's.
  const shared = asset('V-SHARED');
  run("UPDATE issues SET asset_id = ?, category = 'Rags' WHERE id IN (?, ?)", shared, S.iC, S.iM);
  run('INSERT INTO vehicle_monthly_costs (asset_id, year, month, parts_cost, total_cost) VALUES (?, 2026, 10, 20, 20)', shared);
  const vk = (await GET('kM', `/api/stores/vehicle-costs?asset_id=${shared}`)).body;
  const vb = (await GET('boss', `/api/stores/vehicle-costs?asset_id=${shared}`)).body;
  assert.deepStrictEqual([vk.monthly.length, vk.categories[0].total], [0, 10]);
  assert.deepStrictEqual([vb.monthly.length, vb.categories[0].total], [1, 20]);
});

// ================================================================== records known only by their store or their ends
test('a receipt with no request is its store\'s, an issue with no card its store\'s, a transfer its ends\' and items\'', async () => {
  // Receipts and issues with no request or card; ids no issue note has, so a print finds the issue itself.
  const gNoMrn = (id, store) => run(`INSERT INTO grn (id, grn_no, description, qty, delivery_date, store_id) VALUES (?, ?, 'loose', 1, ?, ?)`, id, 'G-' + id, TODAY, store).lastInsertRowid;
  const iNoJob = (id, store) => run(`INSERT INTO issues (id, description, qty, unit_price, issue_date, store_id) VALUES (?, 'loose', 1, 1, ?, ?)`, id, TODAY, store).lastInsertRowid;
  gNoMrn(6001, CW); gNoMrn(6002, MTR); iNoJob(5001, CW); iNoJob(5002, MTR);
  const grns = ids((await GET('kM', '/api/stores/grn')).body);
  assert.ok(grns.includes(6002) && !grns.includes(6001), JSON.stringify(grns));
  assert.strictEqual((await GET('kM', '/api/stores/grn/6001')).status, 403);
  const iss = ids((await GET('kM', '/api/stores/issues')).body);
  assert.ok(iss.includes(5002) && !iss.includes(5001), JSON.stringify(iss));
  assert.strictEqual((await GET('kM', '/api/stores/issues/5001/print.html')).status, 403);
  assert.strictEqual((await GET('kM', '/api/stores/issues/5002/print.html')).status, 200);

  // Transfers Central wrote: one from Muthur, one with only an item going to Muthur. Both concern Muthur.
  const tFrom = run(`INSERT INTO mtn (mtn_no, txn_date, description, qty, from_place, status, workshop_id) VALUES ('91101', ?, 'x', 1, ?, 'draft', ?)`, TODAY, `w:${MTR}`, CW).lastInsertRowid;
  const tLine = run(`INSERT INTO mtn (mtn_no, txn_date, description, qty, status, workshop_id) VALUES ('91102', ?, 'x', 1, 'draft', ?)`, TODAY, CW).lastInsertRowid;
  run("INSERT INTO mtn_lines (mtn_id, line_no, description, qty, to_place) VALUES (?, 1, 'x', 1, ?)", tLine, `w:${MTR}`);
  // A note written outside the routes, from outside into Muthur, is Muthur's.
  const tIn = run(`INSERT INTO mtn (mtn_no, txn_date, description, qty, from_place, to_place, status) VALUES ('91103', ?, 'x', 1, 'quarry', ?, 'draft')`, TODAY, `w:${MTR}`).lastInsertRowid;
  assert.strictEqual(get('SELECT workshop_id w FROM mtn WHERE id = ?', tIn).w, MTR);
  const mine = ids((await GET('kM', '/api/stores/mtn')).body);
  assert.ok(mine.includes(tFrom) && mine.includes(tLine) && !mine.includes(S.tC), JSON.stringify(mine));
  assert.strictEqual((await GET('kM', `/api/stores/mtn/${tLine}`)).status, 200);

  // The pipeline: a request waiting for Central's approval is not Muthur's to count.
  run(`INSERT INTO mrn (mrn_no, workshop_id, req_date, approval_status, requested_by) VALUES ('900009', ?, ?, 'requested', 'someone')`, CW, TODAY);
  const ps = (await GET('kM', '/api/stores/pipeline/summary')).body;
  const pb = (await GET('boss', '/api/stores/pipeline/summary')).body;
  for (const k of ['requests_pending', 'awaiting_delivery', 'ready_in_store', 'issued_today']) assert.ok(ps[k] < pb[k], `${k}: ${ps[k]} / ${pb[k]}`);
});
