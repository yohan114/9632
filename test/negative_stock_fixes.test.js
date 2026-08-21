'use strict';

// Why a shelf read less than nothing.
//
// Thirty items across three sections showed a negative balance. They had three different causes
// and not one of them was missing stock:
//
//   OIL     A stock-take that writes stock DOWN is stored as a positive magnitude — the level it
//           was counted at is in balance_after and the level the book claimed is the row before.
//           Read from qty alone it was ADDED: HD-46 was counted at 221.75 L and the shelf carried
//           629.75, exactly twice the 204 written off. Against the owner's July count the section
//           read 3,111 L for a counted 1,384.
//   GENERAL The importer dropped the MR number the storekeeper writes on every handover, and
//           appended the site to the item name, so "AC-Belt (45) — Mellawagedara" was filed apart
//           from the receipt of that very belt.
//   FILTER  A filter is its part number, and 74% of receipts write that number inside brackets —
//           "Oil Filter (C-206)". itemKey() drops brackets, so those receipts piled into three
//           generic buckets while the services that fitted them went out against C206. And the
//           workshop's own filter register, 663 units, was never read by the rebuild at all.
//
// What must NOT happen while fixing them: no quantity may be invented, and no description may be
// rewritten — the recipient and the site are things the storekeeper wrote down on purpose.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-negstock-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const stock = require('../src/lib/stock');
const lubricants = require('../src/lib/lubricants');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

const CUTOVER = '2026-08-11';
run(`INSERT INTO stock_opening (section, mode, cutover, note) VALUES ('filter','cutover',?,'test')
     ON CONFLICT(section) DO UPDATE SET mode='cutover', cutover=excluded.cutover`, CUTOVER);

const bal = (section, key) => get(
  `SELECT ROUND(COALESCE(SUM(CASE WHEN counts = 0 THEN 0 WHEN kind IN ('in','opening','adjust') THEN qty ELSE -qty END),0),2) v
     FROM stock_moves WHERE section = ? AND item_key = ?`, section, key).v;

// ---- a stock-take can write stock DOWN -------------------------------------

const OILP = run(`INSERT INTO products (code, name, category, unit, active) VALUES ('OIL-8001','Negtest Hy/Oil','hydraulic','L',1)`).lastInsertRowid;
run(`INSERT INTO stock_items (code, section, name, item_key, unit, source_table, source_id, active)
     VALUES ('OIL-8001','oil','Negtest Hy/Oil','OIL8001','L','products',?,1)`, OILP);
lubricants.seedCatalogueAliases();

test('a stock-take that writes stock down subtracts it', () => {
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
       VALUES (?, 'receipt', 300, 300, '2026-07-01', 'delivery')`, OILP);
  // Counted at 90 against a book of 300 — the magnitude is stored positive, as the book does.
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
       VALUES (?, 'adjustment', 210, 90, '2026-07-31', 'Physical 90 vs book 300')`, OILP);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('oil', 'OIL8001'), 90, 'the shelf is what was counted, not 510');
});

test('a stock-take that writes stock up still adds it', () => {
  run(`INSERT INTO stock_ledger (product_id, kind, qty, balance_after, txn_date, note)
       VALUES (?, 'adjustment', 10, 100, '2026-08-01', 'Physical 100 vs book 90')`, OILP);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('oil', 'OIL8001'), 100);
});

test('a write-down is not counted as something received', () => {
  const row = stock.items('oil', 'Negtest', 5).find((r) => r.item_key === 'OIL8001');
  assert.ok(row);
  assert.strictEqual(row.received, 310, 'a correction downwards is not a delivery');
  assert.strictEqual(row.balance, 100);
});

// ---- a filter is its part number -------------------------------------------

run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price) VALUES ('C-206','C206','Oil Filter',1200)`);
run(`INSERT INTO filter_prices (filter_no, filter_no_norm, category, unit_price) VALUES ('FF-5052','FF5052','Fuel Filter',900)`);

const mkFilterGrn = (desc, qty, date) => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES (?, ?, 'received')`, 'FMR-' + desc.slice(0, 6) + qty, date).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, ?, 'Filters')`, m, desc, qty).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, ?, ?, 1200, ?)`, m, l, desc, qty, date);
  return m;
};

test('a receipt with the number in brackets is filed under that number', () => {
  mkFilterGrn('Oil Filter (C-206)', 4, '2026-08-12');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'C206'), 4, 'not in a generic OILFILTER bucket');
});

test('the filter fitted on a service meets the receipt it came from', () => {
  const s = run(`INSERT INTO service_jobs (service_date, job_no) VALUES ('2026-08-14','SVC-N1')`).lastInsertRowid;
  run(`INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, qty) VALUES (?, 'C-206', 'C206', 'Oil Filter', 1)`, s);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'C206'), 3, 'received four, fitted one');
});

