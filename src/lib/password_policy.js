'use strict';

// What counts as an acceptable password. One rule set, used everywhere a password is chosen: the
// change-password screen, an admin creating or resetting an account, and scripts/admin.js.
//
// It used to be "at least 6 characters". Behind a public domain that is not enough: a six-letter
// password falls to a guessing run in a day even with the login rate limiter slowing it, and the
// passwords people actually choose in a workshop are the obvious ones — the company name, the
// place, "workshop" with the year on the end.
//
// The rules follow current guidance (NIST SP 800-63B): LENGTH plus a check against known-bad and
// context words. No "must contain a capital, a digit and a symbol" — that produces Workshop@2026,
// which is the first thing an attacker tries. No forced expiry either: people who must change
// every 90 days write the new one on the monitor.

const MIN_LENGTH = (() => {
  const v = parseInt(process.env.PASSWORD_MIN_LENGTH, 10);
  return Number.isFinite(v) && v >= 8 ? v : 10;
})();
// bcrypt ignores everything after 72 bytes. A longer password is not wrong, it is just silently
// shortened — so cap it well above any real one and say so, rather than pretend.
const MAX_LENGTH = 72;

// Passwords that appear at the top of every leaked-password list, plus the words someone at this
// company would reach for first. Compared after lower-casing and stripping digits and symbols, so
// "Workshop@2026" and "workshop123" are both caught by the one word.
const COMMON = new Set([
  'password', 'passw', 'pass', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'abc',
  'abcdef', 'abcdefgh', 'abcdefghij', 'letmein', 'welcome', 'admin', 'administrator', 'root',
  'login', 'user', 'test', 'guest', 'master', 'secret', 'changeme', 'default', 'temp', 'temppass',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'football', 'cricket', 'princess', 'superman',
  'srilanka', 'colombo', 'lanka',
  // this company and this system
  'workshop', 'workshopone', 'edward', 'christie', 'edwardchristie', 'edwardandchristie', 'ec',
  'badalgama', 'storesdb', 'stores', 'store', 'storekeeper', 'mechanic', 'transport', 'manager',
]);

const lettersOnly = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
// "P@ssw0rd2026" is "password" to anyone guessing. Drop the digits and symbols stuck on either end
// (the year, the "!"), then read the usual swaps back as letters. Only the ends are trimmed, so a
// real mixed password is not flattened into a word it never was.
const LEET = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '0': 'o', '$': 's', '5': 's', '7': 't' };
const unLeet = (s) => String(s).replace(/^[^a-z]+|[^a-z]+$/gi, '').replace(/[@43105$7]/g, (c) => LEET[c]);

/**
 * Why this password is not acceptable, as a sentence for the person choosing it — or null if it
 * is fine.
 * @param {string} pw
 * @param {{username?: string}} [ctx]
 */
function problem(pw, ctx = {}) {
  const s = String(pw == null ? '' : pw);
  if (s.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (Buffer.byteLength(s, 'utf8') > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  if (new Set(s.toLowerCase()).size < 4) return 'Password is too simple — use at least 4 different characters.';
  const core = lettersOnly(s);
  if (!core) return 'Password must contain some letters, not only numbers or symbols.';
  if (COMMON.has(core) || COMMON.has(lettersOnly(unLeet(s)))) {
    return 'That password is too common or too easy to guess. Try a few unrelated words together.';
  }
  const user = String(ctx.username || '').toLowerCase();
  if (user.length >= 3 && s.toLowerCase().includes(user)) return 'Password must not contain your username.';
  return null;
}

/** What the screens need to know to help someone before they submit. */
function describe() {
  return { minLength: MIN_LENGTH, maxLength: MAX_LENGTH };
}

module.exports = { problem, describe, MIN_LENGTH, MAX_LENGTH };
