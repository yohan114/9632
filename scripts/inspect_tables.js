const Database = require('better-sqlite3');
const db = new Database('d:/Master system 1/9632-Fuel-Merged/data/workshopone_merged.db');
const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all();
console.log('Total tables and views:', tables.length);
const matches = tables.filter(t => /fuel|tank|bill|hire|outsourc|costing|kpi|meter/i.test(t.name));
console.log('Matching tables/views:');
matches.forEach(m => console.log(`  [${m.type}] ${m.name}`));
