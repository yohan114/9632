'use strict';

// Take a manual DB snapshot now (same routine the scheduler uses).
//   node scripts/backup.js
const { snapshot } = require('../src/lib/backup');

snapshot().then((dest) => {
  if (dest) console.log('Backup written:', dest);
  process.exit(dest ? 0 : 1);
});
