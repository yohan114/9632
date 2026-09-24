'use strict';

// Time-based one-time passwords (RFC 6238) — the 6-digit codes of Google Authenticator,
// Microsoft Authenticator, and every other authenticator app.
//
// Written against Node's crypto rather than pulled in as a package: the whole algorithm is an HMAC,
// a truncation and a clock, and this is the code that decides who gets past the second lock, so it
// is short enough to read in full. test/mfa.test.js checks it against the RFC's own test vectors.

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side (±30 s) absorbs a phone clock that has drifted a little, without keeping a
// code alive long enough to be useful to someone reading it over a shoulder.
const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, the RFC's recommendation), as base32. */
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** HOTP (RFC 4226) for one counter value. `digits` defaults to 6. */
function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code an authenticator shows at time `ms` (default now). */
function codeAt(secretB32, ms = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secretB32), stepAt(ms), digits);
}

/**
 * Check a code. Returns the time step it matched (so the caller can refuse a replay of the same
 * code), or null. `lastStep` is the step of the last code this secret accepted: a code at or before
 * it has been used already and is refused, even if it is still inside the window.
 */
function verify(secretB32, code, { ms = Date.now(), lastStep = null } = {}) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const now = stepAt(ms);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue;
    const expected = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

/** The link an authenticator app understands (and the text a QR code would carry). */
function otpauthUri(secretB32, account, issuer = 'WorkshopOne') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** The secret in groups of four, for typing into a phone by hand. */
const grouped = (secretB32) => secretB32.replace(/(.{4})/g, '$1 ').trim();

module.exports = { newSecret, base32Encode, base32Decode, hotp, codeAt, verify, otpauthUri, grouped, STEP_SECONDS, DIGITS };
