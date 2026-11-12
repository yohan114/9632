const Database = require('better-sqlite3');
const db = new Database('d:/Master system 1/9632-Fuel-Merged/data/workshopone_merged.db');
console.log('fuel_tanks columns:', db.pragma('table_info(fuel_tanks)').map(c => c.name).join(', '));
console.log('bulk_tanks columns:', db.pragma('table_info(bulk_tanks)').map(c => c.name).join(', '));
