'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { CORE_TABLES, WS_TABLES, stripCoreForeignKeys, WS_REWRITTEN_TRIGGERS } = require('./split_database');

const db = new Database(config.dbPath);
const tableSchemas = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
const indexSchemas = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
const triggerSchemas = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();

const coreSet = new Set(CORE_TABLES);
const wsSet = new Set(WS_TABLES);

let coreSql = '-- WorkshopOne Core Schema (36 Shared Tables + Architecture Tables)\n\n';
for (const t of tableSchemas) {
  if (coreSet.has(t.name)) {
    coreSql += t.sql + ';\n\n';
  }
}

coreSql += `
CREATE TABLE IF NOT EXISTS workshop_databases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL UNIQUE,
  code         TEXT NOT NULL UNIQUE,
  db_file      TEXT NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  state        TEXT NOT NULL DEFAULT 'live',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at  TEXT
);

CREATE TABLE IF NOT EXISTS workshop_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL UNIQUE,
  wrapped_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at   TEXT
);

CREATE TABLE IF NOT EXISTS store_access_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id  INTEGER NOT NULL REFERENCES workshops(id),
  store_id     INTEGER NOT NULL,
  can_view     INTEGER NOT NULL DEFAULT 1,
  can_request  INTEGER NOT NULL DEFAULT 1,
  can_draw     INTEGER NOT NULL DEFAULT 0,
  covering     TEXT NOT NULL DEFAULT 'all',
  item_keys    TEXT,
  line_limit   REAL,
  monthly_limit REAL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  granted_by   INTEGER NOT NULL REFERENCES users(id),
  approved_by  INTEGER REFERENCES users(id),
  state        TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_access_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id    INTEGER NOT NULL REFERENCES store_access_grants(id),
  transfer_id TEXT,
  item_key    TEXT,
  qty         REAL,
  cost        REAL,
  month       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicle_holds (
  asset_id     INTEGER PRIMARY KEY,
  workshop_id  INTEGER NOT NULL,
  job_id       INTEGER NOT NULL,
  job_no       TEXT NOT NULL,
  claimed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id           TEXT PRIMARY KEY,
  from_ws      INTEGER NOT NULL,
  to_ws        INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  dispatched_at TEXT,
  accepted_at  TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integrity_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  passed      INTEGER NOT NULL,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  report_json TEXT NOT NULL
);
`;

for (const idx of indexSchemas) {
  if (coreSet.has(idx.tbl_name)) coreSql += idx.sql + ';\n';
}
for (const trg of triggerSchemas) {
  if (coreSet.has(trg.tbl_name)) coreSql += trg.sql + ';\n';
}

let wsSql = '-- WorkshopOne Per-Workshop Schema (70 Workshop Tables + Meta)\n\n';
for (const t of tableSchemas) {
  if (wsSet.has(t.name)) {
    wsSql += stripCoreForeignKeys(t.sql, coreSet) + ';\n\n';
  }
}

wsSql += `
CREATE TABLE IF NOT EXISTS ws_meta (
  workshop_id INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  store_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

for (const idx of indexSchemas) {
  if (wsSet.has(idx.tbl_name)) wsSql += idx.sql + ';\n';
}
for (const trg of triggerSchemas) {
  if (wsSet.has(trg.tbl_name)) {
    const rewritten = WS_REWRITTEN_TRIGGERS[trg.name] || trg.sql;
    wsSql += rewritten + ';\n';
  }
}

fs.writeFileSync(path.join(__dirname, '../src/db/core_schema.sql'), coreSql);
fs.writeFileSync(path.join(__dirname, '../src/db/ws_schema.sql'), wsSql);
console.log('Saved src/db/core_schema.sql and src/db/ws_schema.sql successfully!');
db.close();
