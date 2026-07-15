'use strict';

// Restore / verify a DB snapshot.
//
//   node scripts/restore.js --verify [snapshot|--latest]   (default; non-destructive)
//   node scripts/restore.js --into <path> [snapshot|--latest]
//   node scripts/restore.js --replace --yes [snapshot|--latest]
//
// --verify   restores the snapshot into a scratch DB and prints per-table row
//            counts beside the live DB, so you can confirm a restore works
//            WITHOUT touching production. Backups are not "done" until this passes.
// --into     writes the snapshot to an explicit target path.
// --replace  replaces the live DB (a safety snapshot of the current DB is taken
//            first). Requires --yes. STOP THE SERVER before doing this.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const PREFIX = 'workshopone-';

function latestSnapshot() {
  const files = fs.existsSync(config.backupDir)
    ? fs.readdirSync(config.backupDir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.db')).sort()
    : [];
  return files.length ? path.join(config.backupDir, files[files.length - 1]) : null;
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

const snapshot = resolveSnapshot();
console.log('Snapshot:', snapshot);

if (has('--into')) {
  const target = valueOf('--into');
  if (!target) { console.error('--into requires a path'); process.exit(1); }
  fs.copyFileSync(snapshot, target);
  stripWal(target);
  console.log('Restored snapshot to', target);
  process.exit(0);
}

if (has('--replace')) {
  if (!has('--yes')) { console.error('Refusing to replace the live DB without --yes'); process.exit(1); }
  // safety snapshot of the current live DB first
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
const scratch = path.join(config.backupDir, '_restore_verify_scratch.db');
try {
  fs.copyFileSync(snapshot, scratch);
  stripWal(scratch);
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
  console.log(`\n  Restore VERIFIED: snapshot opened, ${names.length} tables, ${total} rows total.`);
  console.log(mismatches === 0
    ? '  Row counts match the live DB exactly.\n'
    : `  ${mismatches} table(s) differ from live (expected if the live DB has changed since the snapshot).\n`);
} finally {
  stripWal(scratch);
  try { fs.unlinkSync(scratch); } catch {}
}
