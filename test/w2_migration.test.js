'use strict';

// W2 — the job_cards status constraint gains PARTIALLY_CLOSED on an EXISTING database.
//
// SQLite cannot change a CHECK, so the table is rebuilt in place on the first start after the
// update (src/db/index.js, allowPartiallyClosed). What must survive: every card with its id, every
// row that points at a card, the indexes, and the id counter — a deleted card's number is not
// handed out again. And it must run once, not on every start.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-w2m-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

// A database as it was before W2: the same schema, with the old status list.
const oldSchema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8')
  .replace("'WORK_COMPLETE','PARTIALLY_CLOSED','CLOSED'", "'WORK_COMPLETE','CLOSED'");
assert.ok(!/PARTIALLY_CLOSED/.test(oldSchema.match(/CREATE TABLE IF NOT EXISTS job_cards[\s\S]*?\);/)[0]));
{
  const raw = new Database(process.env.DB_PATH);
  raw.pragma('foreign_keys = ON');
  raw.exec(oldSchema);
  raw.exec("ALTER TABLE job_cards ADD COLUMN original_completed_at TEXT");   // a column added later, as on the live server
  raw.exec("INSERT INTO assets (id, code, code_norm) VALUES (1, 'AC-06', 'AC06')");
  for (const [id, no, st] of [[3, '2026/7/R/10', 'CLOSED'], [7, '2026/8/R/11', 'IN_PROGRESS'], [12, '2026/9/R/12', 'WORK_COMPLETE']]) {
    raw.prepare("INSERT INTO job_cards (id, job_no, asset_id, description, status, original_completed_at) VALUES (?, ?, 1, 'x', ?, '2026-07-31')").run(id, no, st);
  }
  raw.prepare("INSERT INTO job_cards (id, job_no, description) VALUES (40, 'DELETED', 'x')").run();
  raw.prepare('DELETE FROM job_cards WHERE id = 40').run();                   // the counter stays at 40
  raw.prepare("INSERT INTO job_daily_work (job_id, work_date, mechanic, hours) VALUES (7, '2026-08-02', 'Anura', 4)").run();
  raw.prepare("INSERT INTO job_parts (job_id, source_type, description, qty) VALUES (12, 'external', 'Seal', 1)").run();
  assert.throws(() => raw.prepare("UPDATE job_cards SET status = 'PARTIALLY_CLOSED' WHERE id = 7").run(), /CHECK constraint/);
  raw.close();
}

const { migrate, get, all, run } = require('../src/db');

test('the first start widens the status, keeping every card, reference, index and the id counter', () => {
  migrate();
  const sql = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").sql;
  assert.match(sql, /'PARTIALLY_CLOSED'/);
  assert.match(sql, /original_completed_at/, 'the column added after the table was made survives');
  assert.deepStrictEqual(all('SELECT id, job_no, status, original_completed_at FROM job_cards ORDER BY id').map((r) => [r.id, r.job_no, r.status, r.original_completed_at]),
    [[3, '2026/7/R/10', 'CLOSED', '2026-07-31'], [7, '2026/8/R/11', 'IN_PROGRESS', '2026-07-31'], [12, '2026/9/R/12', 'WORK_COMPLETE', '2026-07-31']]);
  assert.strictEqual(get('SELECT j.job_no n FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id').n, '2026/8/R/11');
  assert.strictEqual(get('SELECT j.job_no n FROM job_parts p JOIN job_cards j ON j.id = p.job_id').n, '2026/9/R/12');
  const idx = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_cards'").map((r) => r.name);
  for (const n of ['idx_jobs_asset', 'idx_jobs_status', 'idx_jobs_project']) assert.ok(idx.includes(n), n);
  assert.strictEqual(get("SELECT seq FROM sqlite_sequence WHERE name = 'job_cards'").seq, 40);
  const next = run("INSERT INTO job_cards (job_no, description) VALUES ('NEW', 'x')").lastInsertRowid;
  assert.strictEqual(next, 41, "a deleted card's id is not handed out again");
  assert.deepStrictEqual(all('PRAGMA foreign_key_check'), []);
  assert.strictEqual(get('PRAGMA foreign_keys').foreign_keys, 1, 'foreign keys are back on');
  run("UPDATE job_cards SET status = 'PARTIALLY_CLOSED' WHERE id = 7");
  assert.strictEqual(get('SELECT status s FROM job_cards WHERE id = 7').s, 'PARTIALLY_CLOSED');
  for (const c of ['partial_closed_at', 'partial_closed_by', 'partial_note', 'continues_job_id']) {
    assert.ok(all('PRAGMA table_info(job_cards)').some((x) => x.name === c), c);
  }
  assert.ok(get("SELECT 1 x FROM sqlite_master WHERE name = 'job_reopen_requests'"));
});

test('it runs once: the next start leaves the table alone', () => {
  const before = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").sql;
  run("INSERT INTO job_cards (job_no, description, status) VALUES ('AFTER', 'x', 'PARTIALLY_CLOSED')");
  migrate();
  assert.strictEqual(get("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").sql, before);
  assert.strictEqual(get("SELECT status s FROM job_cards WHERE job_no = 'AFTER'").s, 'PARTIALLY_CLOSED');
});
