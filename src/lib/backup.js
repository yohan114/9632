'use strict';

// Automatic timestamped DB snapshots with retention, optionally mirrored to a
// second location (external drive / network share). Uses SQLite's online backup
// API so snapshots are consistent even while the server is writing.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');

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
      if (config.backupMirrorDir) {
        try {
          fs.mkdirSync(config.backupMirrorDir, { recursive: true });
          fs.copyFileSync(dest, path.join(config.backupMirrorDir, name));
          prune(config.backupMirrorDir);
        } catch (e) {
          console.error('Backup mirror failed:', e.message);
        }
      }
      return dest;
    })
    .catch((e) => console.error('Backup failed:', e.message));
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
