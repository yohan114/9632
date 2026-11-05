'use strict';

/**
 * Migration 050: Fabrication Job Type & In-place Job Cards Rebuild
 *
 * 1. job_requests:
 *    - Add fabrication_kind TEXT ('new', 'repair', 'service')
 *    - Add issue_store_location_id INTEGER REFERENCES store_locations(id)
 *
 * 2. job_cards:
 *    - Rebuild in place with CHECK (type IN ('repair', 'service', 'fabrication'))
 *    - Add fabrication_kind TEXT
 *    - Add issue_store_location_id INTEGER REFERENCES store_locations(id)
 *    - Preserve all IDs, data, indexes, triggers, sequence counter
 *    - PRAGMA foreign_key_check verified
 *
 * 3. settings:
 *    - fabrication.enabled = '0'
 *
 * Guarded by setting key 'migration_050_done'.
 * Runs across monolithic database (rawDb) and all workshop databases when multidb is active.
 */

const { rawDb, multidb } = require('../db');

function ensureCol(d, table, col, def) {
  const tbl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tbl) return;
  const exists = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[050] Added column ${col} to ${table}`);
  }
}

function rebuildJobCardsIfNeeded(targetDb, label) {
  const cur = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").get();
  if (!cur) return;

  // 1. Ensure columns exist on job_cards first
  ensureCol(targetDb, 'job_cards', 'fabrication_kind', 'TEXT');
  ensureCol(targetDb, 'job_cards', 'issue_store_location_id', 'INTEGER');

  // 2. Check if type CHECK constraint already allows 'fabrication'
  const refreshedCur = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_cards'").get();
  if (/'fabrication'/.test(refreshedCur.sql)) {
    console.log(`[050] job_cards in ${label} already allows 'fabrication'`);
    return;
  }

  // 3. Widen CHECK constraint on type
  const typeCheckRegex = /(CHECK\s*\(\s*type\s+IN\s*\(\s*'repair'\s*,\s*'service')(\s*\))/i;
  const generalCheckRegex = /(CHECK\s*\(\s*type\s+IN\s*\([^)]+)\)/i;

  let widened = null;
  if (typeCheckRegex.test(refreshedCur.sql)) {
    widened = refreshedCur.sql.replace(typeCheckRegex, "$1,'fabrication'$2");
  } else if (generalCheckRegex.test(refreshedCur.sql)) {
    widened = refreshedCur.sql.replace(generalCheckRegex, "$1,'fabrication')");
  }

  if (!widened) {
    console.log(`[050] job_cards in ${label} has no strict type check constraint to widen`);
    return;
  }

  const newTableSql = widened.replace(/^CREATE TABLE (IF NOT EXISTS )?("?)job_cards\2/i, 'CREATE TABLE tmp_job_cards');
  if (!/^CREATE TABLE tmp_job_cards/i.test(newTableSql)) {
    throw new Error(`[050] job_cards table definition could not be rewritten in ${label}`);
  }

  const cols = targetDb.prepare('PRAGMA table_info(job_cards)').all().map((c) => `"${c.name}"`).join(', ');
  const indexes = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='job_cards' AND sql IS NOT NULL").all();
  const triggers = targetDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='job_cards' AND sql IS NOT NULL").all();
  const otherTriggers = targetDb.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name != 'job_cards' AND sql LIKE '%job_cards%'").all();
  const seq = targetDb.prepare("SELECT seq FROM sqlite_sequence WHERE name='job_cards'").get();

  const dangling = () => targetDb.prepare('PRAGMA foreign_key_check').all().filter((r) => r.parent === 'job_cards').length;
  const beforeDangling = dangling();
  const count = targetDb.prepare('SELECT COUNT(*) n FROM job_cards').get().n;

  targetDb.pragma('foreign_keys = OFF');
  targetDb.pragma('legacy_alter_table = ON');
  try {
    targetDb.transaction(() => {
      // Temporarily drop other tables' triggers that reference job_cards to prevent compiler conflicts
      for (const t of otherTriggers) {
        targetDb.exec(`DROP TRIGGER IF EXISTS "${t.name}";`);
      }

      targetDb.exec(newTableSql);
      targetDb.exec(`INSERT INTO tmp_job_cards (${cols}) SELECT ${cols} FROM job_cards;`);
      targetDb.exec('DROP TABLE job_cards;');
      targetDb.exec('ALTER TABLE tmp_job_cards RENAME TO job_cards;');

      // Restore indexes and triggers
      for (const x of [...indexes, ...triggers, ...otherTriggers]) {
        if (x.sql) {
          try {
            targetDb.exec(x.sql);
          } catch (e) {
            // Ignore if trigger/index already restored
          }
        }
      }

      if (seq) {
        targetDb.prepare("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('job_cards', ?)").run(seq.seq);
      }

      const afterCount = targetDb.prepare('SELECT COUNT(*) n FROM job_cards').get().n;
      const afterDangling = dangling();

      if (afterCount !== count || afterDangling !== beforeDangling) {
        throw new Error(`[050] job_cards rebuild failed in ${label}: count mismatch or broken foreign keys (${beforeDangling}->${afterDangling}, rows ${count}->${afterCount})`);
      }
    })();
    console.log(`[050] Successfully rebuilt job_cards in ${label} with 'fabrication' constraint`);
  } finally {
    targetDb.pragma('legacy_alter_table = OFF');
    targetDb.pragma('foreign_keys = ON');
  }

  // Ensure standard indexes exist if columns are present
  const jcCols = targetDb.prepare('PRAGMA table_info(job_cards)').all().map((c) => c.name);
  if (jcCols.includes('asset_id')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_asset ON job_cards(asset_id);');
  if (jcCols.includes('status')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_cards(status);');
  if (jcCols.includes('project_id')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_project ON job_cards(project_id);');
  if (jcCols.includes('workshop_id')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_workshop ON job_cards(workshop_id);');
  if (jcCols.includes('field') && jcCols.includes('status')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_field ON job_cards(field, status);');
  if (jcCols.includes('job_request_id')) targetDb.exec('CREATE INDEX IF NOT EXISTS idx_jobs_job_request ON job_cards(job_request_id);');
}

function migrateSingleDb(targetDb, label) {
  console.log(`\n--- [050] Fabrication Job Type Migration for ${label} ---`);

  // 1. job_requests additions
  const jrExists = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_requests'").get();
  if (jrExists) {
    ensureCol(targetDb, 'job_requests', 'fabrication_kind', 'TEXT');
    ensureCol(targetDb, 'job_requests', 'issue_store_location_id', 'INTEGER');
  }

  // 2. job_cards rebuild
  rebuildJobCardsIfNeeded(targetDb, label);

  // 3. default settings
  const setTbl = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (setTbl) {
    targetDb.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fabrication.enabled', '0')").run();
  }

  console.log(`=== [050] Migration Completed for ${label} ===`);
}

function runMigration(optionalDb) {
  console.log('=== Running Migration 050: Fabrication Job Type & Cards Rebuild ===');

  if (optionalDb) {
    migrateSingleDb(optionalDb, 'Database instance');
  } else {
    migrateSingleDb(rawDb, 'Monolithic (rawDb)');
  }

  if (!optionalDb && multidb && multidb.isMultiDb()) {
    const wsList = multidb.listWorkshopDatabases();
    console.log(`Found ${wsList.length} workshop database(s).`);
    for (const ws of wsList) {
      multidb.withWorkshop(ws.id, () => {
        migrateSingleDb(multidb.activeDb(), `Workshop ${ws.code || ws.id}`);
      });
    }
    const core = multidb.getCoreDb();
    if (core && core !== rawDb) {
      const setTbl = core.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
      if (setTbl) {
        core.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fabrication.enabled', '0')").run();
      }
    }
  }

  console.log('=== Migration 050 Completed Successfully ===');
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration, rebuildJobCardsIfNeeded };
