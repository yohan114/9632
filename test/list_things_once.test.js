'use strict';

// One real thing, listed once.
//
// Three surfaces had drifted into showing the same thing more than once, each for its own
// reason, and each with its own way of being wrong if it were "fixed" too eagerly:
//
//   the job-card pickers — a machine can be carrying several cards left open years apart, all
//     still REQUESTED, so nothing on screen said which was the live one. Collapsing to the
//     newest is right; making the older ones unreachable is not, because a machine genuinely
//     can have two live cards.
//   Pending Parts — ten lines of one item on ONE request is one item, qty 10. The SAME item on
//     two DIFFERENT requests is two requisitions of different ages, and merging those would
//     hide how long one has been waiting. The line between the two is the whole test.
//   the Maintenance Summery — the machine number is the row identity, so a machine may only
//     ever occupy one row, and nothing written against either of its cards may be lost.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-list-once-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

for (const n of ['admin', 'workshop', 'viewer']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, 'workshop');

const daily = require('../src/lib/daily_reports');
const aliases = require('../src/lib/aliases');
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

const api = async (p) => {
  const r = await fetch(base + '/api' + p, { headers: { cookie } });
  return { status: r.status, body: await r.json() };
};

const today = new Date().toISOString().slice(0, 10);
const mkJob = (no, assetId, opts = {}) => run(
  `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
   VALUES (?, ?, 'repair', ?, ?, ?)`,
  no, assetId, opts.description || 'work', opts.status || 'REQUESTED', opts.requested_at || today
).lastInsertRowid;

// ---- the pickers ----------------------------------------------------------

// One machine, three cards left open across three years — the shape that made someone log
// today's work against a 2023 card.
const stale = aliases.findOrCreateAsset('TT-01', {}).id;
const staleOld = mkJob('2023/4/R/11', stale, { requested_at: '2023-04-02' });
const staleMid = mkJob('2024/7/R/90', stale, { requested_at: '2024-07-02' });
const staleNew = mkJob('2026/8/R/900', stale, { requested_at: '2026-08-02' });

test('a picker offers each machine once — its newest card — and says how many others exist', async () => {
  const r = await api('/jobs?open=1&one_per_asset=1&limit=25&q=TT-01');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 1, 'three open cards on one machine, one row offered');
  assert.strictEqual(r.body[0].id, staleNew, 'the newest by job number, not by requested_at');
  assert.strictEqual(r.body[0].open_siblings, 2, 'and it admits to the two it is standing in for');
  assert.strictEqual(r.body[0].asset_id, stale, 'the asset comes back so the row can expand');
});

test('without the flag nothing changes — the browse list still sees every card', async () => {
  const r = await api('/jobs?open=1&limit=25&q=TT-01');
  assert.strictEqual(r.body.length, 3, 'the Job Cards screen must keep showing all three');
  assert.ok(r.body.every((j) => j.open_siblings === undefined), 'and carries no picker-only field');
});

test('typing an old job number in full still finds it — the collapse never hides a card', async () => {
  // The window runs over the already-filtered set, so a search that names one card
  // has nothing to collapse it against. This is the escape hatch.
  const r = await api('/jobs?open=1&one_per_asset=1&limit=25&q=2023/4/R/11');
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].id, staleOld, 'the 2023 card is still reachable by name');
});

test('the expander lists the machine’s other open cards', async () => {
  const r = await api(`/jobs?open=1&limit=10&asset_id=${stale}`);
  assert.deepStrictEqual(r.body.map((j) => j.id), [staleNew, staleMid, staleOld], 'newest first');
});

test('cards with no machine are never folded together', async () => {
  // SQLite treats NULLs as equal inside a window partition, so partitioning on asset_id alone
  // would collapse every container / general card into one row.
  const a = mkJob('2026/8/R/941', null, { description: 'container A' });
  const b = mkJob('2026/8/R/942', null, { description: 'container B' });
  const r = await api('/jobs?open=1&one_per_asset=1&limit=25&q=2026/8/R/94');
  const ids = r.body.map((j) => j.id);
  assert.ok(ids.includes(a) && ids.includes(b), 'both survive');
  assert.ok(r.body.every((j) => j.open_siblings === 0), 'and neither claims a sibling');
});

// ---- Pending Parts --------------------------------------------------------

