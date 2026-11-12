'use strict';

// Isolated DB + real HTTP server for an end-to-end API check.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-http-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const auth = require('../src/lib/auth');
const aliases = require('../src/lib/aliases');

migrate();

// minimal fixture: roles, an admin+workshop user, an asset, a labour rate
for (const [n] of [['admin'], ['transport_manager'], ['operational_manager'], ['workshop']]) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'boss', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'transport_manager', 'operational_manager', 'workshop']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)', 'Anura', 400, '2020-01-01');
run('INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES (?, ?, ?)', 'Buddhika', 300, '2020-01-01');
aliases.findOrCreateAsset('28-4314', {});

const app = require('../src/server');
let server;
let base;
let cookie;

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
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

test('health is public', async () => {
  const r = await req('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
});

test('bad login is rejected, good login sets a session', async () => {
  assert.strictEqual((await req('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'nope' } })).status, 401);
  const r = await req('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'pw' } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.roles.includes('admin'));
});

const { openJobCard, jobCard } = require('./helpers/open_job');
const post = (path_, body) => req(path_, { method: 'POST', body });

test('full job lifecycle + closure gate over HTTP', async () => {
  // A card is opened against a job request that has all three signatures, so it starts at
  // APPROVED_OPERATIONS: both approval gates were passed on the request.
  const create = await openJobCard(post, { asset: '28-4314', type: 'repair', description: 'brake job' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const id = create.body.job.id;
  assert.strictEqual(create.body.job.status, 'APPROVED_OPERATIONS');

  // walk the workshop's own steps from there (boss holds every role)
  for (const to of ['IN_WORKSHOP', 'IN_PROGRESS']) {
    const r = await req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to } });
    assert.strictEqual(r.status, 200, `transition to ${to}`);
    assert.strictEqual(r.body.status, to);
  }

  // add an UNPRICED part, mark complete, try to close -> 409
  await req(`/api/jobs/${id}/parts`, { method: 'POST', body: { source_type: 'grn', description: 'pad', qty: 1 } });
  await req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'WORK_COMPLETE' } });
  const blocked = await req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'CLOSED' } });
  assert.strictEqual(blocked.status, 409);
  assert.ok(Array.isArray(blocked.body.missing) && blocked.body.missing.length >= 1);

  // price it, close -> 200, snapshot exists
  const partId = (await req(`/api/jobs/${id}`)).body.parts[0].id;
  await req(`/api/jobs/${id}/parts/${partId}`, { method: 'PATCH', body: { unit_price: 1500 } });
  const closed = await req(`/api/jobs/${id}/transition`, { method: 'POST', body: { to: 'CLOSED' } });
  assert.strictEqual(closed.status, 200);
  assert.strictEqual(closed.body.status, 'CLOSED');
  assert.ok(get('SELECT id FROM job_costs WHERE job_id = ?', id));
});

test('a multi-mechanic daily-work entry splits into one costed row per mechanic', async () => {
  const job = await jobCard(post, { asset: '28-4314', type: 'repair', description: 'multi mech' });
  const id = job.id;
  const r = await req(`/api/jobs/${id}/daily-work`, { method: 'POST', body: { mechanic: 'Anura, Buddhika', hours: 4 } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.length, 2, 'two mechanics => two rows');
  assert.strictEqual(r.body[0].hours, 4, 'each mechanic worked full 4h');
  const detail = await req(`/api/jobs/${id}`);
  // full hours per mechanic: 4h × 400 (Anura) + 4h × 300 (Buddhika) = 1600 + 1200 = 2800
  assert.strictEqual(detail.body.cost.labour_cost, 2800);
});

test('unresolved asset text is queued as a pending alias — and holds the card back', async () => {
  // The vehicle is resolved where it is now typed: on the job request.
  const r = await req('/api/job-requests', { method: 'POST', body: { asset: 'mystery machine 9000', description: 'x' } });
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.unresolved, 'should report an unresolved alias');
  assert.ok(aliases.pendingAliases().some((a) => a.raw_text === 'mystery machine 9000'));
  // Approved or not, a request pointing at no vehicle cannot become a card: the asset is the master
  // key, and a card that points at nothing cannot roll its cost up to one.
  const id = r.body.request.id;
  await post(`/api/job-requests/${id}/certify`, {});
  await post(`/api/job-requests/${id}/approve`, {});
  const card = await post('/api/jobs', { job_request_id: id });
  assert.strictEqual(card.status, 409);
  assert.strictEqual(card.body.unlinked_asset, true);
  assert.match(card.body.error, /no vehicle linked/i);
});

// The New Asset form posts every field it renders, so an untouched "Home Project" dropdown
// arrives as "". Passing that straight into an INTEGER ... REFERENCES projects(id) column
// failed the foreign key and the form died on a 500 with no message.
test('creating an asset with blank optional fields does not 500', async () => {
  const r = await req('/api/assets', {
    method: 'POST',
    body: { code: 'BLANK-1', asset_class: 'vehicle', brand: 'Isuzu', type: 'Tipper',
            registration: 'BL-0001', home_project_id: '', current_project_id: '' },
  });
  assert.strictEqual(r.status, 201, 'an empty dropdown means "not set", not a broken FK');
  assert.strictEqual(r.body.home_project_id, null);
  assert.strictEqual(r.body.brand, 'Isuzu', 'the fields the user did fill in are kept');

  // and the same on edit — clearing a project back to none must work too
  const p = await req(`/api/assets/${r.body.id}`, { method: 'PATCH', body: { home_project_id: '', running_hours: '' } });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.home_project_id, null);
  assert.strictEqual(p.body.running_hours, null);
});

test('a real project id still links, as a number', async () => {
  const proj = run("INSERT INTO projects (name) VALUES ('Site A')").lastInsertRowid;
  const r = await req('/api/assets', { method: 'POST', body: { code: 'BLANK-2', home_project_id: String(proj) } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.home_project_id, proj, 'a numeric string is stored as a number');
});
