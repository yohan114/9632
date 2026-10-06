'use strict';

// A core.db file sitting beside the live database must not switch the running app to
// multi-database mode on its own. Only MULTIDB=1 (or a caller naming the target directory) does.

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-multidb-optin-'));
process.env.DB_PATH = path.join(TMP, 'workshopone.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '';

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// A stray core.db, as a trial split would leave it.
new Database(path.join(TMP, 'core.db')).close();

const { multidb } = require('../src/db');
const workshops = require('../src/lib/workshops');

test('a stray core.db does not turn multi-database mode on', () => {
  assert.strictEqual(multidb.isMultiDb(), false);
});

test('MULTIDB=1 with no core.db stays single-database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-multidb-none-'));
  process.env.MULTIDB = '1';
  try {
    // init() with no target dir reads the configured DB path, whose folder HAS a core.db, so point
    // the module at an empty folder through the explicit argument and switch the env back off.
    multidb.init(null, dir);
    assert.strictEqual(multidb.isMultiDb(), false, 'no core.db there');
  } finally {
    process.env.MULTIDB = '';
  }
});

test('MULTIDB=1 with a core.db present does turn it on', () => {
  process.env.MULTIDB = '1';
  try {
    multidb.init(null, null);
    assert.strictEqual(multidb.isMultiDb(), true);
  } finally {
    process.env.MULTIDB = '';
    multidb.init(null, null);
  }
  assert.strictEqual(multidb.isMultiDb(), false, 'and off again without it');
});

test('with multi-database off, adding a workshop writes to the one live database', () => {
  require('../src/db').migrate();
  const before = workshops.list().length;
  const w = workshops.create({ id: null }, { code: 'OPT1', name: 'Opt-in Check' });
  assert.ok(w && w.id);
  assert.strictEqual(workshops.list().length, before + 1);
  assert.ok(!fs.existsSync(path.join(TMP, 'workshops', 'OPT1.db')), 'no per-workshop file was provisioned');
});
