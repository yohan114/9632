const path = require('path');
process.env.PORT = '1949';
process.env.NODE_ENV = 'production';

console.log('--- RUNNING DB MIGRATION ON WORKSHOPONE_MERGED.DB ---');
const dbModule = require('../src/db');
console.log('Calling migrate()...');
dbModule.migrate();
console.log('migrate() completed successfully!');
