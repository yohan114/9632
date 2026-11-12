const Database = require('better-sqlite3');
const db = new Database('d:/Master system 1/9632-Fuel-Merged/data/workshopone_merged.db');
const sample = db.prepare('SELECT id, code, registration FROM assets LIMIT 5').all();
console.log('Sample assets:', sample);
