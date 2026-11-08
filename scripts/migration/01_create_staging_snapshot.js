'use strict';

/**
 * Phase 1: Safe Staging Snapshot Extraction
 *
 * Captures consistent SQLite snapshots of both production databases using the
 * SQLite Online Backup API (accounting for WAL journals).
 * Computes SHA-256 checksums, verifies PRAGMA integrity_check and foreign_key_check,
 * and produces a cryptographically verifiable manifest.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const STAGING_DIR = path.resolve(__dirname, '../../data/staging_merger');
fs.mkdirSync(STAGING_DIR, { recursive: true });

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

async function snapshotDb(sourcePath, destPath, label) {
  console.log(`\n--- Snapshotting ${label} ---`);
  console.log(`Source: ${sourcePath}`);
  console.log(`Dest:   ${destPath}`);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database missing: ${sourcePath}`);
  }

  const srcDb = new Database(sourcePath, { readonly: true });
  
  // Use better-sqlite3 online backup API to write clean, consistent file (including WAL)
  await srcDb.backup(destPath);
  srcDb.close();

  // Verify backup integrity
  const destDb = new Database(destPath, { readonly: true });
  const integrity = destDb.prepare('PRAGMA integrity_check').all();
  const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
  
  let fkErrors = [];
  try {
    fkErrors = destDb.prepare('PRAGMA foreign_key_check').all();
  } catch (_) {}

  const tables = destDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  
  const tableCounts = {};
  for (const t of tables) {
    try {
      tableCounts[t] = destDb.prepare(`SELECT count(*) as c FROM "${t}"`).get().c;
    } catch (e) {
      tableCounts[t] = `Error: ${e.message}`;
    }
  }

  destDb.close();

  const stat = fs.statSync(destPath);
  const hash = sha256(destPath);

  console.log(`✅ Snapshot complete: ${(stat.size / 1024 / 1024).toFixed(2)} MB, SHA-256: ${hash.slice(0, 16)}...`);
  console.log(`   Integrity: ${integrityOk ? 'OK' : 'FAILED'}, Foreign Key Issues: ${fkErrors.length}`);
  console.log(`   Tables: ${tables.length}`);

  return {
    label,
    source_path: sourcePath,
    dest_path: destPath,
    size_bytes: stat.size,
    sha256: hash,
    integrity_ok: integrityOk,
    fk_errors_count: fkErrors.length,
    table_count: tables.length,
    tables: tableCounts,
  };
}

async function run() {
  console.log('=== Staging Snapshot Extraction (Phase 1) ===');
  const timestamp = new Date().toISOString();

  // 1. Fuel System DB
  const fuelSource = 'D:/Fuel system server side/fuelsystem/data/app.db';
  const fuelDest = path.join(STAGING_DIR, 'fuel_staging.db');
  const fuelMeta = await snapshotDb(fuelSource, fuelDest, 'Fuel-System-V2');

  // 2. WorkshopOne Core DB
  const candidateCore = [
    path.resolve(__dirname, '../../data/core.db'),
    'D:/Master system 1/data/core.db'
  ];
  const woCoreSource = candidateCore.find(p => fs.existsSync(p));
  if (!woCoreSource) throw new Error('Could not find WorkshopOne core.db');
  const woCoreDest = path.join(STAGING_DIR, 'workshop_core_staging.db');
  const woMeta = await snapshotDb(woCoreSource, woCoreDest, 'WorkshopOne-Core');

  // 3. WorkshopOne Monolith DB (if present)
  const candidateWo = [
    path.resolve(__dirname, '../../data/workshopone.db'),
    'D:/Master system 1/data/workshopone.db'
  ];
  const woSource = candidateWo.find(p => fs.existsSync(p));
  let woDbMeta = null;
  if (woSource) {
    const woDest = path.join(STAGING_DIR, 'workshopone_staging.db');
    woDbMeta = await snapshotDb(woSource, woDest, 'WorkshopOne-Main');
  }

  const manifest = {
    timestamp,
    snapshot_created_by: 'WorkshopOne Merger Phase 1 Engine',
    databases: {
      fuel_system: fuelMeta,
      workshop_core: woMeta,
    }
  };

  const manifestPath = path.join(STAGING_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n📄 Manifest written to: ${manifestPath}`);
  console.log('=== Phase 1 Staging Replicas Ready ===\n');
}

run().catch((err) => {
  console.error('Fatal error during snapshot extraction:', err);
  process.exit(1);
});
