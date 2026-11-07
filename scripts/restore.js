'use strict';

// Restore / verify a DB snapshot.
//
//   node scripts/restore.js --verify [snapshot|--latest]   (default; non-destructive)
//   node scripts/restore.js --into <path> [snapshot|--latest]
//   node scripts/restore.js --replace --yes [snapshot|--latest]
//
// --verify   restores the snapshot into a scratch DB (or directory in MultiDB) and
//            runs PRAGMA integrity_check and checks table counts beside the live DB.
// --into     writes the snapshot to an explicit target path.
// --replace  replaces the live DB. Requires --yes. STOP THE SERVER before doing this.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../src/config');
const backupStatus = require('../src/lib/backup_status');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const PREFIX = 'workshopone-';

function latestSnapshot() {
  if (!fs.existsSync(config.backupDir)) return null;
  const entries = fs.readdirSync(config.backupDir, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.name.startsWith(PREFIX) && !e.name.endsWith('.manifest.json') && !e.name.endsWith('.tmp') && e.name !== 'backup-status.json')
    .map((e) => e.name)
    .sort();
  return candidates.length ? path.join(config.backupDir, candidates[candidates.length - 1]) : null;
}

function resolveSnapshot() {
  const positional = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--into');
  if (positional && fs.existsSync(positional)) return positional;
  const snap = latestSnapshot();
  if (!snap) { console.error('No snapshot found in', config.backupDir); process.exit(1); }
  return snap;
}

function tableCounts(dbFile) {
  const db = new Database(dbFile, { readonly: true });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const counts = {};
  for (const { name } of tables) counts[name] = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
  db.close();
  return counts;
}

function stripWal(file) {
  for (const s of ['-shm', '-wal']) { try { fs.unlinkSync(file + s); } catch {} }
}

function integrity(dbFile) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db.pragma('integrity_check');
    const msgs = rows.map((r) => r.integrity_check);
    return { ok: msgs.length === 1 && msgs[0] === 'ok', messages: msgs.slice(0, 10) };
  } finally { db.close(); }
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

const snapshot = resolveSnapshot();
const isDirectoryBundle = fs.statSync(snapshot).isDirectory();
console.log('Snapshot:', snapshot, isDirectoryBundle ? '(MultiDB bundle)' : '(Single DB file)');

if (has('--into')) {
  const target = valueOf('--into');
  if (!target) { console.error('--into requires a path'); process.exit(1); }
  if (isDirectoryBundle) {
    copyDirRecursive(snapshot, target);
    console.log('Restored multi-db snapshot bundle to', target);
  } else {
    fs.copyFileSync(snapshot, target);
    stripWal(target);
    console.log('Restored snapshot to', target);
  }
  process.exit(0);
}

if (has('--replace')) {
  if (!has('--yes')) { console.error('Refusing to replace the live DB without --yes'); process.exit(1); }
  if (isDirectoryBundle) {
    console.error('Replacing live MultiDB cluster directly via --replace requires manual target mapping. Use --into <dir>');
    process.exit(1);
  }
  if (fs.existsSync(config.dbPath)) {
    const safety = config.dbPath + '.pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(config.dbPath, safety);
    console.log('Safety copy of current live DB ->', safety);
  }
  fs.copyFileSync(snapshot, config.dbPath);
  stripWal(config.dbPath);
  console.log('Live DB replaced with snapshot. Restart the server.');
  process.exit(0);
}

// default: --verify (non-destructive)
let verdict = { ok: false, snapshot: path.basename(snapshot), error: 'verify did not complete' };

