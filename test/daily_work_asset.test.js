'use strict';

// Which machine a daily-work line was on, RECORDED rather than inferred.
//
// The line never carried a vehicle. It was implied by the job card, and for work booked to the
// GENERAL-WS catch-all it was implied by nothing at all — written into the description if the
// mechanic happened to type it ("AC-06 — Compressor clean and repair").
//
// Reading it back out of that prose was built and measured on the real book: over the 2,535 rows
// whose job card already names a vehicle it answered 86 times and was RIGHT 7, because 223 registry
// rows are cost centres whose code has no digit — so "Service bay door fixing" confidently became
// the asset "Service", while the row the feature was designed around resolved to nothing. This
// column is what replaced that.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-dw-asset-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'workshop', 'storekeeper', 'manager']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'eng', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'workshop', 'storekeeper', 'manager']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
run(`INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Seethananda', 400, '2020-01-01')`);

const aliases = require('../src/lib/aliases');
const AC06 = aliases.findOrCreateAsset('AC-06').id;
const DT03 = aliases.findOrCreateAsset('DT-03').id;

const CATCH = run(`INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at, is_historical, synthesized_no, legacy_ref)
   VALUES ('GENERAL-WS', 'repair', 'General workshop', 'REQUESTED', 'system', date('now'), 0, 1, 'general-workshop')`).lastInsertRowid;
const JOB = run(`INSERT INTO job_cards (job_no, type, description, status, asset_id, requested_by, requested_at)
   VALUES ('2026/8/R/902', 'repair', 'AC-06 compressor', 'IN_PROGRESS', ?, 'eng', '2026-08-03')`, AC06).lastInsertRowid;

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

// ---- captured when the work is written down -------------------------------

