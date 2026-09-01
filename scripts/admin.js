'use strict';

// User administration CLI (run on the server).
//
//   node scripts/admin.js list
//   node scripts/admin.js create-admin <username> <password> ["Full Name"]
//   node scripts/admin.js add-user <username> <password> <role1,role2> ["Full Name"]
//   node scripts/admin.js set-password <username> <password> [--no-force]
//   node scripts/admin.js deactivate <username>
//   node scripts/admin.js rotate-seed
//
// New/created users get must_change_password=1 (forced change on first login).
// `rotate-seed` forces a password change on the demo accounts before go-live.

const { migrate, get, all, run, tx } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();
const [cmd, ...rest] = process.argv.slice(2);

function ensureRoles(names) {
  const ids = [];
  for (const n of names) {
    const r = get('SELECT id FROM roles WHERE name = ?', n);
    if (!r) { console.error(`  ! unknown role "${n}" — skipped`); continue; }
    ids.push(r.id);
  }
  return ids;
}

function createUser(username, password, roles, fullName) {
  if (get('SELECT id FROM users WHERE username = ?', username)) {
    console.error(`User "${username}" already exists.`); process.exit(1);
  }
  tx(() => {
    const id = run('INSERT INTO users (username, password_hash, full_name, active, must_change_password) VALUES (?, ?, ?, 1, 1)',
      username, auth.hashPassword(password), fullName || null).lastInsertRowid;
    for (const rid of ensureRoles(roles)) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', id, rid);
  });
  console.log(`Created "${username}" [${roles.join(', ')}] — must change password on first login.`);
}

switch (cmd) {
  case 'list': {
    for (const u of all('SELECT * FROM users ORDER BY username')) {
      console.log(`${u.active ? ' ' : '✗'} ${u.username.padEnd(16)} ${auth.rolesForUser(u.id).join(',').padEnd(40)} ${u.must_change_password ? '(must change pw)' : ''}`);
    }
    break;
  }
  case 'create-admin':
    if (rest.length < 2) { console.error('usage: create-admin <username> <password> ["Full Name"]'); process.exit(1); }
    createUser(rest[0], rest[1], ['admin'], rest[2]);
    break;
  case 'add-user':
    if (rest.length < 3) { console.error('usage: add-user <username> <password> <role1,role2> ["Full Name"]'); process.exit(1); }
    createUser(rest[0], rest[1], rest[2].split(','), rest[3]);
    break;
  case 'set-password': {
    if (rest.length < 2) { console.error('usage: set-password <username> <password> [--no-force]'); process.exit(1); }
    const u = get('SELECT id FROM users WHERE username = ?', rest[0]);
    if (!u) { console.error('No such user'); process.exit(1); }
    const force = rest.includes('--no-force') ? 0 : 1;
    run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', auth.hashPassword(rest[1]), force, u.id);
    console.log(`Password set for "${rest[0]}"${force ? ' (must change on next login)' : ''}.`);
    break;
  }
  case 'deactivate': {
    const u = get('SELECT id FROM users WHERE username = ?', rest[0]);
    if (!u) { console.error('No such user'); process.exit(1); }
    run('UPDATE users SET active = 0 WHERE id = ?', u.id);
    console.log(`Deactivated "${rest[0]}".`);
    break;
  }
  case 'rotate-seed': {
    // 'asst' arrived later, with the assistant-transport-manager migration, and was never added
    // here — so it would have gone to the public internet still answering to asst/asst.
    const demo = ['admin', 'store', 'transport', 'asst', 'ops', 'mech', 'viewer'];
    const r = run(`UPDATE users SET must_change_password = 1 WHERE username IN (${demo.map(() => '?').join(',')})`, ...demo);
    console.log(`Forced password change on ${r.changes} demo account(s). They must set a new password at next login.`);
    break;
  }
  default:
    console.log('Commands: list | create-admin | add-user | set-password | deactivate | rotate-seed');
}
process.exit(0);
