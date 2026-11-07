'use strict';

// The last result of each backup job, kept beside the backups themselves.
//
// A backup that fails quietly is worse than none, because everyone believes it is there. Until now
// the only record of a failed snapshot or a failed mirror copy was one line in the server log, and
// the restore check printed its verdict to a terminal nobody was watching. This file is where each
// job writes how it went, so /api/health can tell an admin at a glance.
//
// Supports both single-database snapshots (workshopone-*.db) and coordinated multi-database
// snapshot bundles (workshopone-*/ containing core.db and workshops/*.db).

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
    if (!fs.existsSync(config.backupDir)) return null;
    const entries = fs.readdirSync(config.backupDir, { withFileTypes: true });
    const candidates = entries
      .filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('.manifest.json') && !e.name.endsWith('.tmp') && e.name !== 'backup-status.json')
      .map((e) => e.name)
      .sort();

    if (!candidates.length) return null;
    const name = candidates[candidates.length - 1];
    const fullPath = path.join(config.backupDir, name);
    const st = fs.statSync(fullPath);

    let isMulti = false;
    let hasUsers = false;
    let bytes = st.size;
    let manifestData = null;

    if (st.isDirectory()) {
      isMulti = true;
      const manifestPath = path.join(fullPath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          hasUsers = !!manifestData.has_users;
          bytes = manifestData.total_bytes || bytes;
        } catch (_) {}
      }
    } else {
      const manifestPath = path.join(config.backupDir, name.replace(/\.db$/, '.manifest.json'));
      if (fs.existsSync(manifestPath)) {
        try {
          manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          hasUsers = !!manifestData.has_users;
        } catch (_) {}
      }
    }

    return {
      name,
      bytes,
      isMulti,
      hasUsers,
      ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000),
      manifest: manifestData
    };
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

  const hasUsers = Boolean((newest && newest.hasUsers) || (s.snapshot && s.snapshot.hasUsers));

  return {
    newest_snapshot: newest,
    snapshot_stale: stale,
    has_users: hasUsers,
    last_snapshot: s.snapshot || null,
    last_verify: s.verify || null,
    // The restore check runs weekly. Older than 8 days means the timer is not running.
    verify_overdue: verifyAgeDays == null || verifyAgeDays > 8,
    ok: !stale && !!(s.snapshot && s.snapshot.ok) && hasUsers && !(s.snapshot && s.snapshot.mirror && s.snapshot.mirror.ok === false),
  };
}

module.exports = { read, write, summary, newestSnapshot, FILE };