const mkMrn = (no, assetId, date, src) => run(
  `INSERT INTO mrn (mrn_no, req_date, asset_id, purchase_source, status) VALUES (?, ?, ?, ?, 'open')`,
  no, date, assetId, src || null
).lastInsertRowid;
const mkLine = (mrnId, desc, qty, opts = {}) => run(
  `INSERT INTO mrn_lines (mrn_id, description, qty, unit, qty_received) VALUES (?, ?, ?, ?, ?)`,
  mrnId, desc, qty, opts.unit || 'nos', opts.received || 0
).lastInsertRowid;

const partsAsset = aliases.findOrCreateAsset('TT-02', {}).id;

test('one item typed on ten lines of one request is one line, qty 10', () => {
  const m = mkMrn('900001', partsAsset, today, 'local_purchase');
  for (let i = 0; i < 10; i++) mkLine(m, 'Speedo Meter (km)', 1);

  const d = daily.build('pending_parts', {});
  const mine = d.sections.flatMap((s) => s.rows).filter((r) => r.description === 'Speedo Meter (km)');
  assert.strictEqual(mine.length, 1, 'ten lines, one row');
  assert.strictEqual(mine[0].qty, 10, 'and the quantity the office would have written');
  assert.match(mine[0].note, /10 lines on this request/, 'the fold is stated, not silent');
});

test('case, spacing and punctuation do not make a second item — digits do', () => {
  const m = mkMrn('900002', partsAsset, today, 'local_purchase');
  mkLine(m, 'Fuel Filter (FC-707A)', 2);
  mkLine(m, 'Fuel  Filter FC-707A', 3);      // the same filter, typed loosely
  mkLine(m, 'Cabin Fan (24V)', 1);
  mkLine(m, 'Cabin Fan (12V)', 1);           // a DIFFERENT fan — the voltage must survive

  const rows = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows);
  const filters = rows.filter((r) => /fuel\s+filter/i.test(r.description));
  assert.strictEqual(filters.length, 1, 'one filter, however it was typed');
  assert.strictEqual(filters[0].qty, 5);
  assert.strictEqual(rows.filter((r) => /Cabin Fan/.test(r.description)).length, 2, '24V and 12V stay apart');
});

test('the same item on two different requests stays two lines', () => {
  // Two requisitions of different ages. Merging them would hide that one has been
  // waiting since March — the thing the sheet exists to show.
  const a = mkMrn('900003', partsAsset, '2026-03-01', 'local_purchase');
  const b = mkMrn('900004', partsAsset, today, 'local_purchase');
  mkLine(a, 'Cotton Waste', 20);
  mkLine(b, 'Cotton Waste', 20);

  const rows = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows)
    .filter((r) => r.description === 'Cotton Waste');
  assert.strictEqual(rows.length, 2, 'two requests, two lines');
});

