'use strict';

/**
 * Migration 048: Service Job Requests, Service Records Linking & Daily Workdone Service Tracking.
 *
 * 1. job_requests:
 *    - service_type TEXT (e.g. '5000km', '10000km', '250hr', 'General Service')
 *    - meter_reading TEXT (odometer km or engine hour reading)
 *    - service_id INTEGER (links to fulfilled service_jobs.id)
 *
 * 2. service_jobs:
 *    - job_request_id INTEGER (links to initiating job_requests.id)
 *
 * 3. job_daily_work:
 *    - service_id INTEGER (links to service_jobs.id when work is done on a service)
 *    - work_type TEXT DEFAULT 'repair' ('repair', 'service', 'general')
 *
 * Runs across both monolithic database (rawDb) and all workshop databases when multidb is active.
 * Idempotent: safe to run on every boot / deploy.
 */

const { rawDb, multidb } = require('../db');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`Added column ${col} to ${table}`);
  }
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [048] Service Requests & Daily Workdone Migration for ${label} ---`);

  // 1. job_requests additions
  ensureCol(targetDb, 'job_requests', 'service_type', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'meter_reading', 'TEXT');
  ensureCol(targetDb, 'job_requests', 'service_id', 'INTEGER');

  // 2. service_jobs additions
  ensureCol(targetDb, 'service_jobs', 'job_request_id', 'INTEGER');

  // 3. job_daily_work additions
  ensureCol(targetDb, 'job_daily_work', 'service_id', 'INTEGER');
  ensureCol(targetDb, 'job_daily_work', 'work_type', "TEXT DEFAULT 'repair'");

  // 4. Indexes
  targetDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_jr_service_id ON job_requests(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_jobs_jr ON service_jobs(job_request_id);
    CREATE INDEX IF NOT EXISTS idx_jdw_service ON job_daily_work(service_id);
    CREATE INDEX IF NOT EXISTS idx_jdw_work_type ON job_daily_work(work_type);
  `);

  console.log(`=== [048] Migration Completed for ${label} ===`);
}

function runMigration(optionalDb) {
  console.log('=== Running Migration 048: Service Requests & Daily Work Tracking ===');

  if (optionalDb) {
    migrateSingleDb(optionalDb, 'Database instance');
  } else {
    migrateSingleDb(rawDb, 'Monolithic (rawDb)');
  }

  if (multidb.isMultiDb()) {
    const wsList = multidb.listWorkshopDatabases();
    console.log(`Found ${wsList.length} workshop database(s).`);
    for (const ws of wsList) {
      multidb.withWorkshop(ws.id, () => {
        migrateSingleDb(multidb.activeDb(), `Workshop ${ws.code || ws.id}`);
      });
    }
  }

  console.log('=== Migration 048 Completed Successfully ===');
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