test('two part numbers on one line find the one the catalogue knows, and the line keeps its wording', () => {
  mkFilterGrn('FF-5052 &          FS-1275', 2, '2026-08-13');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'FF5052'), 2);
  const row = get(`SELECT item_name FROM stock_moves WHERE section='filter' AND item_key='FF5052' AND kind='in'`);
  assert.match(row.item_name, /FS-1275/, 'the second number stays on the paperwork, it is not deleted');
});

test('a description with no recognisable number is left alone, not guessed', () => {
  mkFilterGrn('Oil Filter', 5, '2026-08-12');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'OILFILTER'), 5, 'a nameless filter stays in its generic bucket');
  assert.strictEqual(bal('filter', 'C206'), 3, 'and does not land on some other filter');
});

test('a bracket that is a note, not a part number, is not mistaken for one', () => {
  mkFilterGrn('Oil Filter (2 Nos)', 3, '2026-08-12');
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'C206'), 3, 'unchanged — "(2 Nos)" is not in the filter catalogue');
});

// ---- the filter register is the shelf --------------------------------------

test('the filter register opens the shelf at the cut-over', () => {
  run(`INSERT INTO filter_stock (filter_type, part_no, qty_in_stock, unit_cost) VALUES ('Oil Filter','C-206',30,1200)`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('filter', 'C206'), 33, '30 on the shelf, plus 4 received, less 1 fitted');
});

test('the opening is dated at the cut-over, which is what a cut-over means', () => {
  const o = get(`SELECT txn_date, counts FROM stock_moves WHERE section='filter' AND source_table='filter_stock'`);
  assert.strictEqual(o.txn_date, CUTOVER);
  assert.strictEqual(o.counts, 1);
});

test('a filter on the register that nobody has a number for is skipped, not opened blindly', () => {
  const before = get(`SELECT COUNT(*) c FROM stock_moves WHERE source_table='filter_stock'`).c;
  run(`INSERT INTO filter_stock (filter_type, part_no, qty_in_stock) VALUES ('Air Filter','',7)`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(get(`SELECT COUNT(*) c FROM stock_moves WHERE source_table='filter_stock'`).c, before,
    'no part number, nothing to open against');
});

// ---- a handover knows its own receipt --------------------------------------

test('an issue carrying an MR number is filed under the receipt it came out of', () => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('900111','2026-06-10','received')`).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, 'AC-Belt (45)', 1, 'General Items')`, m).lastInsertRowid;
  run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, 'AC-Belt (45)', 1, 1662.5, '2026-06-10')`, m, l);
  // Exactly as the importer wrote it: item — site (to person).
  run(`INSERT INTO issues (description, qty, issue_date, mrn_no) VALUES ('AC-Belt (45) — Mellawagedara (to Madushan)', 1, '2026-06-12', '900111')`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('general', stock.itemKey('general', 'AC-Belt (45)')), 0,
    'one received, one handed over — not minus one in a row of its own');
});

test('the storekeeper\'s own wording is never rewritten', () => {
  const row = get(`SELECT item_name FROM stock_moves WHERE section='general' AND source_table='issues' AND item_name LIKE 'AC-Belt%'`);
  assert.match(row.item_name, /Mellawagedara/, 'the site stays');
  assert.match(row.item_name, /Madushan/, 'and so does the recipient — the receipt does not carry either');
});

test('an MR number naming a request that lists the item twice is not guessed between', () => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('900222','2026-06-10','received')`).lastInsertRowid;
  for (const q of [1, 1]) {
    const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, 'Twin Widget', ?, 'General Items')`, m, q).lastInsertRowid;
    run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, 'Twin Widget', ?, 10, '2026-06-10')`, m, l, q);
  }
  run(`INSERT INTO issues (description, qty, issue_date, mrn_no) VALUES ('Twin Widget (to Anura)', 1, '2026-06-12', '900222')`);
  stock.rebuild({ wipe: true });
  const row = get(`SELECT item_key FROM stock_moves WHERE source_table='issues' AND item_name LIKE 'Twin Widget%'`);
  assert.strictEqual(row.item_key, stock.itemKey('general', 'Twin Widget'),
    'it falls back to its own key rather than picking one of two identical lines');
});

test('an issue with no MR number behaves exactly as before', () => {
  run(`INSERT INTO issues (description, qty, issue_date) VALUES ('Loose Item (to Ruwan)', 2, '2026-06-12')`);
  stock.rebuild({ wipe: true });
  const row = get(`SELECT item_key FROM stock_moves WHERE source_table='issues' AND item_name LIKE 'Loose Item%'`);
  assert.strictEqual(row.item_key, stock.itemKey('general', 'Loose Item (to Ruwan)'));
});

