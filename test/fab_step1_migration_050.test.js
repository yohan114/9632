'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const { runMigration, rebuildJobCardsIfNeeded } = require('../src/migrate/050_fabrication_job_type');

test('Migration 050: job_cards rebuild and fabrication columns', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `fab_mig_050_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  // Create minimal baseline with old schema where type is strictly ('repair', 'service')
  db.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL
    );
    CREATE TABLE workshops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      is_default INTEGER DEFAULT 0
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE job_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jr_no TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'repair',
      description TEXT
    );
    CREATE TABLE job_cards (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      job_no               TEXT NOT NULL UNIQUE,
      ref                  TEXT,
      asset_id             INTEGER REFERENCES assets(id),
      project_id           INTEGER REFERENCES projects(id),
      type                 TEXT NOT NULL DEFAULT 'repair' CHECK (type IN ('repair','service')),
      description          TEXT,
      status               TEXT NOT NULL DEFAULT 'REQUESTED',
      requested_by_user    INTEGER REFERENCES users(id),
      workshop_id          INTEGER REFERENCES workshops(id),
      job_request_id       INTEGER REFERENCES job_requests(id)
    );
    CREATE INDEX idx_jobs_asset ON job_cards(asset_id);
    CREATE INDEX idx_jobs_status ON job_cards(status);
    CREATE INDEX idx_jobs_workshop ON job_cards(workshop_id);
    CREATE TRIGGER trg_job_cards_workshop AFTER INSERT ON job_cards WHEN NEW.workshop_id IS NULL
    BEGIN
      UPDATE job_cards SET workshop_id = (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1) WHERE id = NEW.id;
    END;

    -- Referencing child table to ensure foreign keys stay intact
    CREATE TABLE job_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES job_cards(id),
      part_no TEXT
    );
  `);

  // Seed baseline data
  db.exec(`
    INSERT INTO workshops (code, name, is_default) VALUES ('CW', 'Central Workshop', 1);
    INSERT INTO assets (code) VALUES ('28-1111'), ('28-2222');
    INSERT INTO projects (name) VALUES ('CEP-03 Project');
    INSERT INTO users (username) VALUES ('test_mechanic');
    INSERT INTO job_requests (jr_no, type, description) VALUES ('JR-0001', 'repair', 'Clutch issue');
    INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, workshop_id, job_request_id)
      VALUES (10, '2026/1/R/10', 1, 1, 'repair', 'Repair engine', 1, 1);
    INSERT INTO job_cards (id, job_no, asset_id, project_id, type, description, workshop_id)
      VALUES (11, '2026/1/S/1', 2, 1, 'service', '10k service', 1);
    INSERT INTO job_materials (job_id, part_no) VALUES (10, 'P-FILTER-01'), (11, 'OIL-15W40');
  `);

  // Verify before state: inserting 'fabrication' fails CHECK constraint
  assert.throws(() => {
    db.prepare("INSERT INTO job_cards (job_no, type, description) VALUES ('2026/1/F/1', 'fabrication', 'Bucket fab')").run();
  }, /CHECK constraint failed/);

  const initialRows = db.prepare('SELECT COUNT(*) n FROM job_cards').get().n;
  assert.strictEqual(initialRows, 2);

  // Run migration 050
  runMigration(db);

  // 1. Check settings
  const fabSetting = db.prepare("SELECT value FROM settings WHERE key = 'fabrication.enabled'").get();
  assert.ok(fabSetting, 'fabrication.enabled setting must exist');
  assert.strictEqual(fabSetting.value, '0');

  // 2. Check job_requests new columns
  const jrCols = db.prepare('PRAGMA table_info(job_requests)').all().map((c) => c.name);
  assert.ok(jrCols.includes('fabrication_kind'), 'job_requests must have fabrication_kind');
  assert.ok(jrCols.includes('issue_store_location_id'), 'job_requests must have issue_store_location_id');

  // 3. Check job_cards new columns and preserved rows
  const jcCols = db.prepare('PRAGMA table_info(job_cards)').all().map((c) => c.name);
  assert.ok(jcCols.includes('fabrication_kind'), 'job_cards must have fabrication_kind');
  assert.ok(jcCols.includes('issue_store_location_id'), 'job_cards must have issue_store_location_id');

  const afterRows = db.prepare('SELECT COUNT(*) n FROM job_cards').get().n;
  assert.strictEqual(afterRows, 2, 'Row count must be preserved');

  const card10 = db.prepare('SELECT * FROM job_cards WHERE id = 10').get();
  assert.strictEqual(card10.job_no, '2026/1/R/10');
  assert.strictEqual(card10.type, 'repair');
  assert.strictEqual(card10.workshop_id, 1);

  // 4. Foreign keys integrity
  const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
  assert.strictEqual(fkErrors.length, 0, 'No foreign key errors after rebuild');

  // 5. Test type check constraint: accepts repair, service, fabrication; rejects others
  db.prepare(`
    INSERT INTO job_cards (job_no, type, fabrication_kind, issue_store_location_id, description)
    VALUES ('2026/1/F/1', 'fabrication', 'new', 1, 'Fab arm')
  `).run();

  const fabCard = db.prepare("SELECT * FROM job_cards WHERE job_no = '2026/1/F/1'").get();
  assert.strictEqual(fabCard.type, 'fabrication');
  assert.strictEqual(fabCard.fabrication_kind, 'new');
  assert.strictEqual(fabCard.issue_store_location_id, 1);

  assert.throws(() => {
    db.prepare("INSERT INTO job_cards (job_no, type, description) VALUES ('2026/1/X/1', 'overhaul', 'invalid')").run();
  }, /CHECK constraint failed/);

  // 6. Test triggers and sequence preservation
  db.prepare("INSERT INTO job_cards (job_no, type, description) VALUES ('2026/1/R/99', 'repair', 'Test trigger')").run();
  const createdCard = db.prepare("SELECT * FROM job_cards WHERE job_no = '2026/1/R/99'").get();
  assert.ok(createdCard, 'Card should be found by job_no');
  assert.strictEqual(createdCard.workshop_id, 1, 'Trigger must have set default workshop_id');

  // 7. Test Idempotency: running migration a second time doesn't break or duplicate anything
  runMigration(db);
  const recheckRows = db.prepare('SELECT COUNT(*) n FROM job_cards').get().n;
  assert.strictEqual(recheckRows, 4);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
