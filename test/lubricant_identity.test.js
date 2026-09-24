'use strict';

// Which lubricant is this, and is it a lubricant at all?
//
// Phase 1 gives every oil in the book the code the unified catalogue already minted for it
// (OIL-0001 …) and remembers every other spelling seen on a request, receipt, issue or
// transfer. Phase 2 then stops treating "contains the word oil" as "is oil".
//
// The two failures this prevents, both found in the live book:
//   * "Front Crank Oil Seal", "Hub Oil Seal", "Grease Nozzle", "Oil Spray Gun" and "Brake Oil
//     Tank" were being deducted from the oil balance, because when a line has no category the
//     section was decided by the words in its description.
//   * The obvious fix — matching on a loose name — would have merged real products: with
//     brackets stripped, "HD 68 Oil (Servo)" resolved to "HD 68 Oil (Valvoline)". The workshop
//     buys both. So brackets are kept, and an ambiguous name resolves to NOTHING and is put to
//     the owner instead of guessed.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-lubricant-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const lubricants = require('../src/lib/lubricants');
const stock = require('../src/lib/stock');

migrate();

// store_items.unit_cost comes from a numbered migration rather than the base schema, and the
// stores item picker selects it — same as test/issue_job.test.js does.
require('../src/migrate/015_phase4_erp_gaps').runStep();

// A signed-in storekeeper, so the stores item picker can be exercised over HTTP.
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

// The oil book, as the workshop keeps it: two brands of the same grade, and a kerosene whose
// name is spelt a third way everywhere else.
const mkProduct = (name, cat, unit) => run(
  'INSERT INTO products (name, category, unit, active) VALUES (?, ?, ?, 1)', name, cat, unit).lastInsertRowid;
const VALVOLINE = mkProduct('HD 68 Oil (Valvoline)', 'hydraulic', 'L');
const CALTEX = mkProduct('HD-68 Hy/Oil Caltex', 'hydraulic', 'L');
const KARO = mkProduct('Karosine Oil', 'fuel', 'L');
const GREASE = mkProduct('Grease', 'grease', 'kg');
// Give them codes the way migrate does for the real ones.
[VALVOLINE, CALTEX, KARO, GREASE].forEach((id, i) => run(
  `UPDATE products SET code = ? WHERE id = ?`, 'OIL-' + String(9001 + i), id));
lubricants.seedCatalogueAliases();

// ---- identity --------------------------------------------------------------

test('a product answers to its own name', () => {
  const r = lubricants.resolveLubricant('HD 68 Oil (Valvoline)', { record: false });
  assert.strictEqual(r.productId, VALVOLINE);
  assert.ok(r.resolved);
});

test('punctuation and spacing do not make a different oil', () => {
  assert.strictEqual(lubricants.normLube('HD-68 Hy/Oil Caltex'), lubricants.normLube('HD 68 HyOil  caltex'));
  assert.strictEqual(lubricants.resolveLubricant('HD-68 HY/OIL CALTEX', { record: false }).productId, CALTEX);
});

test('two brands of the same grade stay two oils', () => {
  // With brackets stripped these both became "HD68OIL" and Servo resolved to Valvoline.
  assert.notStrictEqual(lubricants.normLube('HD 68 Oil (Valvoline)'), lubricants.normLube('HD 68 Oil (Servo)'));
  assert.strictEqual(lubricants.resolveLubricant('HD 68 Oil (Servo)', { record: false }).resolved, false,
    'an oil the book does not have is unknown, not the nearest match');
});

test('a name that could be either brand resolves to neither', () => {
  const r = lubricants.resolveLubricant('HD-68 Oil', { record: false });
  assert.strictEqual(r.resolved, false, 'nobody knows whose HD-68 that receipt was — that is a question for the owner');
});

test('who took it is not part of what it is', () => {
  assert.strictEqual(lubricants.resolveLubricant('Grease (to Ruwan)', { record: false }).productId, GREASE);
  assert.strictEqual(lubricants.resolveLubricant('Grease (to Work Shop Stores)', { record: false }).productId, GREASE);
  assert.strictEqual(lubricants.displayName('Kerosene Oil (to W/S)'), 'Kerosene Oil', 'and it is not shown in the queue');
});

