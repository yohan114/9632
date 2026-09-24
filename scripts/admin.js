'use strict';

// User administration CLI (run on the server).
//
//   node scripts/admin.js list
//   node scripts/admin.js create-admin <username> <password> ["Full Name"]
//   node scripts/admin.js add-user <username> <password> <role1,role2> ["Full Name"]
//   node scripts/admin.js set-password <username> <password> [--no-force]
//   node scripts/admin.js deactivate <username>
//   node scripts/admin.js rotate-seed
//   node scripts/admin.js audit-passwords
//   node scripts/admin.js reset-mfa <username>
//
// New/created users get must_change_password=1 (forced change on first login).
// `rotate-seed` forces a password change on the demo accounts before go-live.
// `audit-passwords` lists accounts whose password is still their username (the demo pattern) —
// those cannot sign in on a production server, see routes/auth.js.
// `reset-mfa` takes someone's two-factor sign-in off (lost phone) and signs them out; the way back in
// when it is the admin's own phone that is gone. If their role requires it, they enrol again at
// next sign-in.
// Passwords set here follow the same rules as the app (src/lib/password_policy.js), and setting a
// password or deactivating an account signs that account out everywhere.

const { migrate, get, all, run, tx } = require('../src/db');
const auth = require('../src/lib/auth');
const passwordPolicy = require('../src/lib/password_policy');

migrate();
const [cmd, ...rest] = process.argv.slice(2);

function assertPassword(pw, username) {
  const why = passwordPolicy.problem(pw, { username });
  if (why) { console.error(why); process.exit(1); }
}

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
  assertPassword(password, username);
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
      console.log(`${u.active ? ' ' : '✗'} ${u.username.padEnd(16)} ${auth.rolesForUser(u.id).join(',').padEnd(40)} ${u.mfa_enabled ? '2FA ' : '    '}${u.must_change_password ? '(must change pw)' : ''}`);
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
    assertPassword(rest[1], rest[0]);
    run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', auth.hashPassword(rest[1]), force, u.id);
    const ended = auth.revokeSessions(u.id);
    console.log(`Password set for "${rest[0]}"${force ? ' (must change on next login)' : ''}; ${ended} open session(s) signed out.`);
    break;
  }
  case 'deactivate': {
    const u = get('SELECT id FROM users WHERE username = ?', rest[0]);
    if (!u) { console.error('No such user'); process.exit(1); }
    run('UPDATE users SET active = 0 WHERE id = ?', u.id);
    const ended = auth.revokeSessions(u.id);
    console.log(`Deactivated "${rest[0]}"; ${ended} open session(s) signed out.`);
    break;
  }
  case 'reset-mfa': {
    const u = get('SELECT id, mfa_enabled FROM users WHERE username = ?', rest[0]);
    if (!u) { console.error('No such user'); process.exit(1); }
    require('../src/lib/mfa').clear(u.id);
    const ended = auth.revokeSessions(u.id);
    require('../src/lib/audit').record({ entity: 'user', entityId: u.id, action: 'mfa_reset', reason: 'scripts/admin.js reset-mfa',
      before: { mfa_enabled: !!u.mfa_enabled }, after: { mfa_enabled: false, sessions_ended: ended }, notify: false });
    console.log(`Two-factor sign-in removed for "${rest[0]}"; ${ended} open session(s) signed out.`);
    break;
  }
  case 'audit-passwords': {
    // Read-only. bcrypt is slow on purpose, so this takes about a tenth of a second per account.
    const weak = all('SELECT id, username, active, password_hash FROM users ORDER BY username')
      .filter((u) => auth.verifyPassword(u.username, u.password_hash) || auth.verifyPassword(u.username.toLowerCase(), u.password_hash));
    if (!weak.length) { console.log('No account uses its username as its password.'); break; }
    console.log('Accounts whose password is still their username (blocked from signing in on production):');
    for (const u of weak) console.log(`  ${u.username}${u.active ? '' : ' (inactive)'}  ->  node scripts/admin.js set-password ${u.username} <new-password>`);
    process.exitCode = 2;
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
    console.log('Commands: list | create-admin | add-user | set-password | deactivate | rotate-seed | audit-passwords | reset-mfa');
}
process.exit(process.exitCode || 0);
