'use strict';

// Phase D — one open job card per vehicle. Enforced where a card is born (raised
// directly, or created when a job request is approved) and when a closed card is
// reopened. Vehicles that already carry several open cards are grandfathered: they
// keep them, cannot gain another, and are listed for clean-up.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-one-open-job-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');
const jobstate = require('../src/lib/jobstate');

migrate();
require('../src/migrate/015_phase4_erp_gaps').runStep();

const ROLES = ['admin', 'transport_manager', 'assistant_transport_manager', 'operational_manager', 'workshop', 'storekeeper'];
for (const n of ROLES) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'boss', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ROLES) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);

run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 425, '2020-01-01')");

const busy = aliases.findOrCreateAsset('28-4314', {}).id;   // will hold one open card
const free = aliases.findOrCreateAsset('LO-5981', {}).id;   // nothing open
const legacy = aliases.findOrCreateAsset('BD-02', {}).id;   // two open cards already (grandfathered)
run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at) VALUES ('2026/7/R/1', ?, 'repair', 'gearbox', 'IN_PROGRESS', '2026-07-01')`, busy);
run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at) VALUES ('2026/5/R/2', ?, 'repair', 'old one', 'IN_WORKSHOP', '2026-05-02')`, legacy);
run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at) VALUES ('2026/6/R/3', ?, 'repair', 'newer one', 'REQUESTED', '2026-06-03')`, legacy);
// A container card with no vehicle — must never be counted or blocked.
run(`INSERT INTO job_cards (job_no, type, description, status, legacy_ref) VALUES ('GENERAL-WS', 'repair', 'general', 'REQUESTED', 'general-workshop')`);

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await req('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'pw' } })).status, 200);
});
test.after(() => server && server.close());

async function req(path_, opts = {}) {
  const res = await fetch(base + path_, {
    method: opts.method || 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const raise = (assetId, extra = {}) => req('/api/jobs', { method: 'POST', body: { asset_id: assetId, description: 'new fault', ...extra } });

test('a vehicle with an open card cannot get another', async () => {
  const r = await raise(busy);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.blocking_job.job_no, '2026/7/R/1');
  assert.match(r.body.error, /already has an open job card/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_cards WHERE asset_id = ?', busy).c, 1, 'nothing was created');
});

test('a free vehicle can, and then cannot again', async () => {
  const first = await raise(free);
  assert.strictEqual(first.status, 201);
  const second = await raise(free);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.blocking_job.id, first.body.job.id);
});

test('closing the card frees the vehicle for the next one', async () => {
  const open = get('SELECT id FROM job_cards WHERE asset_id = ? AND status NOT IN (?, ?)', free, 'CLOSED', 'REJECTED');
  run("UPDATE job_cards SET status = 'CLOSED', closed_at = datetime('now') WHERE id = ?", open.id);
  const r = await raise(free);
  assert.strictEqual(r.status, 201, 'a closed card no longer blocks');
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", r.body.job.id); // tidy up for later tests
});

test('a rejected card does not block either', async () => {
  const v = aliases.findOrCreateAsset('CR-02', {}).id;
  const r1 = await raise(v);
  run("UPDATE job_cards SET status = 'REJECTED' WHERE id = ?", r1.body.job.id);
  assert.strictEqual((await raise(v)).status, 201);
});

test('cards with no vehicle are exempt', () => {
  assert.strictEqual(jobstate.openJobFor(null), null);
  assert.strictEqual(jobstate.checkOneOpenJob(null).ok, true);
});

test('reopening a closed card is blocked while another is open', async () => {
  const v = aliases.findOrCreateAsset('SL-03', {}).id;
  const oldJob = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status) VALUES ('2026/1/R/7', ?, 'repair', 'old', 'CLOSED')`, v).lastInsertRowid;
  const current = await raise(v);
  assert.strictEqual(current.status, 201, 'a closed card does not block a new one');

  const reopen = await req(`/api/jobs/${oldJob}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS', reason: 'fault returned' } });
  assert.strictEqual(reopen.status, 409);
  assert.match(reopen.body.error, /Cannot reopen/);
  assert.strictEqual(get('SELECT status FROM job_cards WHERE id = ?', oldJob).status, 'CLOSED');

  // Close the live one and the old card can be reopened.
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", current.body.job.id);
  const noReason = await req(`/api/jobs/${oldJob}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS' } });
  assert.strictEqual(noReason.status, 400, 'a reopen must say why — it rewrites cost history');
  assert.strictEqual(get('SELECT status FROM job_cards WHERE id = ?', oldJob).status, 'CLOSED');

  const ok = await req(`/api/jobs/${oldJob}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS', reason: 'fault returned' } });
  assert.strictEqual(ok.status, 200);
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", oldJob);
});

test('reopening keeps the card in its original cost-report month', async () => {
  const v = aliases.findOrCreateAsset('SL-09', {}).id;
  const job = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, completed_at, closed_at)
                   VALUES ('2026/2/R/9', ?, 'repair', 'reopen month test', 'CLOSED', '2026-02-14', '2026-02-14')`, v).lastInsertRowid;

  const open = await req(`/api/jobs/${job}/transition`, { method: 'POST', body: { to: 'IN_PROGRESS', reason: 'same fault came back' } });
  assert.strictEqual(open.status, 200);
  const reopened = get('SELECT * FROM job_cards WHERE id = ?', job);
  assert.strictEqual(reopened.completed_at, null, 'close dates are cleared so status and dates agree');
  assert.strictEqual(reopened.closed_at, null);
  assert.strictEqual(reopened.original_completed_at, '2026-02-14', 'the original close month is anchored');
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_reopens WHERE job_id = ?', job).c, 1, 'the reopen is recorded');

  await req(`/api/jobs/${job}/transition`, { method: 'POST', body: { to: 'WORK_COMPLETE' } });
  const closed = await req(`/api/jobs/${job}/transition`, { method: 'POST', body: { to: 'CLOSED' } });
  assert.strictEqual(closed.status, 200);
  assert.strictEqual(get('SELECT completed_at FROM job_cards WHERE id = ?', job).completed_at, '2026-02-14',
    're-closing must not move the job out of the month already reported to the owner');
});

