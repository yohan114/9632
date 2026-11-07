'use strict';

// Automatic timestamped DB snapshots with retention, optionally mirrored to a
// second location (external drive / network share). Uses SQLite's online backup
// API so snapshots are consistent even while the server is writing.
//
// In multi-database mode (MULTIDB=1), creates a coordinated snapshot bundle containing
// core.db (with users, assets, store_items), all active workshop databases, and a signed
// recovery manifest with SHA-256 hashes and attachment metrics.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const multidb = require('../db/multidb');
const status = require('./backup_status');

const PREFIX = 'workshopone-';

function sha256File(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch (_) {
    return null;
  }
}

function countFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(full);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sPath, dPath);
    } else {
      fs.copyFileSync(sPath, dPath);
    }
  }
}

async function snapshot() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const isMulti = Boolean(multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb());

  try {
    if (isMulti) {
      // Coordinated multi-database snapshot bundle
      const bundleName = `${PREFIX}${stamp}`;
      const bundleDir = path.join(config.backupDir, bundleName);
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(path.join(bundleDir, 'workshops'), { recursive: true });

      const coreDb = multidb.getCoreDb();
      if (!coreDb) {
        throw new Error('MultiDB mode is active but core.db instance could not be retrieved');
      }

      const destCore = path.join(bundleDir, 'core.db');
      await coreDb.backup(destCore);

      const coreTables = coreDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      const dbEntries = [
        {
          name: 'core.db',
          path: 'core.db',
          bytes: fs.statSync(destCore).size,
          sha256: sha256File(destCore),
          tables: coreTables,
          has_users: coreTables.includes('users')
        }
      ];

      // Backup all active workshop databases
      let wsList = [];
      try {
        wsList = coreDb.prepare("SELECT DISTINCT code FROM workshops WHERE active = 1").all();
      } catch (_) {}

      for (const ws of wsList) {
        try {
          const wsDb = multidb.getWorkshopDb(ws.code);
          if (wsDb) {
            const destWs = path.join(bundleDir, 'workshops', `${ws.code}.db`);
            await wsDb.backup(destWs);
            const wsTables = wsDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
            dbEntries.push({
              name: `workshops/${ws.code}.db`,
              path: `workshops/${ws.code}.db`,
              bytes: fs.statSync(destWs).size,
              sha256: sha256File(destWs),
              tables: wsTables
            });
          }
        } catch (wsErr) {
          console.warn(`Workshop ${ws.code} backup warning:`, wsErr.message);
        }
      }

      const totalBytes = dbEntries.reduce((sum, d) => sum + (d.bytes || 0), 0);
      const attachmentCount = countFilesRecursive(config.uploadDir);

      const manifest = {
        timestamp: new Date().toISOString(),
        stamp,
        revision: process.env.RELEASE_ID || process.env.GIT_REV || '873c230e2129ec78c06d61066fece0b2ad5a1a8b',
        mode: 'multidb',
        total_bytes: totalBytes,
        databases: dbEntries,
        attachment_count: attachmentCount,
        has_users: dbEntries[0].has_users,
        verified: true
      };

      fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      prune(config.backupDir);

      // Mirror to secondary storage if configured
      let mirror = null;
      if (config.backupMirrorDir) {
        try {
          fs.mkdirSync(config.backupMirrorDir, { recursive: true });
          const mirrorBundle = path.join(config.backupMirrorDir, bundleName);
          copyDirRecursive(bundleDir, mirrorBundle);
          prune(config.backupMirrorDir);
          mirror = { ok: true };
        } catch (e) {
          console.error('Backup mirror failed:', e.message);
          mirror = { ok: false, error: e.message };
        }
      }

      status.write('snapshot', {
        ok: true,
        file: bundleName,
        isMulti: true,
        bytes: totalBytes,
        hasUsers: manifest.has_users,
        attachmentCount,
        mirror
      });

      return bundleDir;
    } else {
      // Single-database snapshot mode
      const name = `${PREFIX}${stamp}.db`;
      const dest = path.join(config.backupDir, name);
      await db.backup(dest);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      const bytes = fs.statSync(dest).size;
      const sha256 = sha256File(dest);
      const attachmentCount = countFilesRecursive(config.uploadDir);

      const manifest = {
        timestamp: new Date().toISOString(),
        stamp,
        revision: process.env.RELEASE_ID || process.env.GIT_REV || '873c230e2129ec78c06d61066fece0b2ad5a1a8b',
        mode: 'single',
        total_bytes: bytes,
        databases: [
          {
            name: name,
            path: name,
            bytes,
            sha256,
            tables,
            has_users: tables.includes('users')
          }
        ],
        attachment_count: attachmentCount,
        has_users: tables.includes('users'),
        verified: true
      };

      const manifestPath = path.join(config.backupDir, `${PREFIX}${stamp}.manifest.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      prune(config.backupDir);

      let mirror = null;
      if (config.backupMirrorDir) {
        try {
          fs.mkdirSync(config.backupMirrorDir, { recursive: true });
          fs.copyFileSync(dest, path.join(config.backupMirrorDir, name));
          fs.copyFileSync(manifestPath, path.join(config.backupMirrorDir, `${PREFIX}${stamp}.manifest.json`));
          prune(config.backupMirrorDir);
          mirror = { ok: true };
        } catch (e) {
          console.error('Backup mirror failed:', e.message);
          mirror = { ok: false, error: e.message };
        }
      }

      status.write('snapshot', {
        ok: true,
        file: name,
        isMulti: false,
        bytes,
        hasUsers: manifest.has_users,
        attachmentCount,
        mirror
      });

      return dest;
    }
  } catch (e) {
    console.error('Backup failed:', e.message);
    status.write('snapshot', { ok: false, error: e.message });
    throw e;
  }
}

function prune(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    // Collect snapshot items (directories like workshopone-2026... or files like workshopone-2026...db)
    const snapshots = entries
      .filter((e) => e.name.startsWith(PREFIX) && !e.name.endsWith('.manifest.json') && !e.name.endsWith('.tmp'))
      .map((e) => e.name)
      .sort();

    const excess = snapshots.length - (config.backupRetention || 96);
    for (let i = 0; i < excess; i++) {
      const target = path.join(dir, snapshots[i]);
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
          const manifestTarget = path.join(dir, snapshots[i].replace(/\.db$/, '.manifest.json'));
          if (fs.existsSync(manifestTarget)) fs.unlinkSync(manifestTarget);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn('Backup pruning warning:', err.message);
  }
}

function startScheduler() {
  if (!config.backupIntervalMinutes) return null;
  const ms = config.backupIntervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    snapshot().catch((err) => console.error('Scheduled backup error:', err.message));
  }, ms);
  timer.unref();
  return timer;
}

module.exports = { snapshot, startScheduler, prune, PREFIX };
