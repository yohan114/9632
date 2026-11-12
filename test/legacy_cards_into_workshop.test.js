'use strict';

// scripts/legacy_cards_into_workshop.js — the one-off that puts the cards approved ON PAPER into
// the workshop, instead of leaving them queued for a signature that already exists.
//
// The cut-off date is the whole rule, so the two tests that matter most are that a card raised
// before it moves and a card raised on or after it does not. The rest is what it must never touch,
// because it runs against the live book: a card that came through a job request, a breakdown, a
// container and imported history all have to come out exactly as they went in.

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

const CUTOFF = '2026-10-01';
const BEFORE = '2026-08-11';   // approvals given on paper
const ON = '2026-10-01';       // the cut-off day itself belongs to the new process
const AFTER = '2026-10-05';    // plainly after

// Approved on paper: no request, waiting at an approval step, raised before the cut-off.
const WAITING_A = card('Back side sheet bush repair', { date: BEFORE });
run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Anura', 4)", WAITING_A, day(-10));
const WAITING_B = card('Silencer repair', { date: BEFORE });
const WAITING_C = card('Jack repair', { status: 'APPROVED_TRANSPORT', date: BEFORE });
// From the cut-off the approvals belong in the app, so these go through the process.
const ON_CUTOFF = card('Raised on the cut-off day', { date: ON });
const AFTER_CUTOFF = card('Raised after the cut-off', { date: AFTER });
// Everything that must be left exactly as it is, whatever its date.
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
// Never moved, whatever the cut-off says.
const UNTOUCHED = [['breakdown', BREAKDOWN], ['imported', IMPORTED], ['container', CONTAINER],
  ['from a request', FROM_REQUEST], ['on the cut-off', ON_CUTOFF], ['after the cut-off', AFTER_CUTOFF]];

test('a dry run says what it would do and changes nothing', () => {
  const out = sh();
  assert.match(out, new RegExp(`Cut-off: ${CUTOFF}`));
  // The three before it, plus the stuck one — which the cut-off covers like the rest.
  assert.match(out, /Moving 4 card\(s\) to IN_WORKSHOP/);
  assert.match(out, /REQUESTED 3, APPROVED_TRANSPORT 1/);
  assert.match(out, /2 raised ON OR AFTER 2026-10-01/);
  assert.match(out, /of these, 1 are stuck/);
  assert.match(out, /DRY RUN/);
  for (const [, id] of [['a', WAITING_A], ['b', WAITING_B], ['stuck', STUCK], ...UNTOUCHED]) {
    assert.notStrictEqual(statusOf(id), 'IN_WORKSHOP', 'a dry run writes nothing at all');
  }
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_approvals').c, 0);
});

test('the cut-off is the rule: before it moves, on or after it does not', () => {
  sh('--apply');
  for (const id of [WAITING_A, WAITING_B, WAITING_C]) assert.strictEqual(statusOf(id), 'IN_WORKSHOP');
  assert.strictEqual(statusOf(ON_CUTOFF), 'REQUESTED', 'the cut-off day itself belongs to the new process');
  assert.strictEqual(statusOf(AFTER_CUTOFF), 'REQUESTED');
  for (const [what, id] of UNTOUCHED) assert.strictEqual(statusOf(id), 'REQUESTED', `${what} must be left alone`);
});

test('a stuck card before the cut-off moves too — its approval was on paper like the rest', () => {
  assert.strictEqual(statusOf(STUCK), 'IN_WORKSHOP');
});

test('the card keeps its own dates, so a long wait still reads as a long wait', () => {
  const j = get('SELECT requested_at, approved_transport_at, approved_ops_at FROM job_cards WHERE id = ?', WAITING_A);
  assert.strictEqual(j.approved_transport_at, j.requested_at, 'not today — the day it was raised');
  assert.strictEqual(j.approved_ops_at, j.requested_at);
  // BEFORE is a fixed date (the rule is the cut-off, not the card's age): day(-52) matched it on one
  // day only, 2026-10-02, and failed on every day after.
  assert.strictEqual(j.requested_at, BEFORE);
});

test('the approvals say nobody signed them in the app', () => {
  const trail = all('SELECT role, approver_id, reason FROM job_approvals WHERE job_id = ? ORDER BY id', WAITING_A);
  assert.deepStrictEqual(trail.map((t) => t.role), ['transport_manager', 'operational_manager']);
  assert.deepStrictEqual(trail.map((t) => t.approver_id), [null, null], 'no name is invented for a signature nobody gave');
  assert.match(trail[0].reason, /given on paper rather than in the app/i);
  assert.match(trail[0].reason, new RegExp(`Raised before ${CUTOFF}`), 'and names the cut-off it was judged by');
  // And the move is on the card's own audit trail.
  const a = get("SELECT action, after_json FROM audit_log WHERE entity = 'job_card' AND entity_id = ? ORDER BY id DESC LIMIT 1", WAITING_A);
  assert.deepStrictEqual([a.action, JSON.parse(a.after_json).status], ['transition', 'IN_WORKSHOP']);
});

test('running it twice is safe: the second pass finds nothing to move', () => {
  const before = get('SELECT COUNT(*) c FROM job_approvals').c;
  const out = sh('--apply');
  assert.match(out, /Nothing to move/);
  assert.strictEqual(get('SELECT COUNT(*) c FROM job_approvals').c, before, 'no second set of approval rows');
});

test('--skip-stuck leaves the abandoned ones for the Review screen', () => {
  const left = card('Abandoned, and to be reviewed', { date: day(-250) });
  const live = card('Waiting, worked on recently', { date: BEFORE });
  run("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (?, ?, 'Sunil', 2)", live, day(-5));
  const out = sh('--skip-stuck');
  assert.match(out, /Moving 1 card\(s\)/);
  assert.match(out, /1 stuck card\(s\) LEFT OUT/);
  sh('--apply', '--skip-stuck');
  assert.strictEqual(statusOf(live), 'IN_WORKSHOP');
  assert.strictEqual(statusOf(left), 'REQUESTED', 'left for Review stuck cards');
});

test('--before moves the cut-off, and a bad date is refused rather than guessed', () => {
  // With the cut-off pulled back, the card raised after it is now "before" and moves.
  sh('--apply', `--before=2026-10-10`);
  assert.strictEqual(statusOf(ON_CUTOFF), 'IN_WORKSHOP');
  assert.strictEqual(statusOf(AFTER_CUTOFF), 'IN_WORKSHOP');
  assert.throws(() => sh('--before=last-october'), /status 1|Command failed/);
});
