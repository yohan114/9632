'use strict';

// Multi-site Stage 2 — workshops and sites (src/lib/workshops.js, src/lib/places.js).
//
//   A workshop repairs vehicles and has its own mechanics and job cards; a site is where a vehicle
//   works (projects). Stage 2 records who and what belongs where — nobody sees less than before.
//   With one workshop the screens are unchanged; job cards, requests and people carry a workshop;
//   mechanics move from a date; transfer notes point at places from the list.

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s2-'));
process.env.DB_PATH = path.join(TMP, 's2.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');
const workshops = require('../src/lib/workshops');
const places = require('../src/lib/places');
const closeLib = require('../src/lib/job_close');

migrate();
for (const n of ['admin', 'workshop', 'operational_manager', 'manager', 'storekeeper', 'transport_manager', 'viewer', 'purchase_local']) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
const PW = 'ember-harbour-quarry';
function mkUser(username, roles) {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', username, auth.hashPassword(PW)).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
}
const U = { boss: mkUser('boss', ['admin']), ws: mkUser('ws', ['workshop']), om: mkUser('om', ['operational_manager']),
  mgr: mkUser('mgr', ['manager']), sk: mkUser('sk', ['storekeeper']), tm: mkUser('tm', ['transport_manager']) };
const CW = workshops.defaultId();

let seq = 0;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
const J = (id) => get('SELECT * FROM job_cards WHERE id = ?', id);
run("INSERT INTO mechanics (name, name_norm) VALUES ('Anura', 'ANURA')");
run("INSERT INTO labour_rates (mechanic, rate, effective_from) VALUES ('Anura', 400, '2020-01-01')");
const ANURA = get("SELECT id FROM mechanics WHERE name = 'Anura'").id;
const P = {
  cep: run("INSERT INTO projects (name, name_norm, code) VALUES ('CEP-03 Project', 'CEP03PROJECT', 'CEP-03')").lastInsertRowid,
  mar: run("INSERT INTO projects (name, name_norm) VALUES ('Marawila Road Project', 'MARAWILAROADPROJECT')").lastInsertRowid,
};

const app = require('../src/server');
let server; let port;
test.before(async () => { await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); }); port = server.address().port; });
test.after(() => { server && server.close(); });
function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, cookie: sc ? sc[0].split(';')[0] : null });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const cookies = {};
async function as(user) {
  if (!cookies[user]) {
    const r = await req('POST', '/api/auth/login', { body: { username: user, password: PW } });
    assert.strictEqual(r.status, 200, r.text);
    cookies[user] = secondFactorOn(r.cookie);
  }
  return cookies[user];
}

// Changing access needs 2-step sign-in (access plan, Part 4). The people here have it on, set
// directly (signing in with it is tested in test/mfa.test.js), so every refusal below has only the
// reason its test names: this person is marked as having it, and this session as having passed it.
function secondFactorOn(cookie) {
  const token = decodeURIComponent(cookie.split('=')[1]);
  const s = get('SELECT user_id FROM sessions WHERE token = ?', token);
  run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', s.user_id);
  run('UPDATE sessions SET mfa_verified = 1 WHERE token = ?', token);
  return cookie;
}


