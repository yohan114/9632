'use strict';
const Database = require('../node_modules/better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/workshopone_merged.db'), { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);

console.log('Tables in workshopone_merged.db (' + tables.length + '):');
for (const t of tables) {
  const cols = db.prepare("PRAGMA table_info(" + t + ")").all().map(c => c.name);
  const count = db.prepare("SELECT count(*) as c FROM " + t).get().c;
  console.log(`- ${t} (${cols.length} cols, ${count} rows): ${cols.slice(0, 8).join(', ')}...`);
}
