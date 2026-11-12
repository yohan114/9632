const Database = require('better-sqlite3');
const db = new Database('d:/Master system 1/9632-Fuel-Merged/data/workshopone_merged.db');
const ftCount = db.prepare("SELECT count(*) as count FROM fuel_tanks").get().count;
const btCount = db.prepare("SELECT count(*) as count FROM bulk_tanks").get().count;
console.log('fuel_tanks count:', ftCount, 'bulk_tanks count:', btCount);
