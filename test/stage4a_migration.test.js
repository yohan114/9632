'use strict';

// Stage 4: workday_signoffs was made with work_date UNIQUE. The first start after the update
// rebuilds it keyed by (work_date, workshop_id), every existing sign-off kept as the whole
// company's (workshop 0) — and it runs once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s4am-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

{
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8')
    .replace(/CREATE TABLE IF NOT EXISTS workday_signoffs \([\s\S]*?\n\);/, `CREATE TABLE IF NOT EXISTS workday_signoffs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date     TEXT NOT NULL UNIQUE,
  signed_by     INTEGER REFERENCES users(id),
  signed_at     TEXT,
  unlocked_by   INTEGER REFERENCES users(id),
  unlocked_at   TEXT,
  unlock_reason TEXT
);`);
  assert.ok(!/workshop_id   INTEGER NOT NULL DEFAULT 0/.test(schema.match(/CREATE TABLE IF NOT EXISTS workday_signoffs[\s\S]*?\);/)[0]));
  const raw = new Database(process.env.DB_PATH);
  raw.exec(schema);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`INSERT INTO workday_signoffs (id, work_date, signed_at) VALUES (4, '2026-09-01', '2026-09-02 08:00:00');
            INSERT INTO workday_signoffs (id, work_date, signed_at, unlocked_at, unlock_reason) VALUES (9, '2026-09-02', '2026-09-03 08:00:00', '2026-09-03 09:00:00', 'fix');`);
  raw.close();
}

const { migrate, all, get, run } = require('../src/db');

test('the first start keys sign-offs by workshop, keeping each as the whole company\'s', () => {
  migrate();
  const sql = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='workday_signoffs'").sql;
  assert.match(sql, /UNIQUE \(work_date, workshop_id\)/);
  assert.deepStrictEqual(all('SELECT id, work_date, workshop_id, signed_at, unlocked_at, unlock_reason FROM workday_signoffs ORDER BY id'), [
    { id: 4, work_date: '2026-09-01', workshop_id: 0, signed_at: '2026-09-02 08:00:00', unlocked_at: null, unlock_reason: null },
    { id: 9, work_date: '2026-09-02', workshop_id: 0, signed_at: '2026-09-03 08:00:00', unlocked_at: '2026-09-03 09:00:00', unlock_reason: 'fix' },
  ]);
  // Two workshops may now sign off the same day.
  run("INSERT INTO workday_signoffs (work_date, workshop_id, signed_at) VALUES ('2026-09-01', 7, datetime('now'))");
  assert.strictEqual(get("SELECT COUNT(*) n FROM workday_signoffs WHERE work_date = '2026-09-01'").n, 2);
});

test('it runs once', () => {
  const before = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='workday_signoffs'").sql;
  migrate();
  assert.strictEqual(get("SELECT sql FROM sqlite_master WHERE type='table' AND name='workday_signoffs'").sql, before);
  assert.strictEqual(get('SELECT COUNT(*) n FROM workday_signoffs').n, 3);
});
