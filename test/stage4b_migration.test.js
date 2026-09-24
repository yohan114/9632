'use strict';

// Stage 4, part B: the first start after the update gives the main workshop its store and puts
// everything already recorded in it — every source of stock movements, and the movements
// themselves. Transfer notes already written stay paper. It runs once.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-s4bm-'));
process.env.DB_PATH = path.join(TMP, 'old.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');

{
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const raw = new Database(process.env.DB_PATH);
  raw.exec(schema);
  raw.pragma('foreign_keys = OFF');
  assert.ok(!raw.prepare('PRAGMA table_info(grn)').all().some((c) => c.name === 'store_id'));
  raw.exec(`INSERT INTO workshops (id, code, name, is_default) VALUES (1, 'CW', 'Central Workshop — Badalgama', 1), (2, 'MTR', 'Muthur Workshop', 0);
            INSERT INTO mrn (id, mrn_no) VALUES (1, 'OLD-1');
            INSERT INTO mrn_lines (id, mrn_id, description, qty) VALUES (1, 1, 'Old Part', 3);
            INSERT INTO grn (id, mrn_id, mrn_line_id, description, qty, delivery_date) VALUES (1, 1, 1, 'Old Part', 3, '2025-01-02');
            INSERT INTO issues (id, description, qty) VALUES (1, 'Old Part', 1);
            INSERT INTO mtn (id, mtn_no, txn_date, from_location, to_location) VALUES (1, 'MTN-1', '2025-02-01', 'Central', 'Muthur');
            INSERT INTO mtn_lines (id, mtn_id, description, qty) VALUES (1, 1, 'Old Part', 1);`);
  raw.close();
}

const { migrate, all, get } = require('../src/db');

test('the first start: the main workshop has its store, and everything already recorded is in it', () => {
  migrate();
  assert.deepStrictEqual(all('SELECT id, own_store, uses_store, store_opened FROM workshops ORDER BY id'), [
    { id: 1, own_store: 1, uses_store: null, store_opened: null },
    { id: 2, own_store: 0, uses_store: null, store_opened: null },
  ]);
  assert.strictEqual(get('SELECT store_id FROM grn WHERE id = 1').store_id, 1, 'an old receipt is in Central\'s store, where it was');
  assert.strictEqual(get('SELECT store_id FROM issues WHERE id = 1').store_id, 1);
  assert.deepStrictEqual(get('SELECT from_store_id, to_store_id FROM mtn_lines WHERE id = 1'), { from_store_id: null, to_store_id: null },
    'an old transfer note stays paper');
  const trig = all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%_store' ORDER BY name").map((r) => r.name);
  assert.deepStrictEqual(trig, ['trg_general_item_txns_store', 'trg_grn_store', 'trg_issues_store', 'trg_service_jobs_store',
    'trg_stock_ledger_store', 'trg_tyre_battery_issues_store']);
});

test('it runs once', () => {
  const before = all('SELECT id, own_store, uses_store, store_opened FROM workshops ORDER BY id');
  migrate();
  assert.deepStrictEqual(all('SELECT id, own_store, uses_store, store_opened FROM workshops ORDER BY id'), before);
  assert.strictEqual(get('SELECT COUNT(*) n FROM grn WHERE store_id IS NULL').n, 0);
});