test('a remark typed on a merged row is read back on that same row', async () => {
  // The whole point of the anchor. A remark belongs to the ITEM on the request — mrn_lines has
  // no remarks column, so a per-line remark cannot come from the source data anyway — and it
  // has to be written somewhere the report will look again. Anchoring on a line that had
  // already been delivered would post the remark into a hole.
  const m = mkMrn('900005', partsAsset, today, 'local_purchase');
  mkLine(m, 'Overall - M', 2, { received: 2 });   // already in, and therefore off the report
  mkLine(m, 'Overall - M', 2);
  mkLine(m, 'Overall - M', 2);

  const before = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows)
    .filter((r) => r.description === 'Overall - M');
  assert.strictEqual(before.length, 1, 'one item on one request, one row');
  assert.strictEqual(before[0].qty, 4, 'only what is still outstanding');

  const r = await fetch(`${base}/api/reports/daily/pending-parts/notes/${before[0].line_id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ remarks: 'chasing the supplier' }),
  });
  assert.strictEqual(r.status, 200);

  const after = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows)
    .filter((r2) => r2.description === 'Overall - M');
  assert.strictEqual(after.length, 1, 'writing a remark must not split the row in two');
  assert.strictEqual(after[0].remarks, 'chasing the supplier', 'and it comes back');
  assert.strictEqual(after[0].qty, 4, 'with the quantity untouched');
});

test('every row can be written to and read back — no row anchors on a delivered line', () => {
  const outstanding = new Set(require('../src/db')
    .all(`SELECT ml.id FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
           WHERE COALESCE(ml.qty_received, 0) < ml.qty AND date(m.req_date) <= date(?)`, today)
    .map((r) => r.id));
  const rows = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows);
  const seen = new Set();
  for (const r of rows) {
    assert.ok(outstanding.has(r.line_id), `row "${r.description}" anchors on a line the report never reads back`);
    assert.ok(!seen.has(r.line_id), `two rows share one edit target (${r.line_id})`);
    seen.add(r.line_id);
  }
});

test('polarity is not punctuation — (+) and (-) are different parts', () => {
  const m = mkMrn('900009', partsAsset, today, 'local_purchase');
  mkLine(m, 'Battery terminal Pole type (+)', 1);
  mkLine(m, 'Battery terminal Pole type (-)', 1);
  // ...while a part number typed loosely is still one part.
  mkLine(m, 'A/C Belt (A-46)', 1);
  mkLine(m, 'AC Belt (A46)', 1);

  const rows = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows);
  assert.strictEqual(rows.filter((r) => /Battery terminal/.test(r.description)).length, 2, 'two terminals');
  assert.strictEqual(rows.filter((r) => /Belt/.test(r.description)).length, 1, 'one belt, qty 2');
});

test('a partly delivered group says so instead of just shrinking', () => {
  const m = mkMrn('900006', partsAsset, today, 'local_purchase');
  mkLine(m, 'Oil Filter (C-206)', 2, { received: 1 });
  mkLine(m, 'Oil Filter (C-206)', 2);

  const row = daily.build('pending_parts', {}).sections.flatMap((s) => s.rows)
    .find((r) => r.description === 'Oil Filter (C-206)');
  assert.strictEqual(row.qty, 3, 'three still to come, not four');
  assert.match(row.note, /3 of 4 still to come/, 'and the storekeeper is told part of it arrived');
});

test('nothing generated ever lands in the box a person types into', () => {
  // The Remarks box is saved back verbatim, so a hint written into it would be
  // persisted as though someone had typed it.
  for (const r of daily.build('pending_parts', {}).sections.flatMap((s) => s.rows)) {
    assert.ok(!/lines on this request|still to come|looks wrong/.test(r.remarks || ''),
      `generated text leaked into remarks: ${r.remarks}`);
  }
});

test('collapsing changes how many rows there are, never how much is outstanding', () => {
  const outstanding = get(
    `SELECT ROUND(SUM(ml.qty - COALESCE(ml.qty_received, 0)), 2) AS q
       FROM mrn_lines ml JOIN mrn m ON m.id = ml.mrn_id
      WHERE COALESCE(ml.qty_received, 0) < ml.qty AND date(m.req_date) <= date(?)`, today).q;
  const d = daily.build('pending_parts', {});
  const shown = d.sections.reduce((s, sec) => s + sec.rows.reduce((a, r) => a + r.qty, 0), 0);
  assert.ok(Math.abs(outstanding - shown) < 1e-6, `${shown} shown vs ${outstanding} outstanding`);

  // And the numbering still runs one per request, as the paper sheet does.
  for (const sec of d.sections) {
    assert.strictEqual(sec.rows.filter((r) => r.no !== '').length, sec.requests);
  }
});

// ---- the Maintenance Summery ----------------------------------------------

test('a machine holding two open cards occupies one row, and loses nothing', async () => {
  const m = aliases.findOrCreateAsset('TT-03', {}).id;
  const older = mkJob('2026/4/R/206', m, { description: 'bucket repair', requested_at: '2026-04-10' });
  const newer = mkJob('2026/5/R/281', m, { description: 'hydraulic leak', requested_at: '2026-05-16' });
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'seal replacement', 4)`, older, today);
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'pressure test', 3)`, newer, today);

  const rows = daily.build('job_summary', {}).rows.filter((r) => r.machine === 'TT-03');
  assert.strictEqual(rows.length, 1, 'the machine number is the row identity');
  const row = rows[0];
  assert.strictEqual(row.cards, 2);
  assert.strictEqual(row.job_id, newer, 'a note typed here belongs to the live card');
  assert.match(row.job_description, /hydraulic leak/);
  assert.match(row.job_description, /bucket repair/, 'the older card’s purpose is not dropped');
  assert.match(row.completed_repairs, /pressure test/);
  assert.match(row.completed_repairs, /seal replacement/, 'work done on the older card still counts');
  assert.strictEqual(row.start_date, '10.04.2026', 'the date the machine came in, not the later card’s');
});

test('the same clause on both cards is written once', () => {
  const m = aliases.findOrCreateAsset('TT-04', {}).id;
  const a = mkJob('2026/4/R/300', m, { description: 'brake repair', requested_at: '2026-04-01' });
  const b = mkJob('2026/6/R/400', m, { description: 'Brake  Repair', requested_at: '2026-06-01' });
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'brake liner change', 2)`, a, today);
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'brake liner change', 2)`, b, today);

  const row = daily.build('job_summary', {}).rows.find((r) => r.machine === 'TT-04');
  assert.strictEqual(row.job_description.toLowerCase().split('brake').length - 1, 1, 'one brake repair, not two');
  assert.strictEqual(row.completed_repairs, 'brake liner change');
});

test('a note deleted on the merged row stays deleted', async () => {
  // Read merges both cards, but an edit writes to the lead card only. If the read kept
  // merging after that, deleting a word would just pull the older card's copy back in and
  // nothing could ever be removed.
  const m = aliases.findOrCreateAsset('TT-06', {}).id;
  const older = mkJob('2026/3/R/10', m, { description: 'clutch', requested_at: '2026-03-01' });
  // Stamped as if it were bulk-imported, which is true of a quarter of the real open cards —
  // so the lead must be chosen by job number, not by this date.
  const newer = mkJob('2026/7/R/20', m, { description: 'gearbox', requested_at: '2020-01-01' });
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'gearbox strip', 2)`, newer, today);
  const put = (job, body) => fetch(`${base}/api/reports/daily/job-summary/notes/${job}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });

  await put(older, { pending_repairs: 'waiting on the clutch kit' });
  let row = daily.build('job_summary', {}).rows.find((r) => r.machine === 'TT-06');
  assert.strictEqual(row.job_id, newer, 'the live card owns the row');
  assert.match(row.pending_repairs, /clutch kit/, 'until the row has its own note, the older one still shows');

  // The supervisor clears the cell on the row in front of them.
  await put(newer, { pending_repairs: '' });
  row = daily.build('job_summary', {}).rows.find((r) => r.machine === 'TT-06');
  assert.strictEqual(row.pending_repairs, '', 'it stays cleared — the older card cannot resurrect it');
});

test('a single-card machine’s text is passed through untouched', () => {
  // Merging is only for machines carrying more than one card. Everything else must reach the
  // sheet exactly as it was typed, commas and all.
  const m = aliases.findOrCreateAsset('TT-07', {}).id;
  const j = mkJob('2026/7/R/30', m, { description: 'strip, inspect, and report' });
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'A', 'stripped, inspected', 3)`, j, today);
  const row = daily.build('job_summary', {}).rows.find((r) => r.machine === 'TT-07');
  assert.strictEqual(row.cards, 1);
  assert.strictEqual(row.job_description, 'strip, inspect, and report');
  assert.strictEqual(row.completed_repairs, 'stripped, inspected');
});

