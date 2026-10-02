'use strict';

// scripts/legacy_cards_into_workshop.js — the one-off that puts the cards raised BEFORE job
// requests existed into the workshop, instead of leaving them queued for an approval that was
// given on paper weeks ago.
//
// What matters here is what it does NOT touch, because it runs against the live book: a card that
// came through a job request, a breakdown, a container, imported history, and a stuck card all have
// to come out the other side exactly as they went in.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-legacy-'));
const DB = path.join(TMP, 'legacy.db');
process.env.DB_PATH = DB;
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');

migrate();

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
let seq = 0;
const asset = (code) => run('INSERT INTO assets (code, code_norm, status, in_register) VALUES (?, ?, ?, 1)', code, code.replace(/\W/g, ''), 'active').lastInsertRowid;
function card(description, o = {}) {
  return run(
    `INSERT INTO job_cards (job_no, asset_id, type, description, status, requested_at, requested_by,
                            is_historical, breakdown, field, legacy_ref, job_request_id)
     VALUES (?, ?, 'repair', ?, ?, ?, 'System Admin', ?, ?, ?, ?, ?)`,
    `2026/8/R/${++seq}`, 'asset' in o ? o.asset : asset(`LG-${seq}`), description,
    o.status || 'REQUESTED', o.date || day(-52), o.hist || 0, o.bd || 0, o.field || 0,
    o.legacy || null, o.jr || null).lastInsertRowid;
}

// The live backlog: no request, waiting at an approval step.
const WAITING_A = card('Back side sheet bush repair');
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Anura', 4)", WAITING_A, day(-10));
const WAITING_B = card('Silencer repair');
const WAITING_C = card('Jack repair', { status: 'APPROVED_TRANSPORT' });
// Everything that must be left exactly as it is.
const STUCK = card('Abandoned long ago', { date: day(-200) });
const BREAKDOWN = card('Breakdown at a site', { bd: 1, field: 1 });
const IMPORTED = card('Imported history', { hist: 1, date: day(-200) });
const CONTAINER = card('General workshop holder', { asset: null, legacy: 'general-workshop' });
const JR = run(`INSERT INTO job_requests (jr_no, req_date, asset_id, type, description, approval_status)
                VALUES ('JR-9000', date('now'), NULL, 'repair', 'proper one', 'approved')`).lastInsertRowid;
const FROM_REQUEST = card('Opened from a request', { jr: JR });

const SCRIPT = path.join(__dirname, '..', 'scripts', 'legacy_cards_into_workshop.js');
const sh = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DB_PATH: DB }, encoding: 'utf8' });
const statusOf = (id) => get('SELECT status FROM job_cards WHERE id = ?', id).status;
const UNTOUCHED = [['stuck', STUCK], ['breakdown', BREAKDOWN], ['imported', IMPORTED], ['container', CONTAINER], ['from a request', FROM_REQUEST]];

test('a dry run says what it would do and changes nothing', () => {
  const out = sh();
  assert.match(out, /Moving 3 card\(s\) to IN_WORKSHOP/);
  assert.match(out, /REQUESTED 2, APPROVED_TRANSPORT 1/);
  assert.match(out, /1 stuck/);
  assert.match(out, /DRY RUN/);
  for (const [, id] of [['a', WAITING_A], ['b', WAITING_B], ...UNTOUCHED]) {
    assert.notStrictEqual(statusOf(id), 'IN_WORKSHOP', 'a dry run writes nothing at all');
  }
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_approvals').c, 0);
});

test('--apply moves the backlog, and only the backlog', () => {
  sh('--apply');
  for (const id of [WAITING_A, WAITING_B, WAITING_C]) assert.strictEqual(statusOf(id), 'IN_WORKSHOP');
  for (const [what, id] of UNTOUCHED) assert.strictEqual(statusOf(id), 'REQUESTED', `${what} must be left alone`);
});

test('the card keeps its own dates, so a long wait still reads as a long wait', () => {
  const j = get('SELECT requested_at, approved_transport_at, approved_ops_at FROM job_cards WHERE id = ?', WAITING_A);
  assert.strictEqual(j.approved_transport_at, j.requested_at, 'not today — the day it was raised');
  assert.strictEqual(j.approved_ops_at, j.requested_at);
  assert.strictEqual(j.requested_at, day(-52));
});

test('the approvals say nobody signed them in the app', () => {
  const trail = all('SELECT role, approver_id, reason FROM job_approvals WHERE job_id = ? ORDER BY id', WAITING_A);
  assert.deepStrictEqual(trail.map((t) => t.role), ['transport_manager', 'operational_manager']);
  assert.deepStrictEqual(trail.map((t) => t.approver_id), [null, null], 'no name is invented for a signature nobody gave');
  assert.match(trail[0].reason, /approved outside the app/i);
  // And the move is on the card's own audit trail.
  const a = get("SELECT action, after_json FROM audit_log WHERE entity = 'job_card' AND entity_id = ? ORDER BY id DESC LIMIT 1", WAITING_A);
  assert.deepStrictEqual([a.action, JSON.parse(a.after_json).status], ['transition', 'IN_WORKSHOP']);
});

test('running it twice is safe: the second pass finds nothing to move', () => {
  const before = get("SELECT COUNT(*) c FROM job_approvals").c;
  const out = sh('--apply');
  assert.match(out, /Nothing to move/);
  assert.strictEqual(get("SELECT COUNT(*) c FROM job_approvals").c, before, 'no second set of approval rows');
  assert.strictEqual(statusOf(STUCK), 'REQUESTED');
});

test('--include-stuck takes the abandoned ones too, when that is what is wanted', () => {
  assert.match(sh(), /1 stuck/);
  sh('--apply', '--include-stuck');
  assert.strictEqual(statusOf(STUCK), 'IN_WORKSHOP');
  // Still never the breakdown, the container, the imported card or one with a request.
  for (const [what, id] of UNTOUCHED.slice(1)) assert.strictEqual(statusOf(id), 'REQUESTED', `${what} is never included`);
});
