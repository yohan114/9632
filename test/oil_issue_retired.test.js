'use strict';

// One door for handing a lubricant out.
//
// The Oil section had its own Issue / Top-up screen alongside Stores → Issue, so the same drum
// could be written down in two books, and the two disagreed about where its cost belonged. The
// owner's call (2026-08-21): retire the oil door, keep Stores.
//
// That is only safe if oil cost follows the ITEM rather than the book it was recorded in. The
// costing engine used to define oil as "whatever is in the oil ledger" and material as "every
// job_part" — so the moment the storekeeper moved to the Stores screen, every drum would have
// quietly become Material and the Oil column would have emptied out. These tests pin the new
// rule and, just as importantly, pin what must NOT change: the job total.
//
// The report keeps a NARROWER idea of oil than the costing engine does (engine/gear/hydraulic/
// grease only — not brake fluid, coolant, kerosene or WD-40). That gap is deliberate and is
// tested here, because widening it would restate months the owner has already signed off.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-oil-retired-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const lubricants = require('../src/lib/lubricants');
const costing = require('../src/lib/costing');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

for (const n of ['admin', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk',
  require('../src/lib/auth').hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const app = require('../src/server');
let server; let base; let cookie;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'sk', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
test.after(() => server && server.close());

const post = (url, body) => fetch(base + url, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});

// The oil book. HYD and ENGINE are what the monthly report has always called Oil; COOLANT is a
// lubricant the report has never counted, which is the boundary case below.
const mkProduct = (name, cat, unit) => run(
  'INSERT INTO products (name, category, unit, unit_price, active) VALUES (?, ?, ?, ?, 1)',
  name, cat, unit, 100).lastInsertRowid;
const HYD = mkProduct('RT-68 Hy/Oil (Testex)', 'hydraulic', 'L');
const ENGINE = mkProduct('RT-40 Engine Oil (Testex)', 'engine_oil', 'L');
const COOLANT = mkProduct('RT Coolant Green', 'coolant', 'nos');
// Every real lubricant sits in BOTH books: `products` is the oil book, `stock_items` is what the
// Stores picker searches. Mirroring that here is the point of the end-to-end test at the bottom.
const stock = require('../src/lib/stock');
[HYD, ENGINE, COOLANT].forEach((id, i) => {
  const code = 'OIL-' + (7101 + i);
  const p = get('SELECT name, unit, unit_price FROM products WHERE id = ?', id);
  run('UPDATE products SET code = ? WHERE id = ?', code, id);
  run(`INSERT INTO stock_items (code, section, name, item_key, unit, unit_price, source_table, source_id, active)
       VALUES (?, 'oil', ?, ?, ?, ?, 'products', ?, 1)`,
  code, p.name, stock.itemKey('oil', p.name), p.unit, p.unit_price, id);
});
lubricants.seedCatalogueAliases();

const assetId = run(
  "INSERT INTO assets (code, code_norm, registration, in_register) VALUES ('RT-01', 'RT01', 'RT-0001', 1)").lastInsertRowid;
const mkJob = (no) => run(
  `INSERT INTO job_cards (job_no, asset_id, description, status, requested_at)
   VALUES (?, ?, 'test job', 'IN_PROGRESS', '2026-08-05')`, no, assetId).lastInsertRowid;
const addPart = (jobId, description, qty, price) => run(
  `INSERT INTO job_parts (job_id, source_type, description, qty, unit_price, is_external_repair, created_at)
   VALUES (?, 'grn', ?, ?, ?, 0, '2026-08-05')`, jobId, description, qty, price).lastInsertRowid;

// ---- the door is shut ------------------------------------------------------

test('the oil section will not hand a lubricant out any more', async () => {
  const r = await post('/api/oil/ledger', { product_id: HYD, kind: 'issue', qty: 5 });
  assert.strictEqual(r.status, 400);
  const b = await r.json();
  assert.match(b.error, /Stores/i, 'the refusal must say where to go instead');
});

test('nothing is written when the issue is refused', async () => {
  const before = get("SELECT COUNT(*) c FROM stock_ledger WHERE product_id = ? AND kind = 'issue'", HYD).c;
  await post('/api/oil/ledger', { product_id: HYD, kind: 'issue', qty: 5 });
  assert.strictEqual(get("SELECT COUNT(*) c FROM stock_ledger WHERE product_id = ? AND kind = 'issue'", HYD).c, before);
});

test('a service lubricant is still refused for its own separate reason', async () => {
  const r = await post('/api/oil/ledger', { product_id: HYD, kind: 'issue', qty: 5, consumer_type: 'service' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /Service/i);
});

// Receiving, opening and correcting a count are NOT handovers — they never had a Stores
// equivalent, and closing them would leave the oil book with no way to be corrected at all.
test('receipts still post', async () => {
  const r = await post('/api/oil/ledger', { product_id: HYD, kind: 'receipt', qty: 20, txn_date: '2026-08-02' });
  assert.ok(r.status >= 200 && r.status < 300, await r.text());
});

test('an opening balance still posts', async () => {
  const r = await post('/api/oil/ledger', { product_id: ENGINE, kind: 'opening', qty: 12, txn_date: '2026-08-01' });
  assert.ok(r.status >= 200 && r.status < 300, await r.text());
});

test('a count correction still posts', async () => {
  const r = await post('/api/oil/ledger', { product_id: ENGINE, kind: 'adjustment', qty: 10, txn_date: '2026-08-03' });
  assert.ok(r.status >= 200 && r.status < 300, await r.text());
});

// ---- cost follows the item, not the book ----------------------------------

test('a lubricant handed over through Stores is oil cost, not material', () => {
  const jobId = mkJob('RT/OIL/1');
  addPart(jobId, 'RT-68 Hy/Oil (Testex)', 4, 250);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.oil_cost, 1000);
  assert.strictEqual(c.material_cost, 0);
});

test('an ordinary part is still material', () => {
  const jobId = mkJob('RT/OIL/2');
  addPart(jobId, 'Wheel Stud 20mm', 4, 250);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.material_cost, 1000);
  assert.strictEqual(c.oil_cost, 0);
});