test('every machine on the summery appears exactly once', () => {
  const seen = new Set();
  for (const r of daily.build('job_summary', {}).rows) {
    assert.ok(!seen.has(r.machine), `${r.machine} listed twice`);
    seen.add(r.machine);
  }
});

// ---- Pending Price --------------------------------------------------------

test('a request delivered on two days is numbered once, and the header agrees', () => {
  const asset = aliases.findOrCreateAsset('TT-05', {}).id;
  const m = mkMrn('900007', asset, '2026-05-01', 'head_office');
  const l1 = mkLine(m, 'Hose', 1);
  const l2 = mkLine(m, 'Clamp', 1);
  // The second half turns up a week later, so an order by delivery date alone splits them.
  run(`INSERT INTO grn (mrn_id, mrn_line_id, qty, delivery_date, purchase_source_norm) VALUES (?, ?, 1, '2026-05-02', 'head_office')`, m, l1);
  run(`INSERT INTO grn (mrn_id, mrn_line_id, qty, delivery_date, purchase_source_norm) VALUES (?, ?, 1, '2026-05-09', 'head_office')`, m, l2);
  // Something else lands in between, which is what used to break the run.
  const other = mkMrn('900008', asset, '2026-05-01', 'head_office');
  const l3 = mkLine(other, 'Bolt', 1);
  run(`INSERT INTO grn (mrn_id, mrn_line_id, qty, delivery_date, purchase_source_norm) VALUES (?, ?, 1, '2026-05-05', 'head_office')`, other, l3);

  const d = daily.build('pending_price', {});
  for (const sec of d.sections) {
    assert.strictEqual(sec.rows.filter((r) => r.no !== '').length, sec.requests,
      'the header counts what the NO column numbers');
    const numbered = sec.rows.filter((r) => r.mrn_no !== '').map((r) => r.mrn_no);
    assert.strictEqual(new Set(numbered).size, numbered.length, 'no request is numbered twice');
  }
});