// ================================================================== one workshop: as before
test('one workshop (the start): everyone and everything is at Central Workshop, and nothing shows', async () => {
  const me = (await req('GET', '/api/auth/me', { cookie: await as('ws') })).body;
  assert.strictEqual(me.workshopsMulti, false, 'no picker, column or filter anywhere');
  assert.deepStrictEqual(me.workshop, { id: CW, code: 'CW', name: 'Central Workshop — Badalgama' });
  const list = (await req('GET', '/api/workshops', { cookie: await as('ws') })).body;
  assert.strictEqual(list.multi, false);
  assert.strictEqual(list.workshops.length, 1);
  assert.strictEqual(list.workshops[0].users, 6);
  // A job card raised with nothing said about workshops lands at Central Workshop.
  const r = await req('POST', '/api/jobs', { cookie: await as('ws'), body: { asset_id: asset('ONE-1'), description: 'brakes' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.job.workshop_id, CW);
  assert.strictEqual(r.body.job.workshop_name, 'Central Workshop — Badalgama');
});

test('"All workshops" (the head-office view) comes with the manager, operations and purchasing roles', () => {
  const caps = require('../src/lib/capabilities');
  for (const r of ['manager', 'operational_manager', 'purchase_local', 'admin']) assert.ok(caps.capsForRole(r).includes('workshops.all'), r);
  for (const r of ['workshop', 'storekeeper', 'transport_manager']) assert.ok(!caps.capsForRole(r).includes('workshops.all'), r);
  assert.ok(!caps.capsForRole('manager').includes('workshops.manage'), 'adding workshops is admin only');
  assert.ok(caps.capsForRole('manager').includes('mechanics.move'));
});

// ================================================================== the list
let MTR;
test('the admin adds a workshop; it must have a proper code and a new name; nobody else may', async () => {
  const boss = await as('boss');
  const add = (body, who = boss) => req('POST', '/api/workshops', { cookie: who, body });
  assert.strictEqual((await add({ code: 'MTR', name: 'Muthur Site Workshop', place: 'Muthur' }, await as('mgr'))).status, 403);
  assert.strictEqual((await add({ code: 'bad code!', name: 'Muthur Site Workshop' })).status, 400);
  assert.strictEqual((await add({ code: 'MTR', name: 'M' })).status, 400);
  assert.strictEqual((await add({ code: 'CW', name: 'Another' })).status, 409, 'the code is taken');
  assert.strictEqual((await add({ code: 'XX', name: 'central workshop — badalgama' })).status, 409, 'the name is taken, whatever the case');
  const r = await add({ code: 'mtr', name: 'Muthur Site Workshop', place: 'Muthur' });
  assert.strictEqual(r.status, 201, r.text);
  MTR = r.body.id;
  assert.strictEqual(r.body.code, 'MTR');
  assert.strictEqual(workshops.isMulti(), true);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: await as('ws') })).body.workshopsMulti, true);
  const ren = await req('PATCH', `/api/workshops/${MTR}`, { cookie: boss, body: { name: 'Muthur Workshop' } });
  assert.strictEqual(ren.body.name, 'Muthur Workshop');
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'workshop' AND action = 'create' AND entity_id = ?", MTR));
});

// ================================================================== people
test('a person\'s home workshop: set on create or later, only to a workshop in use', async () => {
  const boss = await as('boss');
  const c = await req('POST', '/api/users', { cookie: boss, body: { username: 'fitter1', password: 'a-long-temporary-pass', roles: ['workshop'], workshop_id: MTR } });
  assert.strictEqual(c.status, 201, c.text);
  assert.strictEqual(c.body.workshop_id, MTR);
  const plain = await req('POST', '/api/users', { cookie: boss, body: { username: 'fitter2', password: 'a-long-temporary-pass', roles: ['workshop'] } });
  assert.strictEqual(plain.body.workshop_id, CW, 'none chosen: the main workshop');
  const p = await req('PATCH', `/api/users/${U.ws}`, { cookie: boss, body: { workshop_id: MTR } });
  assert.strictEqual(p.status, 200, p.text);
  assert.strictEqual(p.body.workshop_id, MTR);
  assert.strictEqual((await req('PATCH', `/api/users/${U.ws}`, { cookie: boss, body: { workshop_id: 9999 } })).status, 400);
  assert.strictEqual((await req('GET', '/api/auth/me', { cookie: await as('ws') })).body.workshop.code, 'MTR');
});

// ================================================================== job cards
test('a job card goes to the workshop of whoever raises it, or the one chosen; it can be moved while open', async () => {
  const ws = await as('ws');   // now at Muthur
  const a = await req('POST', '/api/jobs', { cookie: ws, body: { asset_id: asset('JC-1'), description: 'gearbox' } });
  assert.strictEqual(a.body.job.workshop_id, MTR);
  const b = await req('POST', '/api/jobs', { cookie: ws, body: { asset_id: asset('JC-2'), description: 'x', workshop_id: CW } });
  assert.strictEqual(b.body.job.workshop_id, CW);
  // The list filter, and each row's workshop.
  const mine = (await req('GET', `/api/jobs?workshop_id=${MTR}`, { cookie: ws })).body;
  assert.ok(mine.some((j) => j.id === a.body.job.id) && !mine.some((j) => j.id === b.body.job.id));
  assert.strictEqual(mine.find((j) => j.id === a.body.job.id).workshop_code, 'MTR');
  // Moved while open, audited; not onto a workshop that does not exist.
  // Stage 7: with a reason (S7-D6).
  const mv = await req('PATCH', `/api/jobs/${b.body.job.id}`, { cookie: ws, body: { workshop_id: MTR, workshop_reason: 'Muthur has the parts' } });
  assert.strictEqual(mv.status, 200, mv.text);
  assert.strictEqual(J(b.body.job.id).workshop_id, MTR);
  const trail = get("SELECT before_json, after_json FROM audit_log WHERE entity = 'job_card' AND action = 'edit' AND entity_id = ? ORDER BY id DESC", b.body.job.id);
  assert.strictEqual(JSON.parse(trail.before_json).workshop_id, CW);
  assert.strictEqual(JSON.parse(trail.after_json).workshop_id, MTR);
  assert.strictEqual((await req('PATCH', `/api/jobs/${b.body.job.id}`, { cookie: ws, body: { workshop_id: 9999 } })).status, 400);
  // A closed card stays with the workshop that did the work, even for someone who may edit closed cards.
  run("UPDATE job_cards SET status = 'CLOSED' WHERE id = ?", b.body.job.id);
  const closed = await req('PATCH', `/api/jobs/${b.body.job.id}`, { cookie: ws, body: { workshop_id: CW } });
  assert.strictEqual(closed.status, 409, closed.text);
  assert.strictEqual(J(b.body.job.id).workshop_id, MTR);
  assert.strictEqual((await req('PATCH', `/api/jobs/${b.body.job.id}`, { cookie: ws, body: { description: 'gearbox, done' } })).status, 200,
    'other corrections to a closed card are as before');
});

