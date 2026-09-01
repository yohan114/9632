'use strict';

// Slowing down someone guessing passwords.
//
// On the workshop LAN this did not matter much: to reach the login page you had to be standing in
// the building. Behind a public domain it matters a great deal — a login page on the open internet
// is found by scanners within hours of the DNS resolving, and an unlimited number of guesses
// against a short password is only a matter of time.
//
// Deliberately in-memory and dependency-free. The app is one Node process behind pm2 or systemd,
// so a Map is the whole story, and a restart clearing the counters is acceptable: an attacker
// cannot restart the server, and a locked-out storekeeper is unblocked by the wait, not a reboot.
//
// TWO KEYS, NOT ONE. Counting only by username lets one attacker lock every real user out of the
// system — a denial of service handed over for free. Counting only by address lets a botnet spread
// its guesses. So both are counted, and either tripping is enough to refuse.

const int = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const WINDOW_MS = 15 * 60 * 1000;      // how long a run of failures is remembered
const MAX_PER_USER = int('RATELIMIT_MAX_PER_USER', 8);   // guesses at one username before it rests

// AN OFFICE IS ONE ADDRESS. This was 30, chosen when the app was on the workshop LAN and every PC
// had its own address. Behind Cloudflare it is the opposite: everyone in the building shares the
// company's single public address, so this is not "one attacker's budget", it is the WHOLE
// COMPANY'S budget for mistyped passwords in a quarter of an hour. Thirty was reached on the first
// morning, and the entire office was locked out together while one person who happened to be on a
// phone connection could still sign in.
//
// Raised, and made adjustable without a code change. The real protection against guessing a
// particular person's password is MAX_PER_USER, which is untouched at 8: an attacker who spreads
// guesses across usernames to stay under this ceiling still only gets 8 tries at each. This number
// exists to slow a botnet spraying many names, and it still does that.
const MAX_PER_IP = int('RATELIMIT_MAX_PER_IP', 120);

const LOCKOUT_MS = 15 * 60 * 1000;

const buckets = new Map();             // key -> { count, first, until }

const now = () => Date.now();

function bucket(key) {
  const b = buckets.get(key);
  if (!b) return null;
  // A window that has run its course is forgotten entirely, so an honest user who mistyped
  // twice last week starts from nothing.
  if (b.until && b.until <= now()) { buckets.delete(key); return null; }
  if (!b.until && now() - b.first > WINDOW_MS) { buckets.delete(key); return null; }
  return b;
}

/** How long this key must wait, in seconds. 0 = go ahead. */
function retryAfter(key) {
  const b = bucket(key);
  return b && b.until ? Math.ceil((b.until - now()) / 1000) : 0;
}

/**
 * Is this attempt allowed? Checked BEFORE the password is verified, so a locked key costs nothing
 * to refuse. Returns 0 when allowed, or the seconds to wait.
 */
function check(ip, username) {
  return Math.max(retryAfter('ip:' + ip), retryAfter('user:' + String(username || '').toLowerCase()));
}

/** A wrong password. Counts against both the name tried and the address that tried it. */
function fail(ip, username) {
  for (const [key, max] of [['ip:' + ip, MAX_PER_IP], ['user:' + String(username || '').toLowerCase(), MAX_PER_USER]]) {
    const b = bucket(key) || { count: 0, first: now(), until: 0 };
    b.count += 1;
    if (b.count >= max) b.until = now() + LOCKOUT_MS;
    buckets.set(key, b);
  }
}

/** A correct password clears the slate for that user and address — a good login is proof enough. */
function succeed(ip, username) {
  buckets.delete('ip:' + ip);
  buckets.delete('user:' + String(username || '').toLowerCase());
}

/** Test seam, and a way to clear a lockout by hand if someone locks themselves out. */
function reset() { buckets.clear(); }

module.exports = { check, fail, succeed, reset, WINDOW_MS, MAX_PER_USER, MAX_PER_IP, LOCKOUT_MS };