test('an unknown name is remembered once, and counted', () => {
  lubricants.resolveLubricant('Rubber Grease', { source: 'issues' });
  lubricants.resolveLubricant('Rubber  grease', { source: 'issues' });
  const rows = all(`SELECT * FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('Rubber Grease'));
  assert.strictEqual(rows.length, 1, 'one row per identity, however it was spelt');
  assert.strictEqual(rows[0].hit_count, 2);
  assert.strictEqual(rows[0].resolved, 0);
  assert.strictEqual(rows[0].product_id, null, 'remembered, never guessed at');
});

test('looking without recording leaves no trace', () => {
  const before = get('SELECT COUNT(*) c FROM lubricant_aliases').c;
  lubricants.resolveLubricant('Something Never Seen', { record: false });
  assert.strictEqual(get('SELECT COUNT(*) c FROM lubricant_aliases').c, before);
});

test('seeding the catalogue twice changes nothing', () => {
  const before = get('SELECT COUNT(*) c FROM lubricant_aliases').c;
  lubricants.seedCatalogueAliases();
  lubricants.seedCatalogueAliases();
  assert.strictEqual(get('SELECT COUNT(*) c FROM lubricant_aliases').c, before);
});

test('a lubricant can be found by its code', () => {
  assert.strictEqual(lubricants.lubricantByCode('OIL-9001').id, VALVOLINE);
  assert.strictEqual(lubricants.lubricantByCode('oil-9001').id, VALVOLINE, 'case does not matter');
  assert.strictEqual(lubricants.lubricantByCode('OIL-0000'), undefined);
});

// ---- one name, two products, different eras --------------------------------
// The workshop bought HD-68 in Caltex, then in Valvoline, and wrote both as "HD-68 Oil".
// The two overlapped for nine months, so one mapping is wrong at one end of the book.

test('a name split at a date means the older product before it', () => {
  lubricants.splitAliasAt(lubricants.normLube('HD-68 Oil'), '2026-06-01', CALTEX, VALVOLINE, 'test');
  assert.strictEqual(lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2025-12-16' }).productId, CALTEX);
  assert.strictEqual(lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2026-01-11' }).productId, CALTEX);
});

test('…and the newer product from the changeover on', () => {
  assert.strictEqual(lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2026-06-01' }).productId, VALVOLINE,
    'the changeover date itself belongs to the new brand');
  assert.strictEqual(lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2026-08-03' }).productId, VALVOLINE);
});

test('asked with no date, a split name means what it means today', () => {
  assert.strictEqual(lubricants.resolveLubricant('HD-68 Oil', { record: false }).productId, VALVOLINE,
    'someone typing it now means the oil now in the tank');
});

test('splitting twice does not pile up rows', () => {
  const n = () => get('SELECT COUNT(*) c FROM lubricant_aliases WHERE raw_norm = ?', lubricants.normLube('HD-68 Oil')).c;
  const before = n();
  lubricants.splitAliasAt(lubricants.normLube('HD-68 Oil'), '2026-06-01', CALTEX, VALVOLINE, 'test');
  assert.strictEqual(n(), before, 'two rows: before the changeover, and from it');
  assert.strictEqual(before, 2);
});

test('a movement is judged by what the name meant on its own date', () => {
  // Both are the same words; only the date differs, and that decides the product.
  assert.ok(lubricants.isLubricant('HD-68 Oil', '2025-12-16'));
  assert.ok(lubricants.isLubricant('HD-68 Oil', '2026-07-15'));
  assert.notStrictEqual(
    lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2025-12-16' }).productId,
    lubricants.resolveLubricant('HD-68 Oil', { record: false, on: '2026-07-15' }).productId);
});

// ---- what counts as oil stock ----------------------------------------------

// A store issue of each: one real oil, one seal, one tool — every one of them filed by the
// workshop under "Lubricants & Fluids", which is exactly how a grease gun ended up as litres.
// They carry a store_item, because that is where the rebuild reads an issue's category from.
const mrn = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('L-1', '2026-08-01', 'open')`).lastInsertRowid;
const issueOf = (desc, qty) => {
  const item = run(`INSERT INTO store_items (name, category) VALUES (?, 'Lubricants & Fluids')`, desc).lastInsertRowid;
  const line = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, ?, 'Lubricants & Fluids')`,
    mrn, desc, qty).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES (?, ?, ?, ?, 100, '2026-08-01')`, mrn, line, desc, qty);
  run(`INSERT INTO issues (description, qty, store_item_id, issue_date) VALUES (?, ?, ?, '2026-08-02')`, desc, qty, item);
};
issueOf('Grease', 50);
issueOf('Hub Oil Seal', 4);
issueOf('Grease Gun (500g)', 1);

