'use strict';

// The service & filter plan.
//
// The engine reads history and guesses; these tests pin the parts that must NOT be guesses —
// that duplicate services are merged rather than dropped (they carry real filter demand),
// that a month is measured as at its own first day rather than today, that the list never
// invents a part number, and that the order nets against stock summed across every row a
// part sits on.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-service-plan-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');

migrate();

const aliases = require('../src/lib/aliases');
const plan = require('../src/lib/service_plan');

const A = aliases.findOrCreateAsset('SP-01', {}).id;   // a well-serviced machine
const B = aliases.findOrCreateAsset('SP-02', {}).id;   // duplicate-service machine
const C = aliases.findOrCreateAsset('SP-03', {}).id;   // one service only

const svc = (assetId, date) => run(
  `INSERT INTO service_jobs (asset_id, service_date, site_location) VALUES (?, ?, 'Badalgama')`,
  assetId, date).lastInsertRowid;
const fil = (sid, cat, no) => run(
  `INSERT INTO service_filters (service_id, filter_no, filter_no_norm, category, qty)
   VALUES (?, ?, ?, ?, 1)`, sid, no, require('../src/lib/filter_no').normF(no), cat);

// SP-01: serviced every 90 days, always an oil filter and a fuel filter.
for (const [i, d] of ['2026-01-01', '2026-04-01', '2026-06-30'].entries()) {
  const s = svc(A, d);
  fil(s, 'Engine Oil Filter', 'C-115');
  fil(s, 'Primary Fuel Filter', i === 2 ? 'FC-1503' : 'FC-1104');
}

// SP-02: the same visit entered twice on one day, each row carrying a different filter.
const b1 = svc(B, '2026-02-01'); fil(b1, 'Engine Oil Filter', 'C-206');
const b2 = svc(B, '2026-02-01'); fil(b2, 'Air Filter Outer', 'A-1119');
const b3 = svc(B, '2026-05-02'); fil(b3, 'Engine Oil Filter', 'C-206'); fil(b3, 'Air Filter Outer', 'A-1119');

// SP-03: one service, and its filter line has no readable number.
const c1 = svc(C, '2026-05-01'); fil(c1, 'Engine Oil Filter', 'changed');

