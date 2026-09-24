'use strict';

// The last result of each backup job, kept beside the backups themselves.
//
// A backup that fails quietly is worse than none, because everyone believes it is there. Until now
// the only record of a failed snapshot or a failed mirror copy was one line in the server log, and
// the restore check printed its verdict to a terminal nobody was watching. This file is where each
// job writes how it went, so /api/health can tell an admin at a glance.
//
// No database access here on purpose: scripts/restore.js must be able to record its verdict while
// the server is stopped, and must never open the live database to do it.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = () => path.join(config.backupDir, 'backup-status.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

/** Merge one job's result into the status file. Never throws — a status write must not fail a backup. */
function write(key, value) {
  try {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const next = { ...read(), [key]: { ...value, at: new Date().toISOString() } };
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE()); // whole file or nothing: a crash mid-write cannot leave half a JSON
  } catch (e) {
    console.error('Could not record backup status:', e.message);
  }
}

/** Newest snapshot on disk, by name (names are ISO timestamps). */
function newestSnapshot(prefix = 'workshopone-') {
  try {
    const files = fs.readdirSync(config.backupDir).filter((f) => f.startsWith(prefix) && f.endsWith('.db')).sort();
    if (!files.length) return null;
    const name = files[files.length - 1];
    const st = fs.statSync(path.join(config.backupDir, name));
    return { name, bytes: st.size, ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000) };
  } catch { return null; }
}

/** The summary /api/health shows an admin. */
function summary() {
  const s = read();
  const newest = newestSnapshot();
  const intervalMin = config.backupIntervalMinutes || 0;
  // "Stale" = more than two missed intervals. With snapshots every 30 minutes, an hour and a half
  // without one means the scheduler, the disk or the database is in trouble.
  const stale = intervalMin > 0 && (!newest || newest.ageMinutes > intervalMin * 3);
  const verifyAgeDays = s.verify && s.verify.at ? (Date.now() - Date.parse(s.verify.at)) / 86400000 : null;
  return {
    newest_snapshot: newest,
    snapshot_stale: stale,
    last_snapshot: s.snapshot || null,
    last_verify: s.verify || null,
    // The restore check runs weekly. Older than 8 days means the timer is not running.
    verify_overdue: verifyAgeDays == null || verifyAgeDays > 8,
    ok: !stale && !!(s.snapshot && s.snapshot.ok) && !!(s.verify && s.verify.ok) && verifyAgeDays <= 8
      && !(s.snapshot && s.snapshot.mirror && s.snapshot.mirror.ok === false),
  };
}

module.exports = { read, write, summary, newestSnapshot, FILE };
