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
