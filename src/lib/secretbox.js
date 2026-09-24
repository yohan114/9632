'use strict';

// Encrypting a small secret before it is written to the database — used for the two-factor keys.
//
// WHY. A two-factor key is only worth something while it stays secret: with the key, anyone can
// produce the codes. The database file is copied every 30 minutes, mirrored, and pulled to the
// office PC every day, so a copy of it will turn up in more places than the server. Passwords in it
// are bcrypt hashes and cost an attacker real work; a two-factor key stored as plain text would cost
// nothing. So the keys are encrypted (AES-256-GCM), and the encryption key is kept OUT of the
// database — a copy of the database alone is useless for producing codes.
//
// WHERE THE KEY LIVES, in order:
//   1. MFA_SECRET_KEY in the environment (.env): 32 bytes as 64 hex characters, or base64.
//   2. Otherwise a file `mfa.key` beside the database (created on first use, readable only by the
//      service account). The backups copy the database file only, never this.
//
// KEEP A COPY OF THE KEY somewhere safe (the password manager). Restoring the database onto a new
// server without it leaves every two-factor key unreadable — nobody is locked out for good (an admin
// resets them, see scripts/admin.js reset-mfa), but everyone has to enrol again.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const PREFIX = 'v1:';
let cached = null;

function keyFile() {
  return path.join(path.dirname(config.dbPath), 'mfa.key');
}

function parseKey(s) {
  const t = String(s).trim();
  const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== 32) throw new Error('MFA_SECRET_KEY must be 32 bytes (64 hex characters or base64)');
  return buf;
}

function key() {
  if (cached) return cached;
  if (process.env.MFA_SECRET_KEY) return (cached = parseKey(process.env.MFA_SECRET_KEY));
  const file = keyFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'wx': never overwrite a key that appeared in the meantime — that would orphan every secret.
    try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return (cached = parseKey(fs.readFileSync(file, 'utf8')));
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** The plain secret, or null if it cannot be read (wrong key, damaged value). Never throws. */
function open(sealed) {
  if (!sealed || !String(sealed).startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(String(sealed).slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Test seam: forget the cached key (e.g. after changing MFA_SECRET_KEY). */
function _reset() { cached = null; }

module.exports = { seal, open, keyFile, _reset };
