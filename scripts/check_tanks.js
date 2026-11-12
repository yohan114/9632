const Database = require('better-sqlite3');
const db = new Database('d:/Master system 1/9632-Fuel-Merged/data/workshopone_merged.db');
const ft = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('fuel_tanks', 'bulk_tanks')").all();
console.log('Tanks tables/views found:', ft);
