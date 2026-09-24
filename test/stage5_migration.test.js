'use strict';

// Stage 5: the saved daily reports were keyed UNIQUE(kind, report_date). The first start after the
// update rebuilds them keyed by (kind, report_date, workshop_id), every saved day kept as the whole
// company's (workshop 0); the monthly inputs already entered become the main workshop's. It runs once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s5m-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

{
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8')
    .replace(/CREATE TABLE IF NOT EXISTS daily_report_snapshots \([\s\S]*?\n\);\nCREATE INDEX IF NOT EXISTS idx_daily_snap[^\n]*\n/, `CREATE TABLE IF NOT EXISTS daily_report_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  report_date  TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_by INTEGER REFERENCES users(id),
  row_count    INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,
  UNIQUE(kind, report_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_snap ON daily_report_snapshots(kind, report_date DESC);
`);
  assert.ok(!/workshop_id/.test(schema.match(/CREATE TABLE IF NOT EXISTS daily_report_snapshots[\s\S]*?\);/)[0]));
  const raw = new Database(process.env.DB_PATH);
  raw.exec(schema);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`INSERT INTO workshops (id, code, name, is_default) VALUES (1, 'CW', 'Central Workshop — Badalgama', 1);
            INSERT INTO daily_report_snapshots (id, kind, report_date, row_count, payload) VALUES
              (3, 'pending_parts', '2026-09-01', 4, '{"as_of":"2026-09-01"}'), (8, 'job_summary', '2026-09-01', 2, '{"as_of":"2026-09-01"}');`);
  raw.close();
}

const { migrate, all, get, run } = require('../src/db');

test('the first start keys saved reports by workshop, keeping each as the whole company\'s; old inputs are the main workshop\'s', () => {
  run('SELECT 1');
  migrate();
  const sql = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_report_snapshots'").sql;
  assert.match(sql, /UNIQUE\(kind, report_date, workshop_id\)/);
  assert.deepStrictEqual(all('SELECT id, kind, report_date, workshop_id, row_count FROM daily_report_snapshots ORDER BY id'), [
    { id: 3, kind: 'pending_parts', report_date: '2026-09-01', workshop_id: 0, row_count: 4 },
    { id: 8, kind: 'job_summary', report_date: '2026-09-01', workshop_id: 0, row_count: 2 },
  ]);
  // A workshop's copy of the same day can now sit beside the company's.
  run("INSERT INTO daily_report_snapshots (kind, report_date, workshop_id, payload) VALUES ('pending_parts', '2026-09-01', 7, '{}')");
  assert.strictEqual(get("SELECT COUNT(*) n FROM daily_report_snapshots WHERE kind = 'pending_parts'").n, 2);
  // An input written without a workshop (a script, an import) is the main workshop's.
  run("INSERT INTO monthly_report_inputs (year, month, sheet, seq, label) VALUES (2026, 9, 'other', 0, 'x')");
  assert.strictEqual(get("SELECT workshop_id FROM monthly_report_inputs WHERE label = 'x'").workshop_id, 1);
});

test('it runs once', () => {
  const before = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_report_snapshots'").sql;
  migrate();
  assert.strictEqual(get("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_report_snapshots'").sql, before);
  assert.strictEqual(get('SELECT COUNT(*) n FROM daily_report_snapshots').n, 3);
});