test('a line written on a vehicle card records that vehicle', async () => {
  const r = await api(`/jobs/${JOB}/daily-work`, { method: 'POST',
    body: { work_date: '2026-08-04', mechanic: 'Seethananda', description: 'Compressor clean', hours: 4 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', r.body[0].id).asset_id, AC06,
    'the card names the machine, so the line should not have to be asked');
});

test('a line written on the catch-all can still name its machine', async () => {
  // The case that matters. GENERAL-WS has no vehicle of its own, and it is where every unassigned
  // line is written — which is exactly how 159 rows ended up with the machine only in their prose.
  const r = await api(`/jobs/${CATCH}/daily-work`, { method: 'POST',
    body: { work_date: '2026-08-04', mechanic: 'Seethananda', description: 'Compressor clean', hours: 2, asset_id: DT03 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', r.body[0].id).asset_id, DT03);
});

test('a line on the catch-all with no machine given stays unknown, not invented', async () => {
  const r = await api(`/jobs/${CATCH}/daily-work`, { method: 'POST',
    body: { work_date: '2026-08-04', mechanic: 'Seethananda', description: 'Service bay door fixing', hours: 1 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', r.body[0].id).asset_id, null,
    'the old guesser read "Service" here as the cost-centre asset of that name');
});

// ---- naming one that was never recorded -----------------------------------

test('an unknown line can be told which machine it was, and cleared again', async () => {
  const line = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
     VALUES (?, '2026-08-05', 'Seethananda', 'AC-06 — Compressor clean and repair', 3, 0, 0)`, CATCH).lastInsertRowid;
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', line).asset_id, null);

  assert.strictEqual((await api('/daily-work/' + line, { method: 'PATCH', body: { asset_id: AC06 } })).status, 200);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', line).asset_id, AC06);

  // Blank means "still unknown", which is honest. It must not be read as 0 or leave the old value.
  assert.strictEqual((await api('/daily-work/' + line, { method: 'PATCH', body: { asset_id: null } })).status, 200);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', line).asset_id, null);
});

test('a vehicle that does not exist is refused', async () => {
  const line = get('SELECT id FROM job_daily_work ORDER BY id DESC LIMIT 1').id;
  const r = await api('/daily-work/' + line, { method: 'PATCH', body: { asset_id: 999999 } });
  assert.strictEqual(r.status, 400, 'a bad id must not be written as a dangling reference');
});

// ---- what the picker does with it -----------------------------------------

test('the pool reports the recorded vehicle, and nothing for the unknown ones', async () => {
  const pool = await api('/jobs/unassigned/daily-work?limit=200');
  const known = pool.body.find((r) => r.asset_id === DT03);
  assert.ok(known, 'the line written against DT-03 should come back with it');
  assert.strictEqual(known.asset_code, 'DT-03');

  const unknown = pool.body.find((r) => String(r.description).includes('Service bay door'));
  assert.strictEqual(unknown.asset_id, null);
  assert.strictEqual(unknown.asset_code, null, 'unknown must read as unknown, not as the asset "Service"');
});

test('searching by vehicle matches the recorded machine, punctuation or not', async () => {
  for (const q of ['DT-03', 'dt03', 'DT 03']) {
    const r = await api('/jobs/unassigned/daily-work?q=' + encodeURIComponent(q));
    assert.ok(r.body.some((x) => x.asset_id === DT03), `"${q}" should find the DT-03 line`);
    assert.ok(!r.body.some((x) => String(x.description).includes('Service bay door')),
      `"${q}" must not drag in work on other machines`);
  }
});

test('the search still finds a machine named only in the work text', async () => {
  // Ten years of lines were written that way and will never all be labelled by hand.
  const r = await api('/jobs/unassigned/daily-work?q=AC06');
  assert.ok(r.body.some((x) => String(x.description).includes('AC-06')));
});

test('this job’s own machine is offered first, and the limit cannot hide it', async () => {
  // Ordered in SQL, so a pool larger than the limit still surfaces the rows the sort was for.
  for (let i = 0; i < 5; i++) {
    run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
         VALUES (?, '2026-08-09', 'Seethananda', 'filler', 1, 0, 0, ?)`, CATCH, DT03);
  }
  run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
       VALUES (?, '2026-01-01', 'Seethananda', 'old AC-06 work', 1, 0, 0, ?)`, CATCH, AC06);

  const r = await api(`/jobs/unassigned/daily-work?asset_id=${AC06}&limit=2`);
  assert.strictEqual(r.body.length, 2);
  assert.strictEqual(r.body[0].asset_id, AC06,
    'the oldest AC-06 row must still lead a limited page — sorting after the limit would lose it');
});

// ---- moving between cards --------------------------------------------------

test('attaching an unknown line settles its machine from the card', async () => {
  const line = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
     VALUES (?, '2026-08-06', 'Seethananda', 'unknown machine', 2, 0, 0)`, CATCH).lastInsertRowid;
  assert.strictEqual((await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [line] } })).status, 200);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', line).asset_id, AC06);
});

test('attaching does NOT overwrite a machine the line already names', async () => {
  // A line that says DT-03 being claimed by an AC-06 card is either a mistake or a genuine oddity.
  // Either way it is somebody's record, and overwriting it erases the only sign anything is wrong.
  const line = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
     VALUES (?, '2026-08-07', 'Seethananda', 'tipper work', 2, 0, 0, ?)`, CATCH, DT03).lastInsertRowid;
  assert.strictEqual((await api(`/jobs/${JOB}/daily-work/attach`, { method: 'POST', body: { ids: [line] } })).status, 200);
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', line).asset_id, DT03,
    'the card is AC-06, but the line said DT-03 and that is worth keeping');
});

test('the machine survives being taken back off a card', async () => {
  const line = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
     VALUES (?, '2026-08-08', 'Seethananda', 'compressor', 2, 0, 0, ?)`, JOB, AC06).lastInsertRowid;
  assert.strictEqual((await api(`/jobs/${JOB}/daily-work/${line}`, { method: 'DELETE' })).status, 200);
  const row = get('SELECT job_id, asset_id FROM job_daily_work WHERE id = ?', line);
  assert.strictEqual(row.job_id, CATCH);
  assert.strictEqual(row.asset_id, AC06,
    'it goes back to the pool still knowing its machine — otherwise every unlink loses what was recorded');
});

// ---- the backfill ----------------------------------------------------------

test('rows written before the column existed take their machine from their card', () => {
  // migrate() fills NULLs from job_cards.asset_id on every boot, so it is also self-healing.
  const legacy = run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value)
     VALUES (?, '2025-05-05', 'Seethananda', 'written before the column', 3, 0, 0)`, JOB).lastInsertRowid;
  run('UPDATE job_daily_work SET asset_id = NULL WHERE id = ?', legacy);
  migrate();
  assert.strictEqual(get('SELECT asset_id FROM job_daily_work WHERE id = ?', legacy).asset_id, AC06);
});

test('the backfill leaves catch-all rows alone, because their card names no machine', () => {
  const onCatch = all(`SELECT d.asset_id FROM job_daily_work d
     JOIN job_cards j ON j.id = d.job_id
    WHERE j.legacy_ref = 'general-workshop' AND d.description = 'Service bay door fixing'`);
  assert.ok(onCatch.length > 0);
  for (const r of onCatch) {
    assert.strictEqual(r.asset_id, null, 'there is nothing to backfill from, and a guess is not a substitute');
  }
});