test('a seal and a grease gun are not litres of oil', () => {
  stock.rebuild({ wipe: true });
  // All three are filed as lubricants, so all three land in the oil section…
  const inOil = (name) => get(
    `SELECT COUNT(*) c FROM stock_moves WHERE section = 'oil' AND item_name LIKE ?`, name + '%').c;
  assert.ok(inOil('Grease') > 0 && inOil('Hub Oil Seal') > 0 && inOil('Grease Gun') > 0);
  // …but only the one the oil book recognises is stock in litres.
  const counted = (name) => get(
    `SELECT COALESCE(SUM(counts),0) c FROM stock_moves WHERE section = 'oil' AND kind = 'out' AND item_name LIKE ?`, name + '%').c;
  assert.ok(counted('Grease') > 0, 'the grease is deducted from oil stock');
  assert.strictEqual(counted('Hub Oil Seal'), 0, 'the seal is not');
  assert.strictEqual(counted('Grease Gun'), 0, 'nor the gun');
});

test('the rows are still there — they stop counting, they are not hidden', () => {
  assert.ok(get(`SELECT COUNT(*) c FROM stock_moves WHERE item_name LIKE 'Hub Oil Seal%'`).c > 0);
  assert.strictEqual(get(`SELECT category FROM mrn_lines WHERE description = 'Hub Oil Seal'`).category,
    'Lubricants & Fluids', 'and nothing was recategorised');
});

test('the unknown names went to the queue with their counts', () => {
  const q = lubricants.unresolvedAliases(50).map((r) => r.raw_text);
  assert.ok(q.includes('Hub Oil Seal'));
  assert.ok(q.includes('Grease Gun (500g)'));
  assert.ok(!q.includes('Grease'), 'a name the book knows is not a question');
});

test('identifying a name brings its stock back, on the next rebuild', () => {
  const alias = get(`SELECT id FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('HD-68 Oil'))
    || (lubricants.resolveLubricant('HD-68 Oil', { source: 'test' }), get(`SELECT id FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('HD-68 Oil')));
  lubricants.setAlias(alias.id, VALVOLINE, 'tester');
  const r = lubricants.resolveLubricant('HD-68 Oil', { record: false });
  assert.strictEqual(r.productId, VALVOLINE);
  assert.ok(r.resolved, 'once the owner says which oil it was, it is that oil everywhere');
});

test('marking a name as not-a-lubricant keeps it out for good', () => {
  const a = get(`SELECT id FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('Grease Gun (500g)'));
  lubricants.setAlias(a.id, null, 'tester');
  assert.strictEqual(lubricants.isLubricant('Grease Gun (500g)'), false);
  stock.rebuild({ wipe: true });
  assert.strictEqual(get(
    `SELECT COALESCE(SUM(counts),0) c FROM stock_moves WHERE section = 'oil' AND item_name LIKE 'Grease Gun%'`).c, 0);
});

test('"not a lubricant" is a different answer from "nobody has looked yet"', () => {
  // Both have no product. If they were stored the same way, the nineteen bits of hardware
  // filed under Lubricants & Fluids would return to the list to identify on every rebuild.
  const gun = get(`SELECT * FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('Grease Gun (500g)'));
  assert.strictEqual(gun.product_id, null);
  assert.strictEqual(gun.resolved, 1, 'a decision WAS made — the answer was no');

  const queued = lubricants.unresolvedAliases(100).map((r) => r.raw_text);
  assert.ok(!queued.includes('Grease Gun (500g)'), 'settled, so off the list');
  assert.ok(lubricants.notLubricantAliases(100).map((r) => r.raw_text).includes('Grease Gun (500g)'),
    'but still visible, so a wrong call can be undone');
});

test('a name ruled out by mistake can be put back', () => {
  const gun = get(`SELECT id FROM lubricant_aliases WHERE raw_norm = ?`, lubricants.normLube('Grease Gun (500g)'));
  lubricants.setAlias(gun.id, null, 'tester', { reset: true });
  assert.ok(lubricants.unresolvedAliases(100).map((r) => r.raw_text).includes('Grease Gun (500g)'),
    'back on the list to identify');
  assert.strictEqual(lubricants.isLubricant('Grease Gun (500g)'), false, 'and still not counted meanwhile');
  lubricants.setAlias(gun.id, null, 'tester');   // settle it again for the tests that follow
});

