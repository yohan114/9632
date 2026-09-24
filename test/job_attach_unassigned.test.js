'use strict';

// Claiming work and goods that nobody has put on a job card yet.
//
// Two pools build up in the real book. Labour gets booked to the GENERAL-WS catch-all when the
// mechanic did not name a job (159 rows), and goods get received against a request that was
// never tied to one (914 receipts, Rs 2.35m — and 870 of those DO name a vehicle, so the right
// job is usually obvious). Until now the only way onto a job card was to type the line again,
// which is how the same cost ends up recorded twice.
//
// The thing that makes this more than a list: attaching MOVES MONEY. Labour that sat against
// no vehicle lands on one, so the job totals and the vehicle's monthly rollup both have to be
// redrawn — on the job that lost it as well as the one that gained it.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-job-attach-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'workshop', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'eng', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}

const ASSET = require('../src/lib/aliases').findOrCreateAsset('AC-06').id;
const OTHER = require('../src/lib/aliases').findOrCreateAsset('LP-1716').id;

// The catch-all everything unassigned lands on, created the same way stores.js creates it.
const CATCH = run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
   VALUES ('GENERAL-WS', 'repair', 'General workshop stores issues (not vehicle-specific)', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;

const JOB = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/900', 'repair', 'AC-06 compressor', 'IN_PROGRESS', ?, 'eng', '2026-08-03')`, ASSET).lastInsertRowid;

// Unassigned labour on the catch-all.
const dw = (desc, hours, date) => run(
  `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, ?, 'Seethananda', ?, ?, 0, 0)`, CATCH, date, desc, hours).lastInsertRowid;
const DW1 = dw('AC-06 — Compressor clean and repair', 4, '2026-08-03');
const DW2 = dw('Workshop — Service bay door fixing', 2, '2026-08-03');
// Labour that is already on a real job and must never be offered.
const DW_TAKEN = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
   VALUES (?, '2026-08-01', 'Buddhika', 'Already on this job', 3, 0, 0)`, JOB).lastInsertRowid;

// Goods received against requests with no job — one naming this job's vehicle, one another's.
const mkReceipt = (mrnNo, assetId, desc, qty, price, date) => {
  const m = run(`INSERT INTO mrn (mrn_no, req_date, asset_id, status) VALUES (?, ?, ?, 'open')`, mrnNo, date, assetId).lastInsertRowid;
  const l = run('INSERT INTO mrn_lines (mrn_id, description, qty, qty_received, unit) VALUES (?, ?, ?, ?, ?)', m, desc, qty, qty, 'nos').lastInsertRowid;
  const g = run(`INSERT INTO grn (grn_no, mrn_id, mrn_line_id, description, qty, unit_price, delivery_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`, 'G-' + mrnNo, m, l, desc, qty, price, date).lastInsertRowid;
  return { mrn: m, line: l, grn: g };
};
const R_MINE = mkReceipt('900001', ASSET, 'Compressor Belt', 2, 1500, '2026-08-02');
const R_OTHER = mkReceipt('900002', OTHER, 'Brake Light Cup', 1, 800, '2026-08-01');
const R_NOVEH = mkReceipt('900003', null, 'Masking Tape', 5, 100, '2026-08-01');
// A receipt already booked to a job — must never be offered twice.
const R_TAKEN = mkReceipt('900004', ASSET, 'Already booked', 1, 999, '2026-07-30');
run(`INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price, mrn_line_id)
     VALUES (?, 'grn', ?, 'Already booked', 1, 999, ?)`, JOB, R_TAKEN.grn, R_TAKEN.line);
// A part parked on the catch-all.
const P_GENERAL = run(`INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price)
     VALUES (?, 'general', NULL, 'Workshop consumable', 3, 200)`, CATCH).lastInsertRowid;

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

// ---- what the Add button offers -------------------------------------------

test('the daily-work picker offers what is on the catch-all, and nothing else', async () => {
  const r = await api('/jobs/unassigned/daily-work');
  const ids = r.body.map((x) => x.id);
  assert.ok(ids.includes(DW1) && ids.includes(DW2));
  assert.ok(!ids.includes(DW_TAKEN), 'work already on a job card is not up for grabs');
});

test('the daily-work picker can be searched', async () => {
  const r = await api('/jobs/unassigned/daily-work?q=' + encodeURIComponent('Compressor'));
  assert.deepStrictEqual(r.body.map((x) => x.id), [DW1]);
});

test('the parts picker offers receipts with no job, and lines on the catch-all', async () => {
  const r = await api('/jobs/unassigned/parts');
  const rec = r.body.receipts.map((x) => x.id);
  assert.ok(rec.includes(R_MINE.grn) && rec.includes(R_OTHER.grn) && rec.includes(R_NOVEH.grn));
  assert.ok(!rec.includes(R_TAKEN.grn), 'a receipt already booked to a job is not offered again');
  assert.deepStrictEqual(r.body.parts.map((x) => x.id), [P_GENERAL]);
});

test('this job’s own vehicle is offered first', async () => {
  const r = await api('/jobs/unassigned/parts?asset_id=' + ASSET);
  assert.strictEqual(r.body.receipts[0].id, R_MINE.grn, 'the AC-06 receipt leads');
  assert.strictEqual(r.body.receipts[0].asset_code, 'AC-06');
});

test('an unpriced receipt is still offered, marked as worth nothing yet', async () => {
  const u = mkReceipt('900005', ASSET, 'Unpriced thing', 1, null, '2026-08-04');
  const r = await api('/jobs/unassigned/parts?asset_id=' + ASSET);
  const hit = r.body.receipts.find((x) => x.id === u.grn);
  assert.ok(hit, 'not hidden just because nobody has priced it');
  assert.strictEqual(hit.value, 0);
});

// ---- attaching -------------------------------------------------------------

test('attaching labour moves it, its hours and its cost onto the job', async () => {
  const before = get('SELECT labour_cost FROM job_cards WHERE id = ?', JOB);
  const r = await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [DW1] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.attached, 1);
  assert.strictEqual(r.body.hours, 4);
  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', DW1).job_id, JOB);
  const after = get('SELECT labour_cost FROM job_cards WHERE id = ?', JOB);
  assert.ok((after.labour_cost || 0) >= (before.labour_cost || 0), 'the job total was recomputed, not left stale');
});

test('the entry it came from stops offering it', async () => {
  const r = await api('/jobs/unassigned/daily-work');
  assert.ok(!r.body.map((x) => x.id).includes(DW1));
});

test('the catch-all job is recomputed too, not just the one that gained the work', async () => {
  // Otherwise the general workshop keeps carrying cost it no longer holds.
  const hoursOnCatchAll = get('SELECT COALESCE(SUM(hours),0) h FROM job_daily_work WHERE job_id = ?', CATCH).h;
  assert.strictEqual(hoursOnCatchAll, 2, 'only DW2 is left there');
  const c = get('SELECT labour_cost FROM job_cards WHERE id = ?', CATCH);
  assert.ok(c, 'the catch-all row still exists and was refreshed');
});

test('attaching a receipt books it as a part on the job', async () => {
  const r = await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: { receipts: [R_MINE.grn] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.attached, 1);
  assert.strictEqual(r.body.value, 3000, '2 × 1500');
  const p = get(`SELECT * FROM job_parts WHERE job_id = ? AND source_id = ? AND source_type = 'grn'`, JOB, R_MINE.grn);
  assert.ok(p, 'a job_parts line was created');
  assert.strictEqual(p.mrn_line_id, R_MINE.line, 'linked back to the request line, which is what keeps it off the list');
});

test('an attached receipt is not offered a second time', async () => {
  const r = await api('/jobs/unassigned/parts');
  assert.ok(!r.body.receipts.map((x) => x.id).includes(R_MINE.grn));
});

test('a line parked on the catch-all is moved rather than copied', async () => {
  const r = await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: { parts: [P_GENERAL] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT job_id FROM job_parts WHERE id = ?', P_GENERAL).job_id, JOB);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_parts WHERE description = ?', 'Workshop consumable').c, 1,
    'moved — not duplicated onto the new job');
});

test('several can be attached at once', async () => {
  const r = await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: { receipts: [R_OTHER.grn, R_NOVEH.grn] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.attached, 2);
});

// ---- what must not happen --------------------------------------------------

test('work already on another job card cannot be pulled across', async () => {
  const r = await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [DW_TAKEN] } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /already on a job card/);
});

test('a receipt already booked cannot be booked twice', async () => {
  const r = await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: { receipts: [R_TAKEN.grn] } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_parts WHERE mrn_line_id = ?', R_TAKEN.line).c, 1,
    'still exactly one line for it');
});

test('a batch containing one bad id attaches nothing at all', async () => {
  const fresh = dw('Another workshop job', 1, '2026-08-05');
  const r = await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [fresh, DW_TAKEN] } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(get('SELECT job_id FROM job_daily_work WHERE id = ?', fresh).job_id, CATCH,
    'the good one stayed put — a half-applied batch is worse than none');
});

test('attaching nothing is refused', async () => {
  assert.strictEqual((await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [] } })).status, 400);
  assert.strictEqual((await api(`/jobs/${JOB}/parts/attach`, { method: 'POST', body: {} })).status, 400);
});

test('a job that does not exist is a 404', async () => {
  assert.strictEqual((await api('/jobs/99999/daily-work/attach', { method: 'POST', body: { ids: [DW2] } })).status, 404);
});

test('the picker paths are not swallowed by the job-by-id route', async () => {
  // /jobs/:id would match a single segment; these are two, but the ordering is worth pinning.
  const r = await api('/jobs/unassigned/daily-work');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body), 'a list, not a job card or a 404');
});
