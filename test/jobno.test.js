'use strict';

// The job card number: YYYY/M/(R|S)/seq
//
// The sequence runs through the YEAR. August ending at 583 means September starts at 584 — the
// month in the number says when the card was raised, not where the counter stands.
//
// It used to reset every month: the generator asked for the highest number matching "2026/9/R/%",
// found none on the first of the month, and began again at 1. The evidence is in the real book —
// 2026/7/R/1 was created by the app on 19 July while June had already reached 434, so the workshop
// held two cards numbered 1 and 493 in the same month. The paperwork never worked that way: right
// through 2025 each month began where the last ended, 106 in February unbroken to 920 in November,
// restarting only with the year.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-jobno-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get } = require('../src/db');
const { nextJobNo } = require('../src/lib/jobno');

migrate();

const card = (jobNo, status = 'CLOSED') => run(
  `INSERT INTO job_cards (job_no, type, description, status, requested_by, requested_at)
   VALUES (?, 'repair', 'x', ?, 'test', '2026-01-01')`, jobNo, status).lastInsertRowid;

const AUG = new Date(2026, 7, 15);   // 2026-08-15
const SEP = new Date(2026, 8, 1);    // 2026-09-01
const JAN = new Date(2027, 0, 1);    // 2027-01-01

test('a new month continues the year, it does not start again at 1', () => {
  card('2026/8/R/583');
  assert.strictEqual(nextJobNo('repair', SEP), '2026/9/R/584',
    'the whole complaint: September used to come back as 2026/9/R/1');
});

test('the month in the number is the month it was raised', () => {
  // Same counter, different month — the two halves of the number mean different things.
  assert.strictEqual(nextJobNo('repair', AUG), '2026/8/R/584');
  assert.strictEqual(nextJobNo('repair', SEP), '2026/9/R/584');
});

test('it keeps counting through several months', () => {
  card('2026/9/R/584'); card('2026/10/R/585'); card('2026/11/R/586');
  assert.strictEqual(nextJobNo('repair', new Date(2026, 11, 3)), '2026/12/R/587');
});

test('a new year starts again at 1', () => {
  // What the book has always done: 2025 ran to 920, 2026 opened at 1.
  assert.strictEqual(nextJobNo('repair', JAN), '2027/1/R/1');
});

test('and then continues through the new year', () => {
  card('2027/1/R/1');
  assert.strictEqual(nextJobNo('repair', new Date(2027, 1, 9)), '2027/2/R/2');
});

test('service cards count separately from repairs', () => {
  // Two books, two sequences. A service must not inherit the repair count.
  assert.strictEqual(nextJobNo('service', SEP), '2026/9/S/1');
  card('2026/9/S/1');
  assert.strictEqual(nextJobNo('service', new Date(2026, 9, 2)), '2026/10/S/2');
  assert.strictEqual(nextJobNo('repair', new Date(2026, 9, 2)), '2026/10/R/587',
    'and the repair count is untouched by the service one');
});

test('a number already used is stepped over rather than colliding', () => {
  // job_no is UNIQUE and the imported history is not ours to predict. A clash would surface as a
  // 500 on the Create button — nothing a person could act on.
  card('2026/12/R/588');
  const next = nextJobNo('repair', new Date(2026, 11, 20));
  assert.strictEqual(next, '2026/12/R/589');
  assert.strictEqual(get('SELECT 1 AS x FROM job_cards WHERE job_no = ?', next), undefined);
});

test('a differently-shaped number in the book is ignored, not misread', () => {
  // The history holds imported references that are not YYYY/M/L/seq at all.
  card('GENERAL-WS');
  card('C-4021');
  card('2026/9/RX/9999');
  assert.strictEqual(nextJobNo('repair', new Date(2026, 11, 21)), '2026/12/R/589',
    'RX is not R, and 9999 must not become the count');
});

test('another year in the book does not raise this year count', () => {
  card('2025/11/R/920');
  assert.strictEqual(nextJobNo('repair', new Date(2026, 11, 22)), '2026/12/R/589',
    '2025 reached 920 and that has nothing to do with 2026');
});

test('both routes mint numbers the same way', () => {
  // routes/jobcards.js and routes/jobrequests.js each carried their own copy — identical, and free
  // to drift, so a card raised from a job request could be numbered by whichever had been updated
  // last. They share this module now.
  const jobcards = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'jobcards.js'), 'utf8');
  const jobrequests = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'jobrequests.js'), 'utf8');
  for (const [name, src] of [['jobcards', jobcards], ['jobrequests', jobrequests]]) {
    assert.match(src, /lib\/jobno/, `${name}.js must use the shared generator`);
    assert.ok(!/function jobNo\s*\(/.test(src), `${name}.js still defines its own jobNo()`);
  }
});
