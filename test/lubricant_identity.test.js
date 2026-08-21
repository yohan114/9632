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
