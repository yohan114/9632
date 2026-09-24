'use strict';

// Stage 6: parts brought back unused come off a job as a 'return' line on job_parts, whose
// source_type is a CHECK list. On an EXISTING database the first start after the update rebuilds
// the table in place (src/db/index.js, allowReturnParts): every line kept with its id, the
// indexes and the id counter kept, and the field columns added to the job cards. It runs once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s6m-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

// A database as it was before Stage 6: the same schema, without 'return' and the return notes.
const oldSchema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8')
  .replace("'external','return')", "'external')")
  .replace(/CREATE TABLE IF NOT EXISTS issue_returns \([\s\S]*?\n\);\nCREATE INDEX IF NOT EXISTS idx_issue_returns[^\n]*\n/, '');
assert.ok(!/'return'|issue_returns/.test(oldSchema), 'the old schema has neither');
{
  const raw = new Database(process.env.DB_PATH);
  raw.pragma('foreign_keys = ON');
  raw.exec(oldSchema);
  raw.exec('ALTER TABLE job_parts ADD COLUMN mrn_line_id INTEGER');          // a column added later, as on the live server
  raw.exec('CREATE INDEX idx_jp_line ON job_parts(mrn_line_id)');
  raw.exec("INSERT INTO assets (id, code, code_norm) VALUES (1, 'AC-06', 'AC06')");
  raw.exec("INSERT INTO job_cards (id, job_no, asset_id, description, status) VALUES (5, '2026/9/R/5', 1, 'x', 'IN_PROGRESS')");
  for (const [id, type, qty, line] of [[2, 'external', 1, null], [9, 'issue', 3, 44], [15, 'grn', 1, 45]]) {
    raw.prepare("INSERT INTO job_parts (id, job_id, source_type, description, qty, unit_price, mrn_line_id) VALUES (?, 5, ?, 'Seal', ?, 100, ?)").run(id, type, qty, line);
  }
  raw.prepare("INSERT INTO job_parts (id, job_id, source_type, description) VALUES (30, 5, 'external', 'gone')").run();
  raw.prepare('DELETE FROM job_parts WHERE id = 30').run();                    // the counter stays at 30
  raw.prepare("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (5, '2026-09-02', 'Anura', 4)").run();
  assert.throws(() => raw.prepare("INSERT INTO job_parts (job_id, source_type, qty) VALUES (5, 'return', -1)").run(), /CHECK constraint/);
  raw.close();
}

const { migrate, get, all, run } = require('../src/db');

test('the first start lets a return line in, keeping every line, index and the id counter', () => {
  migrate();
  const sql = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_parts'").sql;
  assert.match(sql, /'return'/);
  assert.match(sql, /mrn_line_id/, 'the column added after the table was made survives');
  assert.deepStrictEqual(all('SELECT id, source_type, qty, mrn_line_id FROM job_parts ORDER BY id').map((r) => [r.id, r.source_type, r.qty, r.mrn_line_id]),
    [[2, 'external', 1, null], [9, 'issue', 3, 44], [15, 'grn', 1, 45]]);
  const idx = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_parts'").map((r) => r.name);
  for (const n of ['idx_job_parts_job', 'idx_jp_line']) assert.ok(idx.includes(n), n);
  assert.strictEqual(get("SELECT seq FROM sqlite_sequence WHERE name = 'job_parts'").seq, 30);
  const next = run("INSERT INTO job_parts (job_id, source_type, description, qty, unit_price) VALUES (5, 'return', 'Seal', -1, 100)").lastInsertRowid;
  assert.strictEqual(next, 31, "a deleted line's id is not handed out again");
  assert.deepStrictEqual(all('PRAGMA foreign_key_check'), []);
  assert.strictEqual(get('PRAGMA foreign_keys').foreign_keys, 1, 'foreign keys are back on');
  // The return notes can point at the new line.
  assert.ok(get("SELECT 1 x FROM sqlite_master WHERE name = 'issue_returns'"));
  // The job cards and daily work have their field columns, empty on the cards already there.
  const card = get('SELECT field, breakdown, field_place, reported_at, arrived_at, working_at, field_km, field_km_rate FROM job_cards WHERE id = 5');
  assert.deepStrictEqual({ ...card }, { field: 0, breakdown: 0, field_place: null, reported_at: null, arrived_at: null, working_at: null, field_km: null, field_km_rate: null });
  assert.strictEqual(get('SELECT travel FROM job_daily_work WHERE job_id = 5').travel, 0);
});

test('it runs once: the next start leaves the table alone', () => {
  const before = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_parts'").sql;
  migrate();
  assert.strictEqual(get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_parts'").sql, before);
  assert.strictEqual(get("SELECT COUNT(*) n FROM job_parts WHERE source_type = 'return'").n, 1);
});
