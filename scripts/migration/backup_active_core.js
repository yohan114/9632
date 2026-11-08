'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const srcPath = 'D:/Master system 1/data/core.db';
const backupPath = 'D:/Master system 1/data/core.pre-fuel-merge.20261108.db';

console.log('Backing up', srcPath, 'to', backupPath);
const srcDb = new Database(srcPath);
srcDb.backup(backupPath)
  .then(() => {
    console.log('Backup completed successfully to:', backupPath);
    srcDb.close();
  })
  .catch((err) => {
    console.error('Backup failed:', err);
    srcDb.close();
    process.exit(1);
  });