test('rebuilding twice lands on the same balances', () => {
  stock.rebuild({ wipe: true });
  const a = [bal('oil', 'OIL8001'), bal('filter', 'C206'), bal('filter', 'FF5052')];
  stock.rebuild({ wipe: true });
  assert.deepStrictEqual([bal('oil', 'OIL8001'), bal('filter', 'C206'), bal('filter', 'FF5052')], a);
});

// ---- one handover, one deduction -------------------------------------------
//
// A handover got written down twice: once free-hand in the storekeeper's tracker, and once
// against the receipt through Stores. The free-hand row is the ONLY place the recipient and the
// issuing storekeeper survive, so it is muted, never deleted.
//
// What decides it is the receipt, not the clock. Two identical tracker lines could be two real
// handovers — the three in the live book were entered 26 seconds, 17 minutes and 43 minutes
// apart, which settles nothing. What settles it is that the request each names received only
// ONE: you cannot hand out two of something one of which was bought.

const mkReceipt = (mrnNo, desc, qty, date) => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES (?, ?, 'received')`, mrnNo, date).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, ?, ?, 'General Items')`, m, desc, qty).lastInsertRowid;
  const g = run(`INSERT INTO grn (mrn_id, mrn_line_id, description, qty, unit_price, delivery_date) VALUES (?, ?, ?, ?, 100, ?)`,
    m, l, desc, qty, date).lastInsertRowid;
  return { mrnId: m, lineId: l, grnId: g };
};

test('a handover recorded in both books only comes off the shelf once', () => {
  mkReceipt('950111', 'Dup Widget', 1, '2026-06-10');
  const g = get(`SELECT id FROM grn WHERE description = 'Dup Widget'`);
  run(`INSERT INTO issues (description, qty, issue_date, mrn_no) VALUES ('Dup Widget (to Anura)', 1, '2026-06-12', '950111')`);
  run(`INSERT INTO issues (description, qty, issue_date, grn_id) VALUES ('Dup Widget', 1, '2026-06-12', ?)`, g.id);
  stock.rebuild({ wipe: true });
  const key = stock.itemKey('general', 'Dup Widget');
  assert.strictEqual(bal('general', key), -1, 'both rows deduct while nothing is muted');

  run(`UPDATE issues SET voided = 1, voided_reason = 'written twice' WHERE description = 'Dup Widget (to Anura)'`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('general', key), 0, 'one received, one handed over');
});

test('a muted handover is still there, with the recipient it was written for', () => {
  const row = get(`SELECT item_name, counts FROM stock_moves WHERE item_name = 'Dup Widget (to Anura)'`);
  assert.ok(row, 'muting must not hide the row — the receipt-linked twin carries no recipient');
  assert.strictEqual(row.counts, 0, 'visible, but it no longer moves the balance');
});

test('un-muting puts it back, so the call is reversible', () => {
  run(`UPDATE issues SET voided = 0, voided_reason = NULL WHERE description = 'Dup Widget (to Anura)'`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('general', stock.itemKey('general', 'Dup Widget')), -1);
  run(`UPDATE issues SET voided = 1 WHERE description = 'Dup Widget (to Anura)'`);
  stock.rebuild({ wipe: true });
});

test('two handovers the receipt CAN account for are both left standing', () => {
  mkReceipt('950222', 'Pair Widget', 2, '2026-06-10');
  for (let n = 0; n < 2; n++) {
    run(`INSERT INTO issues (description, qty, issue_date, mrn_no, issued_by) VALUES ('Pair Widget (to Anura)', 1, '2026-06-12', '950222', 'Priyankara')`);
  }
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('general', stock.itemKey('general', 'Pair Widget')), 0,
    'two bought and two handed out is not a double entry');
});

test('a handover with no receipt on the number it names is not blamed on something else', () => {
  // "York (to Krishna)" — its request holds a Universal Joint and a Belt, and no York at all.
  mkReceipt('950333', 'Universal Joint', 2, '2026-06-15');
  run(`INSERT INTO issues (description, qty, issue_date, mrn_no) VALUES ('Yorkish Thing (to Krishna)', 1, '2026-06-21', '950333')`);
  stock.rebuild({ wipe: true });
  assert.strictEqual(bal('general', stock.itemKey('general', 'Yorkish Thing')), -1,
    'it stays negative and visible — a missing receipt is a different problem from a double entry');
  assert.strictEqual(bal('general', stock.itemKey('general', 'Universal Joint')), 2,
    'and the joint on that request is untouched');
});