test('reclassifying moves money between columns without changing the job total', () => {
  const jobId = mkJob('RT/OIL/3');
  addPart(jobId, 'RT-40 Engine Oil (Testex)', 2, 500);
  addPart(jobId, 'Wheel Stud 20mm', 4, 250);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.oil_cost, 1000);
  assert.strictEqual(c.material_cost, 1000);
  assert.strictEqual(c.total_cost, 2000, 'the total is what the owner signed off — it must not move');
});

test('a lubricant on the oil ledger and one through Stores land in the same column', () => {
  const jobId = mkJob('RT/OIL/4');
  addPart(jobId, 'RT-68 Hy/Oil (Testex)', 1, 300);
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, unit_price, job_id, txn_date)
       VALUES (?, 'issue', -2, 0, 150, ?, '2026-08-06')`, HYD, jobId);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.oil_cost, 600, 'one door or the other, it is all oil');
  assert.strictEqual(c.material_cost, 0);
});

test('a part awaiting a price is still counted nowhere and still blocks closure', () => {
  const jobId = mkJob('RT/OIL/5');
  addPart(jobId, 'RT-68 Hy/Oil (Testex)', 4, null);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.oil_cost, 0);
  assert.strictEqual(c.material_cost, 0);
  const gate = costing.closureReadiness(jobId);
  assert.strictEqual(gate.ready, false);
  assert.ok(gate.missing.some((m) => /awaiting price/i.test(m)), 'an unpriced drum must still stop the job closing');
});

test('a name nobody has identified yet is left as material, not guessed into oil', () => {
  const jobId = mkJob('RT/OIL/6');
  addPart(jobId, 'Some Unknown Fluid 5L', 2, 400);
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.material_cost, 800, 'an unrecognised name stays where it was');
  assert.strictEqual(c.oil_cost, 0);
});

// ---- the report keeps its own, narrower idea of oil ------------------------

test('the costing engine counts coolant as oil because the oil book knows it', () => {
  const jobId = mkJob('RT/OIL/7');
  addPart(jobId, 'RT Coolant Green', 2, 350);
  assert.strictEqual(costing.computeJobCost(jobId).oil_cost, 700);
});

test('coolant is a lubricant, and the alias resolves to the catalogue product', () => {
  const r = lubricants.resolveLubricant('RT Coolant Green', { record: false });
  assert.strictEqual(r.productId, COOLANT);
  assert.ok(lubricants.isLubricant('RT Coolant Green'));
});

// ---- the door that is left has to actually work ---------------------------
//
// Retiring a screen is only safe if the remaining one can do the job. Stores issues a CATALOGUE
// item (stock_items), while the oil book is `products` — two tables. All 30 live lubricants have
// a row in both, and this walks the storekeeper's actual path to prove it end to end.

// The Issue screen searches stock-items (section-aware), NOT the MRN picker's items/search —
// they are different catalogues, and only the former carries the id stock-issue needs.
test('the Issue picker finds a lubricant by name, with an id Stores can use', async () => {
  const r = await fetch(`${base}/api/stores/stock-items/search?q=RT-68&limit=25`, { headers: { cookie } });
  assert.strictEqual(r.status, 200);
  const rows = await r.json();
  const hit = rows.find((x) => /RT-68/.test(x.name || ''));
  assert.ok(hit, 'a lubricant the storekeeper types must come back from the picker');
  assert.ok(hit.id, 'and it must arrive with a catalogue id, or Stores cannot issue it');
  assert.strictEqual(hit.section, 'oil');
});

test('narrowing the Issue picker to Oil & Lube still finds it', async () => {
  const r = await fetch(`${base}/api/stores/stock-items/search?q=RT-68&section=oil&limit=25`, { headers: { cookie } });
  const rows = await r.json();
  assert.ok(rows.some((x) => /RT-68/.test(x.name || '')), 'the oil section must list its own lubricants');
});

test('Stores can hand out a drum, and it lands as oil cost on the job', async () => {
  const jobId = mkJob('RT/OIL/8');
  const item = get("SELECT id FROM stock_items WHERE code = 'OIL-7101'");
  const r = await post('/api/stores/stock-issue', {
    job_id: jobId, issue_date: '2026-08-07',
    lines: [{ stock_item_id: item.id, qty: 3, unit_price: 200 }],
  });
  assert.strictEqual(r.status, 201, await r.text());
  const c = costing.computeJobCost(jobId);
  assert.strictEqual(c.oil_cost, 600, 'issued through Stores, still counted as oil');
  assert.strictEqual(c.material_cost, 0);
  assert.strictEqual(c.total_cost, 600);
});

test('the drum comes off the oil balance, not the general one', () => {
  const mv = get(`SELECT section, kind, qty FROM stock_moves WHERE source_table = 'issues'
                   AND item_name LIKE 'RT-68%' ORDER BY id DESC LIMIT 1`);
  assert.ok(mv, 'issuing must write a stock movement');
  assert.strictEqual(mv.section, 'oil');
  assert.strictEqual(mv.kind, 'out');
});

test("the monthly report's Oil column is engine/gear/hydraulic/grease only", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'monthly_cost_report.js'), 'utf8');
  const m = src.match(/const REPORT_OIL_CATEGORIES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'the report must state its categories in one place');
  const cats = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepStrictEqual(cats, ['engine_oil', 'gear_oil', 'grease', 'hydraulic']);
  assert.ok(!cats.includes('coolant'), 'widening this would restate signed-off months');
});