test('approving a job request is blocked while the vehicle has an open card', async () => {
  const jr = await req('/api/job-requests', { method: 'POST', body: { asset_id: busy, description: 'another fault' } });
  assert.strictEqual(jr.status, 201, 'raising a request is never blocked');
  assert.ok(jr.body.open_job, 'but it warns that a card is already open');
  assert.strictEqual(jr.body.open_job.job_no, '2026/7/R/1');

  await req(`/api/job-requests/${jr.body.request.id}/certify`, { method: 'POST', body: {} });
  const approve = await req(`/api/job-requests/${jr.body.request.id}/approve`, { method: 'POST', body: {} });
  assert.strictEqual(approve.status, 409);
  assert.strictEqual(approve.body.blocking_job.job_no, '2026/7/R/1');
  // Nothing was written: the request is still certified and has no job card.
  const after = get('SELECT approval_status, job_id FROM job_requests WHERE id = ?', jr.body.request.id);
  assert.strictEqual(after.approval_status, 'certified');
  assert.strictEqual(after.job_id, null);

  // Close the blocker and the same approval goes through.
  run("UPDATE job_cards SET status = 'CLOSED' WHERE job_no = '2026/7/R/1'");
  const ok = await req(`/api/job-requests/${jr.body.request.id}/approve`, { method: 'POST', body: {} });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.job.job_no);
});

test('vehicles that already had several open cards keep them, but gain no more', async () => {
  const d = await req('/api/jobs/duplicates');
  assert.strictEqual(d.status, 200);
  const row = d.body.vehicles.find((v) => v.asset_id === legacy);
  assert.strictEqual(row.open_count, 2, 'both pre-existing cards are still open');
  assert.deepStrictEqual(row.jobs.map((j) => j.job_no), ['2026/5/R/2', '2026/6/R/3']);
  assert.ok(row.jobs[0].age_days >= 0);

  assert.strictEqual((await raise(legacy)).status, 409, 'no third card');
});

test('the open-for probe answers before the form is filled in', async () => {
  const blocked = await req('/api/jobs/open-for/' + legacy);
  assert.strictEqual(blocked.body.blocked, true);
  assert.strictEqual(blocked.body.blocking_job.job_no, '2026/5/R/2');
  const spare = aliases.findOrCreateAsset('TM-09', {}).id;
  assert.strictEqual((await req('/api/jobs/open-for/' + spare)).body.blocked, false);
});

test('the dashboard counts the vehicles still in conflict', async () => {
  const d = await req('/api/reports/dashboard');
  assert.strictEqual(d.body.needs_attention.vehicle_conflicts, jobstate.duplicateOpenJobs().length);
  assert.ok(d.body.needs_attention.vehicle_conflicts >= 1);
});

// ---------------------------------------------------------------------------
// Editing the card itself: vehicle, description, type.
// ---------------------------------------------------------------------------
const costing = require('../src/lib/costing');

