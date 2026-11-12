'use strict';
const Database = require('../node_modules/better-sqlite3');
const path = require('path');

function inspectDb(file) {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    const counts = {};
    for (const t of tables) {
      try {
        counts[t] = db.prepare('SELECT count(*) as c FROM ' + t).get().c;
      } catch (e) {
        counts[t] = 'err: ' + e.message;
      }
    }
    db.close();
    return { tableCount: tables.length, counts };
  } catch(e) {
    return { error: e.message };
  }
}

console.log('=== 1. ./data/workshopone.db ===');
console.log(inspectDb(path.resolve('./data/workshopone.db')));

console.log('=== 2. ./data/core.db ===');
console.log(inspectDb(path.resolve('./data/core.db')));

console.log('=== 3. ./data/workshops/CW.db ===');
console.log(inspectDb(path.resolve('./data/workshops/CW.db')));

console.log('=== 4. ./Fuel-System-V2/data/app.db ===');
console.log(inspectDb(path.resolve('./Fuel-System-V2/data/app.db')));