test('a rebuild does not undo a settled decision', () => {
  stock.rebuild({ wipe: true });
  const queued = lubricants.unresolvedAliases(100).map((r) => r.raw_text);
  assert.ok(!queued.includes('Grease Gun (500g)'), 'seeing the name again must not reopen the question');
});

test('rebuilding twice gives the same balance', () => {
  const bal = () => get(
    `SELECT ROUND(SUM(CASE WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),1) v
       FROM stock_moves WHERE section = 'oil' AND counts = 1`).v;
  stock.rebuild({ wipe: true });
  const a = bal();
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal(), a, 'resolving names must not make the balance drift on every rebuild');
});

// ---- Phase 3: one record per delivery --------------------------------------
//
// A drum bought through stores was written down twice — as a GRN (with supplier, invoice and
// price) and again as a top-up in the oil ledger. Every stores receipt of oil used to be muted
// wholesale to stop that double count, which also hid the 17 genuine stores deliveries the oil
// ledger never knew about. The seven real duplicates are now settled on the LEDGER side by
// voiding them, so a receipt is simply a receipt.

// Its own product and date, so nothing above can be mistaken for it.
const P3 = mkProduct('Phase3 Test Oil', 'hydraulic', 'L');
run(`UPDATE products SET code = 'OIL-9900' WHERE id = ?`, P3);
lubricants.seedCatalogueAliases();
const P3DAY = '2026-09-09';

test('a stores receipt of oil counts toward the balance', () => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('P3-1', ?, 'open')`, P3DAY).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category)
                 VALUES (?, 'Phase3 Test Oil', 20, 'Lubricants & Fluids')`, m).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES (?, ?, 'Phase3 Test Oil', 20, 100, ?)`, m, l, P3DAY);
  stock.rebuild({ wipe: true });
  assert.strictEqual(get(
    `SELECT COALESCE(SUM(counts),0) c FROM stock_moves
      WHERE section='oil' AND source_table='grn' AND item_name='Phase3 Test Oil'`).c, 1,
  'the blanket mute on oil receipts is gone — that is what hid the genuine deliveries');
});

test('a voided ledger row is left out, so a twice-written delivery counts once', () => {
  // The oil ledger's own top-up of the very same drum.
  const led = run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date)
                   VALUES (?, 'receipt', 20, 20, ?)`, P3, P3DAY).lastInsertRowid;
  stock.rebuild({ wipe: true });
  const counted = () => get(`SELECT COALESCE(SUM(counts),0) c FROM stock_moves
                              WHERE section='oil' AND kind='in' AND item_name='Phase3 Test Oil' AND txn_date=?`, P3DAY).c;
  assert.strictEqual(counted(), 2, 'while both stand, both count — that is the double count');

  run('UPDATE stock_ledger SET voided = 1 WHERE id = ?', led);
  stock.rebuild({ wipe: true });
  assert.strictEqual(counted(), 1, 'voiding the ledger twin leaves exactly one record of the delivery');
  assert.ok(get('SELECT id FROM stock_ledger WHERE id = ?', led), 'and the row is still there — marked, not deleted');
});

// ---- the section rule runs both ways ---------------------------------------
//
// Demoting alone was half the job. A drum of kerosene bought on a request someone categorised
// "General Items" is still kerosene: leaving it in the general section put a product's receipts
// in one book and its issues in the other, which is how five lubricants came to show a negative
// balance while the general balance carried oil that was never a general item.

test('a lubricant bought as a general item is still oil stock', () => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('PR-1', '2026-09-20', 'open')`).lastInsertRowid;
  // Categorised General Items — exactly how these were recorded.
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category)
                 VALUES (?, 'Phase3 Test Oil', 30, 'General Items')`, m).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES (?, ?, 'Phase3 Test Oil', 30, 100, '2026-09-20')`, m, l);
  stock.rebuild({ wipe: true });
  const row = get(`SELECT section, counts FROM stock_moves
                    WHERE source_table='grn' AND item_name='Phase3 Test Oil' AND txn_date='2026-09-20'`);
  assert.strictEqual(row.section, 'oil', 'the oil book knows this name, so it is oil stock wherever it was written');
  assert.strictEqual(row.counts, 1);
});

test('something the oil book does not know stays general', () => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('PR-2', '2026-09-21', 'open')`).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category)
                 VALUES (?, 'Ordinary Bolt', 5, 'General Items')`, m).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES (?, ?, 'Ordinary Bolt', 5, 10, '2026-09-21')`, m, l);
  stock.rebuild({ wipe: true });
  assert.strictEqual(get(`SELECT section FROM stock_moves WHERE item_name='Ordinary Bolt'`).section, 'general',
    'promotion applies to lubricants only — it is not a general reclassifier');
});