// The filter register lives in a migration step rather than the base schema.
run(`CREATE TABLE IF NOT EXISTS filter_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT, filter_type TEXT NOT NULL, brand TEXT, part_no TEXT,
  unit TEXT DEFAULT 'nos', qty_in_stock REAL DEFAULT 0, reorder_level REAL DEFAULT 5,
  unit_cost REAL DEFAULT 0, supplier TEXT, compatible_assets TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
run(`CREATE TABLE IF NOT EXISTS filter_stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, filter_id INTEGER NOT NULL, kind TEXT NOT NULL,
  qty REAL NOT NULL, balance_after REAL NOT NULL, asset_id INTEGER, job_id INTEGER,
  unit_price REAL, note TEXT, txn_date TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

// Stock: the same part on two rows, which must be summed.
run(`INSERT INTO filter_stock (filter_type, part_no, unit, qty_in_stock, reorder_level) VALUES ('Oil Filter','C-115','nos',2,0)`);
run(`INSERT INTO filter_stock (filter_type, part_no, unit, qty_in_stock, reorder_level) VALUES ('Oil Filter','C 115','nos',3,0)`);
run(`INSERT INTO filter_prices (filter_no, filter_no_norm, unit_price, uses, source) VALUES ('C-115','C115',1000,1,'test')`);

const find = (p, code) => [...p.due, ...p.carry].find((v) => v.asset_code === code);

test('a machine’s own rhythm drives its due date', () => {
  const p = plan.buildServicePlan({ month: '2026-09' });
  const v = find(p, 'SP-01');
  assert.ok(v, 'SP-01 is a candidate');
  assert.strictEqual(v.last_service, '2026-06-30');
  assert.strictEqual(v.visits, 3);
  // Two 90-day gaps, pulled toward the fleet prior — so near 90 but not exactly.
  assert.ok(v.expected_gap >= 80 && v.expected_gap <= 160, `expected gap ${v.expected_gap}`);
  // The due date is simply the last visit plus that gap — nothing else moves it.
  const expected = new Date(Date.UTC(2026, 5, 30) + v.expected_gap * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(v.due_date, expected);
  assert.strictEqual(v.basis, 'part fleet default', 'two gaps is not yet its own history');
});

test('servicing a machine takes it off this month’s list the same day', () => {
  // The list is checked each morning, so a service logged today has to count today. Measuring
  // the current month from its first day hid every service done since — HU-5097, serviced on
  // 12 August, kept showing as due from March.
  const M = aliases.findOrCreateAsset('SP-06', {}).id;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  // Two services 120 days apart, the last of them 180 days ago — a rhythm it is now past,
  // but not so far past that it counts as having no record at all.
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const s0 = svc(M, ago(300)); fil(s0, 'Engine Oil Filter', 'C-777');
  const s1 = svc(M, ago(180)); fil(s1, 'Engine Oil Filter', 'C-777');
  run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES ('SP-06-REQ', ?, ?, 'open')`, today, M);

  const before = plan.buildServicePlan({ month });
  assert.ok(find(before, 'SP-06'), 'due before it was serviced');

  const s2 = svc(M, today); fil(s2, 'Engine Oil Filter', 'C-777');
  const after = plan.buildServicePlan({ month });
  assert.ok(!find(after, 'SP-06'), 'and gone the moment the service is recorded');
  assert.strictEqual(after.as_of, today, 'the month is measured as at today, not its first day');
});

test('a month that is over is measured at its end, not at today', () => {
  const p = plan.buildServicePlan({ month: '2026-01' });
  assert.strictEqual(p.as_of, '2026-01-31', 'a finished month stops at its own last day');
});

test('two services on one day are ONE visit, and their filters are merged', () => {
  const p = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  const v = find(p, 'SP-02');
  assert.ok(v, 'SP-02 is listed');
  assert.strictEqual(v.visits, 2, 'three service rows, two real visits');
  // Dropping the duplicate instead of merging would lose the air filter entirely.
  const cats = v.core.map((k) => k.category).sort();
  assert.deepStrictEqual(cats, ['Air Filter Outer', 'Engine Oil Filter']);
});

test('the part suggested is the one that machine fitted last', () => {
  const v = find(plan.buildServicePlan({ month: '2026-09' }), 'SP-01');
  const fuel = v.core.find((k) => k.category === 'Primary Fuel Filter');
  assert.strictEqual(fuel.part, 'FC-1503', 'the most recent number, not the most frequent');
  assert.strictEqual(fuel.distinct_numbers, 2);
  assert.ok(fuel.alternates.length === 2, 'and it shows what else has been used');
  assert.ok(fuel.confirm, 'a category whose last two uses disagree is flagged to confirm');
});

test('a filter with no readable number is still requested, by category', () => {
  const p = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  const v = find(p, 'SP-03');
  assert.ok(v, 'SP-03 is listed');
  const oil = v.core.find((k) => k.category === 'Engine Oil Filter');
  assert.ok(oil, 'the category is known — the filter was fitted');
  assert.strictEqual(oil.part, null, 'but no number is invented for it');
  assert.ok(v.unreadable >= 1, 'and the unreadable line is counted');
});

test('stock is summed across every row a part sits on', () => {
  const p = plan.buildServicePlan({ month: '2026-09' });
  const c115 = p.parts.find((x) => x.part_norm === 'C115');
  assert.ok(c115, 'C-115 is on the order');
  // "C-115" and "C 115" are one part: 2 + 3, not whichever row was read first.
  assert.strictEqual(c115.on_hand, 5);
  assert.ok(c115.duplicate_stock_rows, 'and it says the stock sits on more than one row');
  assert.strictEqual(c115.to_buy, Math.max(0, c115.qty - 5));
});

test('a part with no stock row says so instead of implying the shelf is empty', () => {
  const p = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  const fc = p.parts.find((x) => x.part_norm === 'FC1503');
  assert.ok(fc, 'FC-1503 is on the order');
  assert.strictEqual(fc.on_hand, 0);
  assert.ok(fc.no_stock_row, 'flagged as absent from the stock sheet, not as zero stock');
});

test('the plan values only what it can price, and says what it could not', () => {
  const p = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  assert.ok(p.totals.value_priced >= 0);
  // Every unpriced part contributes to the unpriced quantity rather than to a money total.
  const unpriced = p.parts.filter((x) => x.unit_price == null);
  assert.strictEqual(p.totals.qty_unpriced, unpriced.reduce((s, x) => s + x.to_buy, 0));
  assert.ok(unpriced.every((x) => x.value === null));
});

test('it writes nothing', () => {
  const before = {
    svc: get('SELECT COUNT(*) c FROM service_jobs').c,
    fil: get('SELECT COUNT(*) c FROM service_filters').c,
    stock: get('SELECT COUNT(*) c FROM filter_stock').c,
    led: get('SELECT COUNT(*) c FROM filter_stock_ledger').c,
  };
  plan.buildServicePlan({ month: '2026-09' });
  plan.buildServicePlan({ month: '2026-10', includeLongOverdue: true });
  assert.deepStrictEqual({
    svc: get('SELECT COUNT(*) c FROM service_jobs').c,
    fil: get('SELECT COUNT(*) c FROM service_filters').c,
    stock: get('SELECT COUNT(*) c FROM filter_stock').c,
    led: get('SELECT COUNT(*) c FROM filter_stock_ledger').c,
  }, before);
});

test('a machine running but never serviced lately is “unknown”, not “overdue”', () => {
  // Years since its only service, yet the workshop is still raising parts for it. What is
  // missing is the RECORD, not the service — putting it in the overdue pile would bury the
  // machines that really are a fortnight past due.
  const D = aliases.findOrCreateAsset('SP-04', {}).id;
  const s = svc(D, '2024-01-01');
  fil(s, 'Engine Oil Filter', 'C-999');
  run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES ('SP-04-REQ', '2026-08-20', ?, 'open')`, D);

  const off = plan.buildServicePlan({ month: '2026-09' });
  const on = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  assert.ok(!find(off, 'SP-04'), 'kept off the working list');
  const shown = on.parked.find((v) => v.asset_code === 'SP-04');
  assert.ok(shown, 'but reachable, never hidden outright');
  assert.strictEqual(shown.state, 'unknown');
  assert.match(shown.why, /no service recorded/);
});

test('a machine nobody has touched in six months is parked, not overdue', () => {
  const E = aliases.findOrCreateAsset('SP-05', {}).id;
  const s = svc(E, '2025-06-01');
  fil(s, 'Engine Oil Filter', 'C-888');
  const on = plan.buildServicePlan({ month: '2026-09', includeLongOverdue: true });
  const shown = on.parked.find((v) => v.asset_code === 'SP-05');
  assert.ok(shown, 'listed once asked for');
  assert.strictEqual(shown.state, 'unknown');
  assert.match(shown.why, /parked/);
  assert.strictEqual(shown.active, false);
});

test('the four states account for every machine on the register', () => {
  const p = plan.buildServicePlan({ month: '2026-09' });
  const f = p.fleet;
  assert.strictEqual(f.overdue + f.due_soon + f.ok + f.unknown, f.registered,
    `states ${JSON.stringify(f)} must sum to the register`);
  assert.strictEqual(f.unknown,
    f.unknown_why.never_serviced + f.unknown_why.parked + f.unknown_why.no_recent_record);
});

test('the list is only what is overdue or due soon', () => {
  const p = plan.buildServicePlan({ month: '2026-09' });
  assert.strictEqual(p.totals.total, p.due.length + p.carry.length);
  assert.ok(p.due.every((v) => v.state === 'due_soon'));
  assert.ok(p.carry.every((v) => v.state === 'overdue'));
  // And the order covers exactly those machines — nothing OK or unknown puts a filter on it.
  const listed = p.totals.category_lines;
  assert.strictEqual(listed, [...p.due, ...p.carry].reduce((s, v) => s + v.core.length, 0));
});
