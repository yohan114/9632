'use strict';

// Create the workshop's real accounts, one per person.
//
//   node scripts/create_staff.js                      # show what would be created (dry run)
//   node scripts/create_staff.js --apply              # create them
//   node scripts/create_staff.js --file staff.csv     # from a file instead of the list below
//
// WHY ONE ACCOUNT PER PERSON, rather than sharing `store` and `ops`. Every MRN carries who
// requested it, who certified it and who approved it, and the whole point of that trail is that it
// names a person. Shared logins turn all of it into "store", which is the same as no trail at all
// — and it means a person who leaves cannot be removed without changing the password for everyone
// still there.
//
// Each account is created with a random temporary password and must_change_password set, so the
// password printed here stops working the moment its owner signs in. Hand each line to its person
// and keep none of it.
//
// Dry run by default, like every other script here: nothing is written without --apply.

const crypto = require('crypto');
const fs = require('fs');
const { migrate, get, all, run, tx } = require('../src/db');
const auth = require('../src/lib/auth');

migrate();

const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.indexOf('--file');
const FILE = fileArg !== -1 ? process.argv[fileArg + 1] : null;

// ---------------------------------------------------------------------------
// EDIT THIS LIST, or pass --file with the same three columns.
//
//   username , Full Name , role(s) separated by |
//
// Roles available (see src/lib/permissions.js for what each may do):
//   admin                        everything, including creating users
//   manager                      the management view across modules
//   operational_manager          approves MRNs; ops oversight
//   transport_manager            fleet and transport
//   assistant_transport_manager  transport, without the approvals
//   main_storekeeper             main stores: GRN, purchase, issue to workshop
//   storekeeper                  workshop stores: MRN, issue, receiving
//   workshop                     supervisors and mechanics: job cards, daily work
//   viewer                       read-only
// ---------------------------------------------------------------------------
const STAFF = [
  // ['nimal',   'Nimal Perera',     'storekeeper'],
  // ['kamal',   'Kamal Silva',      'main_storekeeper'],
  // ['sunil',   'Sunil Fernando',   'operational_manager|manager'],
];

function parseFile(path) {
  const rows = [];
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 3) { console.error(`  ! skipped, needs 3 columns: ${line}`); continue; }
    rows.push([parts[0], parts[1], parts.slice(2).join(',')]);
  }
  return rows;
}

// Readable, but not guessable: 4 random bytes of entropy in a shape someone can retype off paper
// without asking which character that is. No l/1/O/0.
function tempPassword() {
  const words = ['Anchor', 'Bridge', 'Cobalt', 'Dynamo', 'Ember', 'Forge', 'Granite', 'Harbour',
    'Ingot', 'Kestrel', 'Lantern', 'Marble', 'Nickel', 'Oxide', 'Piston', 'Quarry',
    'Rivet', 'Summit', 'Timber', 'Vessel', 'Willow', 'Zephyr'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}

const list = FILE ? parseFile(FILE) : STAFF;

if (!list.length) {
  console.log('\nNo staff listed.\n');
  console.log('Either edit the STAFF list at the top of this file, or write a CSV:');
  console.log('\n    nimal,Nimal Perera,storekeeper');
  console.log('    kamal,Kamal Silva,main_storekeeper');
  console.log('    sunil,Sunil Fernando,operational_manager|manager\n');
  console.log('and run:  node scripts/create_staff.js --file staff.csv --apply\n');
  process.exit(0);
}

const known = new Set(all('SELECT name FROM roles').map((r) => r.name));
const created = [];
let refused = 0;

console.log(`\n${APPLY ? 'CREATING' : 'DRY RUN — nothing will be written'}\n${'='.repeat(72)}`);

for (const [username, fullName, roleSpec] of list) {
  const roles = String(roleSpec).split('|').map((s) => s.trim()).filter(Boolean);
  const bad = roles.filter((r) => !known.has(r));
  if (bad.length) { console.log(`  SKIP  ${username.padEnd(14)} unknown role(s): ${bad.join(', ')}`); refused++; continue; }
  if (!roles.length) { console.log(`  SKIP  ${username.padEnd(14)} no roles given`); refused++; continue; }
  if (get('SELECT id FROM users WHERE username = ?', username)) {
    // Not an error worth stopping for — re-running after adding one name to the list is normal.
    console.log(`  SKIP  ${username.padEnd(14)} already exists`);
    refused++;
    continue;
  }

  const password = tempPassword();
  if (APPLY) {
    tx(() => {
      const id = run(
        'INSERT INTO users (username, password_hash, full_name, active, must_change_password) VALUES (?, ?, ?, 1, 1)',
        username, auth.hashPassword(password), fullName || null
      ).lastInsertRowid;
      for (const r of roles) {
        run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
      }
    });
  }
  created.push({ username, fullName, roles: roles.join(', '), password });
  console.log(`  ${APPLY ? 'OK  ' : 'would'}  ${username.padEnd(14)} ${String(fullName).padEnd(24)} ${roles.join(', ')}`);
}

if (created.length) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(APPLY ? 'HAND THESE OUT, ONE LINE EACH, THEN DESTROY THIS PRINTOUT' : 'Passwords shown are what WOULD be set:');
  console.log('='.repeat(72));
  for (const c of created) {
    console.log(`  ${String(c.fullName || c.username).padEnd(24)} username: ${c.username.padEnd(14)} password: ${c.password}`);
  }
  console.log('='.repeat(72));
  console.log('Each must be changed at first sign-in, so these stop working immediately after use.');
}

console.log(`\n${created.length} to create, ${refused} skipped.`);
if (!APPLY && created.length) console.log('Nothing was written. Re-run with --apply to create them.\n');
else console.log('');

process.exit(0);