test('a job request\'s card goes to the raiser\'s workshop; a partial close\'s new card stays in the same one', async () => {
  const v = asset('JR-1');
  const jr = run(`INSERT INTO job_requests (jr_no, asset_id, type, description, approval_status, requested_by, requested_by_user)
                  VALUES ('JR-9001', ?, 'repair', 'x', 'certified', 'fitter1', (SELECT id FROM users WHERE username = 'fitter1'))`, v).lastInsertRowid;
  run("INSERT INTO job_request_approvals (job_request_id, stage, role, approver_id, decision) VALUES (?, 'certify', 'transport_manager', ?, 'approved')", jr, U.tm);
  const r = await req('POST', `/api/job-requests/${jr}/approve`, { cookie: await as('om'), body: {} });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(J(r.body.job.id).workshop_id, MTR, 'fitter1 is at Muthur');

  closeLib.setEnabled(true);
  try {
    const card = r.body.job.id;
    run("UPDATE job_cards SET status = 'IN_PROGRESS' WHERE id = ?", card);
    run("INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours) VALUES (?, ?, 'Anura', 'work', 2)", card, day(-1));
    run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (?, 'external', 'Seal', 1, NULL)", card);
    // Partly closed by someone whose home is Central: the vehicle's next card still stays at Muthur.
    run('UPDATE users SET workshop_id = ? WHERE id = ?', CW, U.ws);
    const pc = await req('POST', `/api/jobs/${card}/partial-close`, { cookie: await as('ws'), body: { note: 'price to come', open_new: true } });
    assert.strictEqual(pc.status, 200, pc.text);
    assert.strictEqual(J(pc.body.new_job.id).workshop_id, MTR);
  } finally { closeLib.setEnabled(false); run('UPDATE users SET workshop_id = ? WHERE id = ?', MTR, U.ws); }
});

// ================================================================== requests (MRN)
test('a request goes to its job card\'s workshop, else to the person who raised it', async () => {
  const sk = await as('sk');
  run('UPDATE users SET workshop_id = ? WHERE id = ?', MTR, U.sk);   // a storekeeper posted to Muthur
  try {
    const jobAtCw = J((await req('POST', '/api/jobs', { cookie: await as('ws'), body: { asset_id: asset('MR-1'), description: 'x', workshop_id: CW } })).body.job.id);
    const withJob = await req('POST', '/api/stores/mrn', { cookie: sk, body: { request_type: 'vehicle', asset_id: jobAtCw.asset_id, job_id: jobAtCw.id,
      lines: [{ description: 'Hose', qty: 1 }] } });
    assert.strictEqual(withJob.status, 201, withJob.text);
    const general = await req('POST', '/api/stores/mrn', { cookie: sk, body: { request_type: 'general', lines: [{ description: 'Rags', qty: 5 }] } });
    assert.strictEqual(general.status, 201, general.text);
    const idOf = (r) => r.body.id || (r.body.mrn && r.body.mrn.id);
    assert.strictEqual(get('SELECT workshop_id w FROM mrn WHERE id = ?', idOf(withJob)).w, CW, 'the job card decides, not the storekeeper');
    assert.strictEqual(get('SELECT workshop_id w FROM mrn WHERE id = ?', idOf(general)).w, MTR, 'no job card: the storekeeper\'s workshop');
    const list = (await req('GET', `/api/stores/mrn?workshop_id=${MTR}`, { cookie: sk })).body;
    assert.ok(list.some((m) => m.id === idOf(general)) && !list.some((m) => m.id === idOf(withJob)));
    assert.strictEqual((await req('GET', `/api/stores/mrn/${idOf(general)}`, { cookie: sk })).body.mrn.workshop_name, 'Muthur Workshop');
  } finally { run('UPDATE users SET workshop_id = ? WHERE id = ?', CW, U.sk); }
  const jobAtMtr = J((await req('POST', '/api/jobs', { cookie: await as('ws'), body: { asset_id: asset('MR-2'), description: 'x' } })).body.job.id);
  // Inserted by any other path with a job: the job's workshop, from the trigger.
  const raw = run("INSERT INTO mrn (mrn_no, job_id) VALUES ('RAW-1', ?)", jobAtMtr.id).lastInsertRowid;
  assert.strictEqual(get('SELECT workshop_id w FROM mrn WHERE id = ?', raw).w, MTR);
});

