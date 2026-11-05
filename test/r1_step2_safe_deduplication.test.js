'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-dedup-test-'));
process.env.DB_PATH = path.join(TMP, 'dedup.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';

const { migrate, db } = require('../src/db');
const dedup047 = require('../src/migrate/047_deduplicate_general_items');

test('migration 047 preserves filter receipt rows and preserves balance when no ledger row exists', () => {
  migrate();

  // 1. Create a filter store item with a receipt (not an issue)
  const filterItem = db.prepare(`
    INSERT INTO store_items (name, part_number, category, unit, balance, is_general)
    VALUES ('Air Filter Primary', 'FLT-001', 'Filters', 'nos', 10, 1)
  `).run().lastInsertRowid;

  const receiptTxnId = db.prepare(`
    INSERT INTO general_item_txns (store_item_id, txn_type, txn_date, qty, balance_after, ref)
    VALUES (?, 'receipt', date('now'), 10, 10, 'GRN-TEST-01')
  `).run(filterItem).lastInsertRowid;

  // 2. Create an item with existing balance but no ledger transactions
  const standaloneItem = db.prepare(`
    INSERT INTO store_items (name, part_number, category, unit, balance, is_general)
    VALUES ('Hydraulic Fitting', 'GEN-002', 'General', 'nos', 42, 1)
  `).run().lastInsertRowid;

  // 3. Create a product with existing stock_qty but no stock_ledger rows
  const standaloneProduct = db.prepare(`
    INSERT INTO products (code, name, category, unit, stock_qty, active)
    VALUES ('OIL-003', 'Special Grease', 'grease', 'kg', 88, 1)
  `).run().lastInsertRowid;

  // Run migration 047
  dedup047.runMigration(db);

  // Assertions:
  // A. Receipt row for filter MUST survive
  const receiptAfter = db.prepare('SELECT id FROM general_item_txns WHERE id = ?').get(receiptTxnId);
  assert.ok(receiptAfter, 'Receipt row for filter item must not be deleted by deduplication');

  // B. Store item balance without ledger row must NOT be set to 0
  const itemBalAfter = db.prepare('SELECT balance FROM store_items WHERE id = ?').get(standaloneItem).balance;
  assert.strictEqual(itemBalAfter, 42, 'Store item balance with no transactions must not be zeroed out');

  // C. Product stock_qty without ledger row must NOT be set to 0
  const prodQtyAfter = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(standaloneProduct).stock_qty;
  assert.strictEqual(prodQtyAfter, 88, 'Product stock_qty with no transactions must not be zeroed out');
});