test('a product keeps one balance, not one per section', () => {
  const rows = all(`SELECT section, COUNT(*) n FROM stock_moves WHERE item_name='Phase3 Test Oil' GROUP BY section`);
  assert.deepStrictEqual(rows.map((r) => r.section), ['oil'],
    'every movement of it lands in the same book — receipts and issues cannot drift apart');
});

// ---- the doors offer lubricants ---------------------------------------------
//
// 19 of the 30 lubricants have no store_items row, so until now HD-68 could only be typed
// free-hand on a request or a transfer — which is exactly how one drum came to be written five
// different ways and the alias queue filled up. The stores picker now offers them from the oil
// book itself, by code and by every name they have been known by.

test('the stores picker offers a lubricant that has no catalogue row', async () => {
  const r = await fetch(`${base}/api/stores/items/search?q=` + encodeURIComponent('Phase3 Test Oil'), { headers: { cookie } });
  const rows = await r.json();
  const hit = rows.find((x) => x.is_lubricant && x.name === 'Phase3 Test Oil');
  assert.ok(hit, 'offered from the oil book');
  assert.strictEqual(hit.item_no, 'OIL-9900', 'by its own code');
  assert.strictEqual(hit.id, null, 'and NOT as a second catalogue row — the oil book stays the one definition');
});

test('…and by a name it is only known by through an alias', async () => {
  const alias = get('SELECT id FROM lubricant_aliases WHERE raw_norm = ?', lubricants.normLube('HD-68 Oil'));
  assert.ok(alias, 'the alias exists from the date-split test above');
  const r = await fetch(`${base}/api/stores/items/search?q=` + encodeURIComponent('HD-68 Oil'), { headers: { cookie } });
  const rows = await r.json();
  assert.ok(rows.some((x) => x.is_lubricant), 'typing the spelling on the paperwork finds the product');
});

test('picking one records the canonical name, so it resolves with no new alias', () => {
  // The picker writes the product's own name into the line. That is the whole mechanism:
  // identity travels as the name, so nothing has to be taught a sixth spelling.
  const before = get('SELECT COUNT(*) c FROM lubricant_aliases WHERE resolved = 0').c;
  const r = lubricants.resolveLubricant('Phase3 Test Oil', { record: true, source: 'picker' });
  assert.ok(r.resolved);
  assert.strictEqual(get('SELECT COUNT(*) c FROM lubricant_aliases WHERE resolved = 0').c, before,
    'a picked lubricant never adds to the queue');
});

// ---- one row per lubricant, whatever it was called ---------------------------
//
// Promoting a lubricant into the oil section was only half of identifying it. The oil ledger
// keys its movements by the product CODE (itemKey('oil', name, 'OIL-0021') -> OIL0021) while
// every other door keys by the written NAME (HD68OIL, HD68OILVALVOLINE) — so one product's
// receipts and issues sat in DIFFERENT rows and the shelf was counted in pieces. On the live
// book HD 68 Oil read -573 under its code while 1,000 L of the same oil sat under two spellings
// of its name. Nothing was missing. Keyed by product, the spellings collapse and it reads 427.
//
// The CODE form is used, not the name form: itemKey() strips brackets and the brand lives in the
// bracket, so "HD 68 Oil (Servo)" and "HD 68 Oil (Valvoline)" would otherwise merge into one row.

const KEYTEST = mkProduct('Keytest Hy/Oil (Brandex)', 'hydraulic', 'L');
run('UPDATE products SET code = ? WHERE id = ?', 'OIL-9101', KEYTEST);
run(`INSERT INTO stock_items (code, section, name, item_key, unit, source_table, source_id, active)
     VALUES ('OIL-9101', 'oil', 'Keytest Hy/Oil (Brandex)', 'OIL9101', 'L', 'products', ?, 1)`, KEYTEST);
lubricants.seedCatalogueAliases();

