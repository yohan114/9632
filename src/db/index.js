'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// Ensure the data directory exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Apply the schema. Idempotent — every statement is CREATE ... IF NOT EXISTS.
 */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Upgrade-safe additive column checks (CREATE TABLE IF NOT EXISTS won't add
  // columns to a table that already exists).
  ensureColumn('job_cards', 'flat_labour', 'REAL');
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  // Phase 1 migration deltas (additive; CHECK relaxations live in schema.sql).
  ensureColumn('assets', 'in_register', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('assets', 'legacy_fleet_id', 'INTEGER');
  ensureColumn('projects', 'name_norm', 'TEXT');
  ensureColumn('mrn_lines', 'legacy_item_id', 'INTEGER');
  // Preserve the source item category on stores records (9-category breakdown).
  ensureColumn('mrn_lines', 'category', 'TEXT');
  ensureColumn('issues', 'category', 'TEXT');
  ensureColumn('mtn', 'category', 'TEXT');
  ensureColumn('mrn', 'purchase_source', 'TEXT'); // Head Office / Local Purchase / ...
  ensureColumn('general_item_txns', 'source', 'TEXT'); // import source tag (idempotent re-import)
  // Consolidated MRN item catalogue (deduped from mrn_lines descriptions).
  ensureColumn('store_items', 'item_no', 'TEXT');          // catalogue number, e.g. FIL-0001
  ensureColumn('store_items', 'catalogue_kind', 'TEXT');   // part | consumable | service
  ensureColumn('store_items', 'part_numbers', 'TEXT');     // all merged part/reference codes ( | -joined)
  ensureColumn('store_items', 'req_count', 'INTEGER');     // historical MRN request count
  ensureColumn('grn', 'purchase_source_norm', 'TEXT');
  ensureColumn('stock_ledger', 'consumer_type', 'TEXT');
  ensureColumn('stock_ledger', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('stock_ledger', 'legacy_id', 'INTEGER');
  ensureColumn('products', 'sheet_name', 'TEXT');
  ensureColumn('products', 'sort_order', 'INTEGER');
  ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('batteries', 'state_norm', 'TEXT');
  for (const c of ['diesel_filter', 'oil_filter', 'air_filter', 'trans_filter', 'hy_filter']) ensureColumn('service_specs', c, 'REAL');
  ensureColumn('job_cards', 'legacy_ref', 'TEXT');
  ensureColumn('job_cards', 'is_historical', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('job_cards', 'synthesized_no', 'INTEGER NOT NULL DEFAULT 0');
  // Cost reconciliation (Phase 1): freeze the imported recorded total once, and
  // carry a balancing bucket so labour+material+oil+general+external+other == total_cost.
  ensureColumn('job_cards', 'recorded_cost', 'REAL');   // original imported total; total falls back to computed when this is 0/NULL
  ensureColumn('job_cards', 'other_cost', 'REAL NOT NULL DEFAULT 0'); // total_cost − Σ(components) so columns always reconcile
  // Unambiguous link from a job_part to the MRN request line it came from (Phase 3):
  // avoids overloading the polymorphic source_id (a manual GRN part won't mislink to mrn_lines).
  ensureColumn('job_parts', 'mrn_line_id', 'INTEGER');
  return db;
}

function ensureColumn(table, col, def) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// Thin helpers so route code reads the same everywhere.
const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

/**
 * Run fn() inside a transaction. better-sqlite3 transactions are synchronous.
 */
function tx(fn) {
  return db.transaction(fn)();
}

module.exports = { db, migrate, get, all, run, tx };