if (isDirectoryBundle) {
  // Multi-database bundle verification
  const scratchDir = path.join(config.backupDir, '_restore_verify_scratch_bundle');
  try {
    if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    copyDirRecursive(snapshot, scratchDir);

    const manifestPath = path.join(scratchDir, 'manifest.json');
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }

    const coreFile = path.join(scratchDir, 'core.db');
    if (!fs.existsSync(coreFile)) throw new Error('Snapshot bundle missing core.db');
    const coreCheck = integrity(coreFile);
    if (!coreCheck.ok) {
      throw new Error('core.db integrity_check failed: ' + coreCheck.messages.join(', '));
    }

    const coreCounts = tableCounts(coreFile);
    if (!coreCounts.users || coreCounts.users === 0) {
      throw new Error('core.db missing users table or contains 0 users');
    }

    console.log('\n  MultiDB Bundle Verification:');
    console.log('  ' + '-'.repeat(58));
    console.log(`  core.db: integrity OK, ${Object.keys(coreCounts).length} tables, ${coreCounts.users} users, ${coreCounts.assets || 0} assets`);

    const workshopsDir = path.join(scratchDir, 'workshops');
    let totalWsTables = 0;
    if (fs.existsSync(workshopsDir)) {
      const wsFiles = fs.readdirSync(workshopsDir).filter((f) => f.endsWith('.db'));
      for (const wf of wsFiles) {
        const fullWs = path.join(workshopsDir, wf);
        const wsCheck = integrity(fullWs);
        if (!wsCheck.ok) throw new Error(`Workshop db ${wf} integrity check failed: ` + wsCheck.messages.join(', '));
        const wc = tableCounts(fullWs);
        totalWsTables += Object.keys(wc).length;
        console.log(`  workshops/${wf}: integrity OK, ${Object.keys(wc).length} tables, ${wc.job_cards || 0} job cards`);
      }
    }

    console.log('  ' + '-'.repeat(58));
    console.log(`  Bundle VERIFIED: integrity checks passed, users table intact, manifest verified.\n`);
    verdict = {
      ok: true,
      snapshot: path.basename(snapshot),
      isMulti: true,
      hasUsers: true,
      coreTables: Object.keys(coreCounts).length,
      usersCount: coreCounts.users,
      manifestVerified: !!manifest
    };
  } catch (e) {
    verdict = { ok: false, snapshot: path.basename(snapshot), isMulti: true, error: e.message };
    console.error('\n  RESTORE CHECK FAILED:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    backupStatus.write('verify', verdict);
  }
} else {
  // Single DB file verification
  const scratch = path.join(config.backupDir, '_restore_verify_scratch.db');
  try {
    fs.copyFileSync(snapshot, scratch);
    stripWal(scratch);
    const check = integrity(scratch);
    if (!check.ok) {
      verdict = { ok: false, snapshot: path.basename(snapshot), integrity: check.messages };
      console.error('\n  RESTORE CHECK FAILED — integrity_check reported:');
      for (const m of check.messages) console.error('    ' + m);
      process.exitCode = 1;
      return;
    }
    const restored = tableCounts(scratch);
    const live = fs.existsSync(config.dbPath) ? tableCounts(config.dbPath) : {};
    const names = [...new Set([...Object.keys(restored), ...Object.keys(live)])].sort();
    let mismatches = 0;
    let total = 0;
    console.log('\n  table                          restored     live   match');
    console.log('  ' + '-'.repeat(58));
    for (const n of names) {
      const r = restored[n] ?? '-';
      const l = live[n] ?? '-';
      const ok = String(r) === String(l);
      if (!ok) mismatches++;
      if (typeof restored[n] === 'number') total += restored[n];
      console.log('  ' + n.padEnd(30) + String(r).padStart(9) + String(l).padStart(9) + '   ' + (ok ? 'ok' : 'DIFF'));
    }
    console.log('  ' + '-'.repeat(58));
    console.log(`\n  Restore VERIFIED: integrity_check ok, ${names.length} tables, ${total} rows total.`);
    verdict = { ok: true, snapshot: path.basename(snapshot), tables: names.length, rows: total, differ_from_live: mismatches };
  } catch (e) {
    verdict = { ok: false, snapshot: path.basename(snapshot), error: e.message };
    console.error('\n  RESTORE CHECK FAILED:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    stripWal(scratch);
    try { fs.unlinkSync(scratch); } catch {}
    backupStatus.write('verify', verdict);
  }
}
