'use strict';

// Automatic timestamped DB snapshots with retention, optionally mirrored to a
// second location (external drive / network share). Uses SQLite's online backup
// API so snapshots are consistent even while the server is writing.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const status = require('./backup_status');

const PREFIX = 'workshopone-';

function snapshot() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${PREFIX}${stamp}.db`;
  const dest = path.join(config.backupDir, name);
  return db
    .backup(dest)
    .then(() => {
      prune(config.backupDir);
      // Mirror to the second location if configured.
      let mirror = null;
      if (config.backupMirrorDir) {
        try {
          fs.mkdirSync(config.backupMirrorDir, { recursive: true });
          fs.copyFileSync(dest, path.join(config.backupMirrorDir, name));
          prune(config.backupMirrorDir);
          mirror = { ok: true };
        } catch (e) {
          // An unplugged drive or a dropped share used to show up only as this log line, so the
          // "second copy" could be missing for weeks. It is now in the status /api/health reports.
          console.error('Backup mirror failed:', e.message);
          mirror = { ok: false, error: e.message };
        }
      }
      status.write('snapshot', { ok: true, file: name, bytes: fs.statSync(dest).size, mirror });
      return dest;
    })
    .catch((e) => {
      console.error('Backup failed:', e.message);
      status.write('snapshot', { ok: false, error: e.message });
    });
}

function prune(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
    .sort();
  const excess = files.length - config.backupRetention;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(dir, files[i]));
    } catch {
      /* ignore */
    }
  }
}

function startScheduler() {
  if (!config.backupIntervalMinutes) return null;
  const ms = config.backupIntervalMinutes * 60 * 1000;
  const timer = setInterval(snapshot, ms);
  timer.unref();
  return timer;
}

module.exports = { snapshot, startScheduler, PREFIX };