// ================================================================== mechanics
test('a mechanic moves from a date: the history is kept, and old days stay with the old workshop', async () => {
  const mgr = await as('mgr');
  assert.strictEqual((await req('POST', `/api/workshops/mechanics/${ANURA}/move`, { cookie: await as('ws'), body: { workshop_id: MTR } })).status, 403);
  const mv = (body) => req('POST', `/api/workshops/mechanics/${ANURA}/move`, { cookie: mgr, body });
  assert.strictEqual((await mv({ workshop_id: MTR, from_date: day(3) })).status, 400, 'not in the future');
  assert.strictEqual((await mv({ workshop_id: CW, from_date: day(-10) })).status, 409, 'already there');
  const r = await mv({ workshop_id: MTR, from_date: day(-10), note: 'sent to Muthur' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(workshops.mechanicWorkshop(ANURA, day(-11)), CW, 'the day before the move');
  assert.strictEqual(workshops.mechanicWorkshop(ANURA, day(-10)), MTR);
  assert.strictEqual(workshops.mechanicWorkshop(ANURA), MTR);
  assert.strictEqual((await mv({ workshop_id: MTR, from_date: day(-20) })).status, 409, 'not before the last move');
  // Same day again: that move is corrected, not stacked.
  assert.strictEqual((await mv({ workshop_id: CW, from_date: day(-10) })).status, 200);
  assert.strictEqual(workshops.mechanicWorkshop(ANURA, day(-10)), CW);
  assert.strictEqual((await mv({ workshop_id: MTR, from_date: day(-5) })).status, 200);
  const hist = (await req('GET', `/api/workshops/mechanics/${ANURA}/history`, { cookie: mgr })).body;
  assert.deepStrictEqual(hist.map((h) => [h.from_date, h.workshop_id]), [[day(-5), MTR], [day(-10), CW], ['2000-01-01', CW]]);
  const list = (await req('GET', '/api/workshops/mechanics', { cookie: mgr })).body;
  assert.strictEqual(list.find((m) => m.id === ANURA).workshop_id, MTR);
  assert.strictEqual((await req('GET', '/api/mechanics', { cookie: mgr })).body.find((m) => m.id === ANURA).workshop_id, MTR);
  assert.ok(get("SELECT 1 x FROM audit_log WHERE entity = 'mechanic' AND action = 'move_workshop' AND entity_id = ?", ANURA));
});

// ================================================================== retiring
test('a workshop is retired only when empty; the main one never; nothing new goes to a retired one', async () => {
  const boss = await as('boss');
  const off = (id) => req('PATCH', `/api/workshops/${id}`, { cookie: boss, body: { active: false } });
  const main = await off(CW);
  assert.strictEqual(main.status, 409);
  assert.match(main.body.error, /is the main workshop and cannot be retired/);
  const busy = await off(MTR);
  assert.strictEqual(busy.status, 409);
  assert.match(busy.body.error, /still has \d+ user\(s\), 1 mechanic\(s\), \d+ open job card\(s\)/);
  const spare = (await req('POST', '/api/workshops', { cookie: boss, body: { code: 'SPR', name: 'Spare Yard' } })).body.id;
  assert.strictEqual((await off(spare)).status, 200);
  assert.strictEqual((await req('POST', '/api/jobs', { cookie: await as('ws'), body: { asset_id: asset('RT-1'), description: 'x', workshop_id: spare } })).status, 400);
  assert.strictEqual((await req('PATCH', `/api/users/${U.sk}`, { cookie: boss, body: { workshop_id: spare } })).status, 400);
  assert.strictEqual((await req('PATCH', `/api/workshops/${spare}`, { cookie: boss, body: { active: true } })).status, 200);
});

// ================================================================== places on transfer notes
test('places: a name links only when exactly one place fits', () => {
  const k = (t) => places.resolve(t);
  assert.strictEqual(k('Work Shop Stores'), `w:${CW}`);
  assert.strictEqual(k('Main Store'), `w:${CW}`);
  assert.strictEqual(k('Muthur Workshop'), `w:${MTR}`);
  assert.strictEqual(k('CEP-03 Wadakada Machanic'), `p:${P.cep}`);
  assert.strictEqual(k('CEP-03'), `p:${P.cep}`);
  assert.strictEqual(k('Marawila Site'), `p:${P.mar}`);
  assert.strictEqual(k('HEX-19'), null, 'a machine');
  assert.strictEqual(k('Head Office'), null);
  assert.strictEqual(k('Batticoloa'), null);
  // Two projects that both fit: neither. One that fits: that one.
  const a = run("INSERT INTO projects (name, name_norm) VALUES ('Colombo North Project', 'COLOMBONORTHPROJECT')").lastInsertRowid;
  assert.strictEqual(k('Colombo Site'), `p:${a}`);
  const b = run("INSERT INTO projects (name, name_norm) VALUES ('Colombo South Project', 'COLOMBOSOUTHPROJECT')").lastInsertRowid;
  assert.strictEqual(k('Colombo Site'), null);
  run('DELETE FROM projects WHERE id IN (?, ?)', a, b);
  assert.throws(() => places.forEnd('p:99999', 'x'), (e) => e.status === 400);
  assert.ok(places.list().some((p) => p.key === `w:${MTR}`) && places.list().some((p) => p.key === `p:${P.cep}`));
});

test('a transfer note: pick a place or type it; the text stays; edits re-read it; search by place', async () => {
  const sk = await as('sk');
  const picked = await req('POST', '/api/stores/mtn', { cookie: sk, body: { mtn_no: '70001', from_place: `w:${CW}`, to_place: `p:${P.cep}`,
    lines: [{ description: 'Filter', qty: 2 }, { description: 'Belt', qty: 1, to_location: 'Marawila Site' }] } });
  assert.strictEqual(picked.status, 201, picked.text);
  assert.strictEqual(picked.body.from_location, 'Central Workshop — Badalgama', 'a picked place writes its name as the text');
  assert.strictEqual(picked.body.to_place, `p:${P.cep}`);
  assert.deepStrictEqual(picked.body.lines.map((l) => l.to_place), [null, `p:${P.mar}`]);
  const typed = await req('POST', '/api/stores/mtn', { cookie: sk, body: { mtn_no: '70002', from_location: 'Work Shop', to_location: 'HEX-19',
    lines: [{ description: 'Pump', qty: 1 }] } });
  assert.strictEqual(typed.body.from_place, `w:${CW}`);
  assert.strictEqual(typed.body.to_place, null, 'a machine stays text');
  assert.strictEqual(typed.body.from_location, 'Work Shop', 'the text as written');
  const bad = await req('POST', '/api/stores/mtn', { cookie: sk, body: { mtn_no: '70003', to_place: 'p:99999', lines: [{ description: 'x', qty: 1 }] } });
  assert.strictEqual(bad.status, 400);
  // Correcting the text re-reads the place; correcting a line does too.
  const ed = await req('PATCH', `/api/stores/mtn/${typed.body.id}`, { cookie: sk, body: { to_location: 'CEP-03' } });
  assert.strictEqual(ed.body.to_place, `p:${P.cep}`);
  const line = picked.body.lines[1];
  const le = await req('PATCH', `/api/stores/mtn/line/${line.id}`, { cookie: sk, body: { to_location: 'Head Office' } });
  assert.strictEqual(le.body.to_place, null);
  // Everything that went to CEP-03, on the note or on an item.
  const cep = (await req('GET', `/api/stores/mtn?place=p:${P.cep}`, { cookie: sk })).body.map((t) => t.mtn_no).sort();
  assert.deepStrictEqual(cep, ['70001', '70002']);
  const mar = (await req('GET', `/api/stores/mtn?place=p:${P.mar}`, { cookie: sk })).body;
  assert.deepStrictEqual(mar, [], 'the Marawila item was corrected to Head Office');
  assert.ok((await req('GET', '/api/stores/places', { cookie: sk })).body.some((p) => p.key === `w:${MTR}`));
});
