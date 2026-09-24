'use strict';

// One command that answers "why can't anyone sign in".
//
//   node scripts/doctor.js
//
// Written after a VPS cut-over where the app came up, served the login page, and refused every
// password. The cause was a misread .env pointing at a brand-new empty database — but "no such
// user" and "wrong password" are reported identically, on purpose, so nothing on screen said so.
// This prints the handful of facts that separate the possibilities, in the order worth checking.
//
// Reports only. It changes nothing, and never prints a password hash.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const ok = (s) => `  OK    ${s}`;
const bad = (s) => `  ****  ${s}`;
const info = (s) => `        ${s}`;
let problems = 0;
const fail = (s) => { problems++; console.log(bad(s)); };

console.log('\nWorkshopOne — sign-in diagnosis\n' + '='.repeat(60));

// ---- 1. which database, and is it the one you think ------------------------
console.log('\n1. Database');
console.log(info(`DB_PATH resolves to: ${config.dbPath}`));
const envFile = path.join(config.root, '.env');
console.log(info(`.env read from     : ${envFile}${fs.existsSync(envFile) ? '' : '  (MISSING — defaults in use)'}`));

let stat = null;
try { stat = fs.statSync(config.dbPath); } catch { /* handled below */ }
if (!stat) {
  fail('That file does not exist. It will be created empty on next start, and nobody will be able to sign in.');
} else {
  const mb = stat.size / 1024 / 1024;
  console.log(info(`size               : ${mb.toFixed(1)} MB`));
  if (mb < 1) fail('Under 1 MB — that is a freshly created database, not the workshop\'s. Check DB_PATH in .env.');
  else console.log(ok('Size looks like a real database.'));
}

// Anything that looks like a database SOMEWHERE ELSE is the classic symptom: the real one was put
// in one place and a relative DB_PATH created a second, empty one beside the code.
const strays = new Map();
const dirs = new Set([path.join(config.root, 'data'), path.dirname(config.dbPath)].map((d) => path.resolve(d)));
for (const dir of dirs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const n of names) {
    if (!n.endsWith('.db')) continue;
    const p = path.resolve(dir, n);
    if (p === path.resolve(config.dbPath)) continue;
    try { strays.set(p, `${p}  (${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB)`); } catch { /* ignore */ }
  }
}
if (strays.size) {
  console.log(info('Other database files nearby — make sure the app is on the right one:'));
  for (const s of strays.values()) console.log(info('  ' + s));
}

// ---- 2. accounts -----------------------------------------------------------
console.log('\n2. Accounts');
let users = [];
try {
  const { all } = require('../src/db');
  users = all('SELECT id, username, active, must_change_password FROM users ORDER BY username');
} catch (e) {
  fail(`Could not read the users table: ${e.message}`);
}
if (!users.length) {
  fail('NO ACCOUNTS AT ALL. Every password will be refused as incorrect. Almost always the wrong');
  fail('DB_PATH: this is an empty database. Fix .env, restart, and check this again.');
} else {
  console.log(ok(`${users.length} account(s):`));
  const auth = require('../src/lib/auth');
  for (const u of users) {
    const roles = auth.rolesForUser(u.id).join(',') || 'no roles';
    console.log(info(
      `  ${u.active ? ' ' : 'INACTIVE '}${u.username.padEnd(14)}` +
      `${u.must_change_password ? 'must change pw  ' : '                '}${roles}`
    ));
  }
  const inactive = users.filter((u) => !u.active);
  if (inactive.length) console.log(info(`  (${inactive.length} deactivated — those cannot sign in by design)`));
  console.log(info(''));
  console.log(info('Passwords are bcrypt hashes and cannot be read back. If nobody knows one:'));
  console.log(info('  node scripts/admin.js set-password <username> "<a temporary password>"'));
  console.log(info('That forces a change at first sign-in, so the temporary one stops working.'));
}

// ---- 3. how it is being served --------------------------------------------
console.log('\n3. Serving');
console.log(info(`HOST / PORT        : ${config.host}:${config.port}`));
if (config.isProduction && config.host === '0.0.0.0') {
  fail('Bound to 0.0.0.0 in production — the app is on the public interface beside nginx, with');
  fail('TLS bypassed. Set HOST=127.0.0.1 in .env.');
} else {
  console.log(ok(config.isProduction ? 'Bound to the loopback interface, as production should be.' : 'Development bind.'));
}
console.log(info(`NODE_ENV           : ${process.env.NODE_ENV || '(unset — development)'}`));
console.log(info(`PUBLIC_ORIGIN      : ${process.env.PUBLIC_ORIGIN || '(unset)'}`));

// ---- 4. sessions -----------------------------------------------------------
console.log('\n4. Recent sign-ins');
try {
  const { all, get } = require('../src/db');
  const live = get("SELECT COUNT(*) c FROM sessions WHERE expires_at > datetime('now')").c;
  console.log(info(`${live} session(s) currently valid`));
  const recent = all(`SELECT s.ip, s.created_at, u.username FROM sessions s
                        JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 5`);
  if (!recent.length) console.log(info('No sign-in has ever succeeded on this database.'));
  for (const r of recent) console.log(info(`  ${r.created_at}  ${String(r.username).padEnd(14)} from ${r.ip || '(no address recorded)'}`));
  const cf = recent.filter((r) => /^(104\.|172\.6[4-9]\.|172\.7[01]\.|162\.158\.|141\.101\.|108\.162\.)/.test(String(r.ip || '')));
  if (cf.length) {
    fail('Some addresses above are Cloudflare\'s, not the visitor\'s. The real-IP block in nginx is');
    fail('not working, so the login rate limiter is counting every visitor on the internet as one');
    fail('person — a handful of failed guesses will lock out the whole workshop.');
  }
} catch (e) {
  fail(`Could not read sessions: ${e.message}`);
}

console.log('\n' + '='.repeat(60));
console.log(problems ? `${problems} problem(s) found — see the **** lines above.\n` : 'Nothing obviously wrong.\n');
process.exit(0);
