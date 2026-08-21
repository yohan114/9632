'use strict';

// Two batteries to a vehicle, and up to six photographs of each.
//
// Heavy machines run a pair in series — four vehicles in the live book already carry two — so
// the pair has to be a first-class thing rather than an accident of two rows pointing at the
// same asset. A third is refused: it always means something was recorded wrong, most often an
// old battery that was never returned before the new one went on, and the message has to say
// so or the storekeeper is simply stuck.
//
// Photographs are how a warranty claim is argued, so one is never enough. They live in the
// database as resized data URLs (like the e-signatures) rather than in a folder, which is why
// there is a hard ceiling on the count.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-battery-pair-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
for (const n of ['admin', 'storekeeper']) run('INSERT INTO roles (name) VALUES (?)', n);
const uid = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', 'sk', auth.hashPassword('pw')).lastInsertRowid;
for (const r of ['admin', 'storekeeper']) {
  run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, r);
}
const DT23 = require('../src/lib/aliases').findOrCreateAsset('DT-23').id;
const DT25 = require('../src/lib/aliases').findOrCreateAsset('DT-25').id;

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

const api = async (p, opts = {}) => {
  const r = await fetch(base + '/api' + p, {
    method: opts.method || 'GET', headers: { 'content-type': 'application/json', cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// A 1x1 JPEG data URL — the shape the browser sends after resizing.
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const addBattery = (serial, extra = {}) => api('/batteries', { method: 'POST', body: { serial_no: serial, ...extra } });

// ---- two to a vehicle ------------------------------------------------------

test('a vehicle can carry a pair', async () => {
  assert.strictEqual((await addBattery('P-1', { current_asset_id: DT23 })).status, 201);
  assert.strictEqual((await addBattery('P-2', { current_asset_id: DT23 })).status, 201);
  assert.strictEqual(get('SELECT COUNT(*) c FROM batteries WHERE current_asset_id = ?', DT23).c, 2);
});

test('a third is refused, and the message says what to do about it', async () => {
  const r = await addBattery('P-3', { current_asset_id: DT23 });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /DT-23 already has 2 batteries/);
  assert.match(r.body.error, /P-1, P-2/, 'naming the two already on it');
  assert.match(r.body.error, /Return or decommission/, 'and how to get unstuck');
  assert.strictEqual(get(`SELECT COUNT(*) c FROM batteries WHERE serial_no = 'P-3'`).c, 0, 'nothing was written');
});

test('installing a third onto a full vehicle is refused too', async () => {
  const spare = await addBattery('P-4');
  const r = await api(`/batteries/${spare.body.id}/event`, { method: 'POST', body: { event_type: 'install', to_asset_id: DT23 } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /already has 2 batteries/);
  assert.strictEqual(get('SELECT current_asset_id FROM batteries WHERE id = ?', spare.body.id).current_asset_id, null,
    'and it stays in the store');
});

test('returning one makes room for the next', async () => {
  const off = get(`SELECT id FROM batteries WHERE serial_no = 'P-1'`);
  assert.strictEqual((await api(`/batteries/${off.id}/event`, { method: 'POST', body: { event_type: 'return' } })).status, 201);
  const spare = get(`SELECT id FROM batteries WHERE serial_no = 'P-4'`);
  const r = await api(`/batteries/${spare.id}/event`, { method: 'POST', body: { event_type: 'install', to_asset_id: DT23 } });
  assert.strictEqual(r.status, 201, 'the swap goes through once the old one is off');
  assert.strictEqual(get('SELECT COUNT(*) c FROM batteries WHERE current_asset_id = ?', DT23).c, 2);
});

test('re-seating a battery on the vehicle it is already on is not blocked by itself', async () => {
  // It occupies one of the two slots; counting it against its own move would be an own goal.
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'P-2'`);
  const r = await api(`/batteries/${b.id}/event`, { method: 'POST', body: { event_type: 'install', to_asset_id: DT23, reason: 're-seated' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(get('SELECT current_asset_id FROM batteries WHERE id = ?', b.id).current_asset_id, DT23);
});

test('a decommissioned battery frees its slot', async () => {
  await addBattery('Q-1', { current_asset_id: DT25 });
  const q2 = await addBattery('Q-2', { current_asset_id: DT25 });
  assert.strictEqual((await addBattery('Q-3', { current_asset_id: DT25 })).status, 409);
  await api(`/batteries/${q2.body.id}/event`, { method: 'POST', body: { event_type: 'decommission' } });
  assert.strictEqual((await addBattery('Q-3', { current_asset_id: DT25 })).status, 201);
});

test('a battery in the store is on no vehicle and blocks nothing', async () => {
  for (const s of ['S-1', 'S-2', 'S-3']) assert.strictEqual((await addBattery(s)).status, 201);
  assert.strictEqual(get('SELECT COUNT(*) c FROM batteries WHERE current_asset_id IS NULL').c >= 3, true);
});

test('a battery knows the other one on its vehicle', async () => {
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'P-2'`);
  const r = await api('/batteries/' + b.id);
  assert.strictEqual(r.body.on_same_vehicle.length, 1);
  assert.strictEqual(r.body.on_same_vehicle[0].serial_no, 'P-4');
  assert.strictEqual(r.body.max_per_vehicle, 2);
});

test('the list says which machines are carrying a pair', async () => {
  const r = await api('/batteries');
  const p2 = r.body.find((x) => x.serial_no === 'P-2');
  assert.strictEqual(p2.on_vehicle, 2);
  const store = r.body.find((x) => x.serial_no === 'S-1');
  assert.strictEqual(store.on_vehicle, 0, 'nothing in the store counts toward a vehicle');
});

// ---- up to six photographs -------------------------------------------------

test('a battery can be added with several photos at once', async () => {
  const r = await addBattery('IMG-1', { photos: [IMG, IMG, IMG] });
  assert.strictEqual(r.status, 201);
  const d = await api('/batteries/' + r.body.id);
  assert.strictEqual(d.body.photos.length, 3);
  assert.deepStrictEqual(d.body.photos.map((p) => p.seq), [1, 2, 3]);
});

test('more can be added afterwards', async () => {
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'IMG-1'`);
  const r = await api(`/batteries/${b.id}/photos`, { method: 'POST', body: { photos: [IMG, IMG] } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.length, 5);
});

test('the sixth fits and the seventh is refused, saying how much room is left', async () => {
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'IMG-1'`);
  assert.strictEqual((await api(`/batteries/${b.id}/photos`, { method: 'POST', body: { photos: [IMG] } })).status, 201);
  const r = await api(`/batteries/${b.id}/photos`, { method: 'POST', body: { photos: [IMG] } });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /at most 6 photos/);
  assert.strictEqual(get('SELECT COUNT(*) c FROM battery_photos WHERE battery_id = ?', b.id).c, 6, 'still six');
});

test('a batch that would overflow is refused whole, not half-written', async () => {
  const r0 = await addBattery('IMG-2', { photos: [IMG, IMG, IMG, IMG, IMG] });
  const r = await api(`/batteries/${r0.body.id}/photos`, { method: 'POST', body: { photos: [IMG, IMG, IMG] } });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(get('SELECT COUNT(*) c FROM battery_photos WHERE battery_id = ?', r0.body.id).c, 5,
    'five, not six — a partial batch would be worse than none');
});

test('creating with more than six is refused outright', async () => {
  const r = await addBattery('IMG-3', { photos: Array(7).fill(IMG) });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(get(`SELECT COUNT(*) c FROM batteries WHERE serial_no = 'IMG-3'`).c, 0);
});

test('a photo can be removed, and the rest close the gap', async () => {
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'IMG-1'`);
  const third = all('SELECT id FROM battery_photos WHERE battery_id = ? ORDER BY seq', b.id)[2];
  const r = await api(`/batteries/${b.id}/photos/${third.id}`, { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(all('SELECT seq FROM battery_photos WHERE battery_id = ? ORDER BY seq', b.id).map((x) => x.seq),
    [1, 2, 3, 4, 5], 'no hole where the removed one was');
});

test('the cover photo follows the gallery', async () => {
  const r0 = await addBattery('IMG-4', { photos: [IMG] });
  const id = r0.body.id;
  assert.ok(get('SELECT photo_path FROM batteries WHERE id = ?', id).photo_path, 'the list flag reads this');
  const only = get('SELECT id FROM battery_photos WHERE battery_id = ?', id);
  await api(`/batteries/${id}/photos/${only.id}`, { method: 'DELETE' });
  assert.strictEqual(get('SELECT photo_path FROM batteries WHERE id = ?', id).photo_path, null,
    'removing the last photo must not leave a cover pointing at nothing');
});

test('something that is not an image is refused', async () => {
  const b = get(`SELECT id FROM batteries WHERE serial_no = 'IMG-4'`);
  const r = await api(`/batteries/${b.id}/photos`, { method: 'POST', body: { photos: ['data:application/pdf;base64,AAAA'] } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /PNG, JPEG or WebP/);
});

test('the list carries a photo count', async () => {
  const r = await api('/batteries?q=IMG-1');
  const row = r.body.find((x) => x.serial_no === 'IMG-1');
  assert.strictEqual(row.photo_count, 5);
  assert.strictEqual(row.has_photo, 1);
});

test('the old single-photo call still works', async () => {
  // Anything still posting the pre-gallery shape must not break.
  const r0 = await addBattery('LEG-1');
  const r = await api(`/batteries/${r0.body.id}/photo`, { method: 'PATCH', body: { photo_path: IMG } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM battery_photos WHERE battery_id = ?', r0.body.id).c, 1);
  assert.ok(r.body.photo_path, 'and the cover is set');

  const cleared = await api(`/batteries/${r0.body.id}/photo`, { method: 'PATCH', body: { photo_path: null } });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(get('SELECT COUNT(*) c FROM battery_photos WHERE battery_id = ?', r0.body.id).c, 0);
});