test('every spelling of a lubricant lands on one row, keyed by its product', () => {
  // Received on the oil ledger (keyed by code) and issued through stores (keyed by name).
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
       VALUES (?, 'receipt', 500, 500, '2026-08-02', 'keytest')`, KEYTEST);
  // …and bought again through a door that keys by the written NAME, not the product code.
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('KEY-1', '2026-08-04', 'open')`).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category)
                 VALUES (?, 'Keytest Hy/Oil (Brandex)', 120, 'General Items')`, m).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
       VALUES (?, ?, 'Keytest Hy/Oil (Brandex)', 120, 90, '2026-08-04')`, m, l);
  stock.rebuild({ wipe: true });
  const rows = all(`SELECT item_key, ROUND(SUM(CASE WHEN counts=0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),2) bal
                      FROM stock_moves WHERE section='oil' AND item_name LIKE 'Keytest%' GROUP BY item_key`);
  assert.strictEqual(rows.length, 1, 'one product, one row — not one row per spelling');
  assert.strictEqual(rows[0].item_key, 'OIL9101', 'and it is keyed by the product code');
});

test('a lubricant written by a different name joins the same row', () => {
  run(`INSERT INTO lubricant_aliases (raw_text, raw_norm, effective_from, product_id, resolved)
       VALUES ('Brandex 68', ?, '', ?, 1)`, lubricants.normLube('Brandex 68'), KEYTEST);
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
       VALUES (?, 'receipt', 40, 40, '2026-08-05', 'keytest alias')`, KEYTEST);
  stock.rebuild({ wipe: true });
  const keys = all(`SELECT DISTINCT item_key FROM stock_moves WHERE section='oil' AND item_name LIKE '%eytest%'`);
  assert.strictEqual(keys.length, 1, 'an alias is the same thing, so it is the same row');
});

test('the code is the key, so two brands of one grade stay apart', () => {
  const A = mkProduct('Twin 68 Oil (Alpha)', 'hydraulic', 'L');
  const B = mkProduct('Twin 68 Oil (Beta)', 'hydraulic', 'L');
  run('UPDATE products SET code = ? WHERE id = ?', 'OIL-9102', A);
  run('UPDATE products SET code = ? WHERE id = ?', 'OIL-9103', B);
  assert.strictEqual(stock.itemKey('oil', 'Twin 68 Oil (Alpha)'), stock.itemKey('oil', 'Twin 68 Oil (Beta)'),
    'the NAME form flattens them together — this is why it cannot be the key');
  assert.notStrictEqual(stock.itemKey('oil', 'Twin 68 Oil (Alpha)', 'OIL-9102'),
    stock.itemKey('oil', 'Twin 68 Oil (Beta)', 'OIL-9103'),
    'the CODE form keeps two oils the workshop buys separately apart');
});

test('the shelf is labelled with the name the workshop agreed on', () => {
  const row = stock.items('oil', 'Keytest', 5).find((r) => r.item_key === 'OIL9101');
  assert.ok(row);
  assert.strictEqual(row.item_name, 'Keytest Hy/Oil (Brandex)',
    'not whichever spelling happened to sort last');
});

test('searching shows the whole balance, not just the rows spelt that way', () => {
  const full = stock.items('oil', null, 500).find((r) => r.item_key === 'OIL9101');
  const found = stock.items('oil', 'Keytest', 10).find((r) => r.item_key === 'OIL9101');
  assert.ok(full && found);
  assert.strictEqual(found.balance, full.balance,
    'filtering picks which ITEMS to show — it must not filter the movements being totalled');
});

test('a lubricant can be found by its code', () => {
  const found = stock.items('oil', 'OIL-9101', 10).find((r) => r.item_key === 'OIL9101');
  assert.ok(found, 'the code is on the drum and on the paperwork');
});

test('the catalogue sync finds the lubricant it already has, instead of minting a second one', () => {
  // The first sync legitimately adds a row for any product that never had one. The trap is the
  // SECOND: on the live book all 30 lubricant rows were keyed by NAME (they were made while
  // products.code was still NULL), so the sync looked for the key it mints today — the CODE form —
  // found nothing, and would have minted 30 duplicates with 30 new codes.
  stock.syncItems();
  const before = get("SELECT COUNT(*) c FROM stock_items WHERE section = 'oil'").c;
  stock.syncItems();
  const after = get("SELECT COUNT(*) c FROM stock_items WHERE section = 'oil'").c;
  assert.strictEqual(after, before, 'a re-sync must not duplicate the oil catalogue');
  assert.strictEqual(get("SELECT COUNT(*) c FROM stock_items WHERE section = 'oil' AND source_id = ?", KEYTEST).c, 1,
    'one catalogue row per product');
});
