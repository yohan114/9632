'use strict';

// Taking work and goods back OFF a job card.
//
// Removing a line used to DELETE it. That threw the work away: a mechanic's hours, or a receipt
// someone had already matched to a line, gone with no way back and nothing in the unassigned pool
// to re-claim. In practice "remove" almost never means "this never happened" — it means "this is
// not THIS job's", which is exactly what the GENERAL-WS catch-all is for. So the row moves there
// and the existing picker can put it on the right card.
//
// It moves money, so the same three recomputes that attaching needs have to run in reverse: the
// job that lost the row, the catch-all that gained it, and the vehicle's month buckets.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-job-unlink-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'workshop', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'eng', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const ASSET = require('../src/lib/aliases').findOrCreateAsset('AC-06').id;

// Labour cost is hours x the mechanic's rate, so without a rate every attach adds nothing and the
// "does the job stop being charged" test can never fail for the right reason.
run(`INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Seethananda', 400, '2020-01-01')`);

const CATCH = run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
   VALUES ('GENERAL-WS', 'repair', 'General workshop stores issues (not vehicle-specific)', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;
const JOB = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/900', 'repair', 'AC-06 compressor', 'IN_PROGRESS', ?, 'eng', '2026-08-03')`, ASSET).lastInsertRowid;

const dw = (jobId, desc, hours) => run(
  `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, '2026-08-03', 'Seethananda', ?, ?, 0, 0)`, jobId, desc, hours).lastInsertRowid;

const DW_POOL = dw(CATCH, 'AC-06 — Compressor clean and repair', 4);
const DW_SHOP = dw(CATCH, 'Workshop — Service bay door fixing', 2);

const mkReceipt = (mrnNo, assetId, desc, qty, price) => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES (?, '2026-08-02', ?, 'open')`, mrnNo, assetId).lastInsertRowid;
  const l = run('INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, ?, ?, ?, ?)', m, desc, qty, qty, 'nos').lastInsertRowid;
  const g = run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                 VALUES (?, ?, ?, ?, ?, ?, '2026-08-02')`, 'G-' + mrnNo, m, l, desc, qty, price).lastInsertRowid;
  return { mrn: m, line: l, grn: g };
};
const R_MINE = mkReceipt('900001', ASSET, 'Compressor Belt', 2, 1500);

const app = require('../src/server');
let server; let base; let cookie;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'eng', password: 'pw' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
});
test.after(() => server && server.close());

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- the round trip --------------------------------------------------------

test('daily work taken off a job goes back to the pool instead of being destroyed', async () => {
  assert.strictEqual((await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [DW_POOL] } })).status, 200);

  const off = await api(`/jobs/${JOB}/daily-work/${DW_POOL}`, { method: 'DELETE' });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.unlinked, true, 'the reply must say where it went, so the screen can too');

  const row = get('SELECT job_id, hours FROM job_daily_work WHERE id = ?', DW_POOL);
  assert.ok(row, 'the entry must still exist — those are four hours of somebody’s work');
  assert.strictEqual(row.job_id, CATCH, 'and be back on the catch-all');
  assert.strictEqual(row.hours, 4, 'with its hours intact');

  const pool = await api('/jobs/unassigned/daily-work?limit=200');
  assert.ok(pool.body.some((r) => r.id === DW_POOL), 'so the picker offers it to the right card next time');
});

test('a part taken off a job comes back as exactly ONE row, not two', async () => {
  // The trap. Deleting a receipt-sourced job_parts row drops the mrn_line_id that marks the receipt
  // as claimed, so the GRN reappears as an unclaimed *receipt* — while the row that held its price
  // and quantity is gone. Moving the row keeps one entry, in one pool, with its figures.
  assert.strictEqual((await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: { receipts: [R_MINE.grn] } })).status, 200);
  const partId = get('SELECT id FROM job_parts WHERE mrn_line_id = ?', R_MINE.line).id;

  assert.strictEqual((await api(`/jobs/${JOB}/parts/${partId}`, { method: 'DELETE' })).status, 200);

  const row = get('SELECT job_id, qty, unit_price FROM job_parts WHERE id = ?', partId);
  assert.ok(row, 'the line must survive');
  assert.strictEqual(row.job_id, CATCH);
  assert.strictEqual(row.qty, 2, 'with its quantity');
  assert.strictEqual(row.unit_price, 1500, 'and its price');

  const pool = await api('/jobs/unassigned/parts?limit=200');
  const asReceipt = pool.body.receipts.filter((r) => r.id === R_MINE.grn).length;
  const asPart = pool.body.parts.filter((p) => p.id === partId).length;
  assert.strictEqual(asReceipt + asPart, 1,
    `offered ${asReceipt}x as a receipt and ${asPart}x as a part — it must appear exactly once`);
});

test('the job stops being charged for what it no longer holds', async () => {
  const cost = () => get('SELECT COALESCE(labour_cost, 0) c FROM job_cards WHERE id = ?', JOB).c;
  const before = cost();
  await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [DW_SHOP] } });
  assert.ok(cost() > before, 'attaching should have given it labour to charge');

  await api(`/jobs/${JOB}/daily-work/${DW_SHOP}`, { method: 'DELETE' });
  assert.strictEqual(cost(), before, 'and removing must take it back off, not leave it carrying the money');
});