test('editing the description leaves the vehicle and costs alone', async () => {
  const v = aliases.findOrCreateAsset('ED-01', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
                 VALUES ('2026/3/R/50', ?, 'repair', 'first text', 'IN_PROGRESS')`, v).lastInsertRowid;
  const r = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { description: 'corrected text' } });
  assert.strictEqual(r.status, 200);
  const after = get('SELECT description, asset_id, type FROM job_cards WHERE id = ?', j);
  assert.strictEqual(after.description, 'corrected text');
  assert.strictEqual(after.asset_id, v, 'the vehicle must not move');
  assert.strictEqual(after.type, 'repair');

  const blank = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { description: '   ' } });
  assert.strictEqual(blank.status, 400, 'a card must keep a description');
});

test('moving a job to another vehicle carries its cost with it', async () => {
  const from = aliases.findOrCreateAsset('ED-FROM', {}).id;
  const to = aliases.findOrCreateAsset('ED-TO', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
                 VALUES ('2026/3/R/51', ?, 'repair', 'wrong vehicle', 'IN_PROGRESS')`, from).lastInsertRowid;
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '2026-03-04', 'Anura', 4)", j);
  costing.refreshJobTotals(j);

  const bucket = (a) => get('SELECT labour_cost, total_cost FROM vehicle_monthly_costs WHERE asset_id = ? AND year = 2026 AND month = 3', a);
  assert.strictEqual(bucket(from).labour_cost, 4 * 425, 'the cost starts on the wrong vehicle');

  const r = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { asset_id: to } });
  assert.strictEqual(r.status, 200);

  assert.strictEqual(bucket(from).labour_cost, 0, 'the vehicle it left gives the cost up');
  assert.strictEqual(bucket(to).labour_cost, 4 * 425, 'and the vehicle it moved to takes it on');
  for (const a of [from, to]) {
    const b = bucket(a);
    const parts = ['fuel_cost', 'oil_cost', 'filter_cost', 'battery_cost', 'parts_cost', 'labour_cost'].reduce((s, c) => s + (b[c] || 0), 0);
    assert.strictEqual(Math.round(b.total_cost * 100) / 100, Math.round(parts * 100) / 100, 'total stays Σ(components)');
  }
});

test('a job cannot move onto a vehicle that already has an open card', async () => {
  const busy = aliases.findOrCreateAsset('ED-BUSY', {}).id;
  run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
       VALUES ('2026/3/R/52', ?, 'repair', 'already here', 'IN_PROGRESS')`, busy);
  const other = aliases.findOrCreateAsset('ED-OTHER', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
                 VALUES ('2026/3/R/53', ?, 'repair', 'mover', 'IN_PROGRESS')`, other).lastInsertRowid;

  const r = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { asset_id: busy } });
  assert.strictEqual(r.status, 409);
  assert.ok(r.body.blocking_job, 'it names the card in the way');
  assert.strictEqual(get('SELECT asset_id FROM job_cards WHERE id = ?', j).asset_id, other, 'and nothing moved');
});

test('switching to a service job warns before the hours stop counting', async () => {
  const v = aliases.findOrCreateAsset('ED-SVC', {}).id;
  const j = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status)
                 VALUES ('2026/3/R/54', ?, 'repair', 'reclassify me', 'IN_PROGRESS')`, v).lastInsertRowid;
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, '2026-03-04', 'Anura', 4)", j);
  costing.refreshJobTotals(j);

  const blocked = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { type: 'service' } });
  assert.strictEqual(blocked.status, 409, 'it does not silently drop the labour');
  assert.strictEqual(blocked.body.labour_at_risk, 4 * 425, 'and says exactly how much is at stake');
  assert.strictEqual(get('SELECT type FROM job_cards WHERE id = ?', j).type, 'repair');

  const ok = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { type: 'service', confirm_type_change: true } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(get('SELECT type FROM job_cards WHERE id = ?', j).type, 'service');
  assert.ok(ok.body.warnings.some((w) => /no longer counts/.test(w)));

  const bad = await req(`/api/jobs/${j}`, { method: 'PATCH', body: { type: 'banana' } });
  assert.strictEqual(bad.status, 400);
});

// Daily work must not be swallowed by a card that has nothing to do with the day. The live
// matcher used to take the vehicle's newest OPEN card with no upper date bound, so one
// REQUESTED card ended up holding nine months of work and a 2026 work day could attach to a
// 2023 card just because it was the vehicle's only other one.
test('a day\'s work only attaches to a card that is near it in time', async () => {
  const v = aliases.findOrCreateAsset('DW-MATCH', {}).id;
  // An old closed card, and an open one that started recently.
  run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, completed_at, closed_at)
       VALUES ('2023/9/R/1', ?, 'repair', 'ancient', 'CLOSED', '2023-09-01', '2023-09-18', '2023-09-18')`, v);
  const open = run(`INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at)
       VALUES ('2026/6/R/90', ?, 'repair', 'current', 'IN_PROGRESS', '2026-06-01')`, v).lastInsertRowid;

  // Work during the open card's life -> that card.
  const near = await req('/api/daily-work', { method: 'POST', body: { asset_id: v, work_date: '2026-06-15', mechanic: 'Anura', hours: 4, description: 'in window' } });
  assert.strictEqual(near.status, 201);
  assert.strictEqual(get("SELECT job_id FROM job_daily_work WHERE description = 'in window'").job_id, open);

  // Work years away from every card -> a fresh card, NOT the 2023 one.
  const far = await req('/api/daily-work', { method: 'POST', body: { asset_id: v, work_date: '2024-03-05', mechanic: 'Anura', hours: 3, description: 'far away' } });
  assert.strictEqual(far.status, 201);
  const landed = get("SELECT job_id FROM job_daily_work WHERE description = 'far away'").job_id;
  const card = get('SELECT job_no, requested_at FROM job_cards WHERE id = ?', landed);
  assert.notStrictEqual(card.job_no, '2023/9/R/1', 'it must not land on a card 500+ days away');
  assert.strictEqual(String(card.requested_at).slice(0, 10), '2024-03-05', 'a card is raised for that day instead');
});
