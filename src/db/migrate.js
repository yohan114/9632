'use strict';

// CLI: `npm run migrate`  (or `npm run migrate -- --reset` to drop the file first)
const fs = require('fs');
const config = require('../config');

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(config.dbPath + suffix);
    } catch {
      /* not present */
    }
  }
  console.log('Removed existing database file.');
}

const { migrate } = require('./index');
migrate();
console.log('Schema applied to', config.dbPath);
