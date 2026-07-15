'use strict';

// Automatic timestamped DB snapshots with retention — mirrors the hourly/daily
// backups both source systems already run. Uses SQLite's online backup API.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');

function snapshot() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(config.backupDir, `workshopone-${stamp}.db`);
  return db
    .backup(dest)
    .then(() => {
      prune();
      return dest;
    })
    .catch((e) => console.error('Backup failed:', e.message));
}

function prune() {
  const files = fs
    .readdirSync(config.backupDir)
    .filter((f) => f.startsWith('workshopone-') && f.endsWith('.db'))
    .sort();
  const excess = files.length - config.backupRetention;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(config.backupDir, files[i]));
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

module.exports = { snapshot, startScheduler };
