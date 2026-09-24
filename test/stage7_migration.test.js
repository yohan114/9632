'use strict';

// Stage 7 on an EXISTING database: the machines get a site column (empty), the move and handover
// tables appear, and every machine stays where it was. It runs once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s7m-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

// A database as it was before Stage 7: the same schema, without its two tables.
const oldSchema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8')
  .replace(/-- Stage 7: every move of a machine[\s\S]*$/, '');
assert.ok(!/asset_moves|job_workshop_moves/.test(oldSchema), 'the old schema has neither table');
{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(oldSchema);
  raw.exec("INSERT INTO projects (id, name) VALUES (4, 'Iginimitiya Project')");
  raw.exec(`INSERT INTO assets (id, code, code_norm, current_project_id, in_register) VALUES (7, 'EX-7', 'EX7', 4, 1), (8, 'EX-8', 'EX8', NULL, 1)`);
  assert.ok(!raw.prepare('PRAGMA table_info(assets)').all().some((c) => c.name === 'current_site_id'));
  raw.close();
}

const { migrate, get, all } = require('../src/db');

test('the first start adds the site column and the two tables; every machine stays where it was', () => {
  migrate();
  assert.ok(all('PRAGMA table_info(assets)').some((c) => c.name === 'current_site_id'));
  for (const t of ['asset_moves', 'job_workshop_moves']) assert.ok(get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?", t), t);
  assert.deepStrictEqual(all('SELECT id, current_project_id, current_site_id FROM assets ORDER BY id').map((a) => ({ ...a })),
    [{ id: 7, current_project_id: 4, current_site_id: null }, { id: 8, current_project_id: null, current_site_id: null }]);
  assert.strictEqual(get('SELECT COUNT(*) n FROM asset_moves').n, 0, 'no move is made up for the past');
  // The fleet board reads the machines where they are.
  const b = require('../src/lib/operations').fleet({ id: 0, roles: ['admin'] });
  assert.deepStrictEqual(b.rows.map((r) => [r.key, r.machines]), [['p:4', 1], [null, 1]]);
});

test('it runs once: the next start changes nothing', () => {
  const before = all("SELECT name, sql FROM sqlite_master WHERE name IN ('assets', 'asset_moves', 'job_workshop_moves') ORDER BY name");
  migrate();
  assert.deepStrictEqual(all("SELECT name, sql FROM sqlite_master WHERE name IN ('assets', 'asset_moves', 'job_workshop_moves') ORDER BY name"), before);
});