test('removing on the catch-all itself really does delete', async () => {
  // Nowhere further to send it, and this is the one place a genuine mistake gets cleaned up.
  // Without it the pool would fill with rubbish nobody could ever remove.
  const junk = dw(CATCH, 'typed by mistake', 1);
  const off = await api(`/jobs/${CATCH}/daily-work/${junk}`, { method: 'DELETE' });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.unlinked, false);
  assert.strictEqual(get('SELECT id FROM job_daily_work WHERE id = ?', junk), undefined);
});

test('an id that is not on this job is refused rather than quietly doing nothing', async () => {
  const off = await api(`/jobs/${JOB}/daily-work/999999`, { method: 'DELETE' });
  assert.strictEqual(off.status, 404, 'it used to answer ok:true having changed nothing, which reads as success');
});

// ---- finding it by vehicle -------------------------------------------------
//
// The ask was "show the vehicle so I can search vehicle-wise". Inferring the machine from the
// description was built, measured against the real book, and thrown away: over the 2,535 rows whose
// job already names a vehicle it fired 86 times and was right 7; on the live 159-row pool its
// commonest labels were "Service", "Workshop" and "Accomadation", because 223 registry rows are
// cost centres with no digit in their code; and "AC-06 — Compressor clean and repair", the row it
// was designed around, resolved to nothing.
//
// So the vehicle is not guessed. It is already in the work text. What was missing was the search.

test('searching by vehicle finds the work, however the code is punctuated', async () => {
  // An unrelated line that has never been near the AC-06 card, so it must never match. (Not
  // DW_SHOP — that one was attached to the AC-06 card earlier in this file, which RECORDED AC-06
  // on it, so it now matches for a perfectly good reason.)
  const other = dw(CATCH, 'Grader blade replaced', 1);
  for (const q of ['AC-06', 'ac-06', 'AC06', 'ac 06']) {
    const r = await api('/jobs/unassigned/daily-work?q=' + encodeURIComponent(q));
    assert.ok(r.body.some((x) => x.id === DW_POOL),
      `"${q}" should find "AC-06 — Compressor clean and repair" — nobody types a code the same way twice`);
    assert.ok(!r.body.some((x) => x.id === other),
      `"${q}" must not drag in work on other machines`);
  }
});

test('the description and mechanic searches still work', async () => {
  const byDesc = await api('/jobs/unassigned/daily-work?q=' + encodeURIComponent('door fixing'));
  assert.ok(byDesc.body.some((r) => String(r.description).includes('door fixing')));
  const byMech = await api('/jobs/unassigned/daily-work?q=Seethananda');
  assert.ok(byMech.body.length > 0, 'searching by mechanic was there before and must keep working');
});

test('no vehicle is invented for work that names none', async () => {
  // The failure the measurement caught: "Workshop — Service bay door fixing" was being labelled
  // with the registry's "Workshop" cost-centre row and badged as belonging to whichever card was
  // open, which would float unrelated hours to the top for someone to attach.
  //
  // A vehicle IS reported now — but only a recorded one (job_daily_work.asset_id). This row has
  // never been on a vehicle card and nobody has named it, so it must come back as unknown.
  const fresh = dw(CATCH, 'Workshop — Service bay door fixing', 1);
  const pool = await api('/jobs/unassigned/daily-work?limit=200');
  const row = pool.body.find((r) => r.id === fresh);
  assert.ok(row, 'the new line should be in the pool');
  assert.strictEqual(row.asset_id, null, 'the old guesser read "Service" here as a cost-centre asset');
  assert.strictEqual(row.asset_code, null);
});

test('a vehicle that WAS recorded is reported', async () => {
  // DW_POOL was attached to the AC-06 card and taken off again, which settles its machine — so the
  // pool can now say what it was, which is the whole point of the column.
  const pool = await api('/jobs/unassigned/daily-work?limit=200');
  const row = pool.body.find((r) => r.id === DW_POOL);
  assert.strictEqual(row.asset_code, 'AC-06');
});

test('a search matching nothing returns nothing, rather than everything', async () => {
  const r = await api('/jobs/unassigned/daily-work?q=' + encodeURIComponent('zzz-no-such-thing'));
  assert.strictEqual(r.body.length, 0);
});

test('listing the pool teaches the alias resolver nothing', async () => {
  // Worth keeping even now the guesser is gone: aliases.resolveAsset() writes an alias row and
  // bumps a hit count on every call, so reaching for it here would mean that merely OPENING the
  // picker rewrites the table that decides how future text resolves.
  const before = get('SELECT COUNT(*) c, COALESCE(SUM(hit_count), 0) h FROM asset_aliases');
  await api('/jobs/unassigned/daily-work?limit=200');
  await api('/jobs/unassigned/daily-work?q=AC-06');
  const after = get('SELECT COUNT(*) c, COALESCE(SUM(hit_count), 0) h FROM asset_aliases');
  assert.deepStrictEqual(after, before, 'the alias table must be untouched by a GET');
});
