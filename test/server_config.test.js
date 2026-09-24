'use strict';

// Where the browser sends its API calls.
//
// This one file took the whole company offline for an afternoon, so it gets tested despite being
// twenty lines of front-end glue. The old "is this the packaged mobile app?" check included
// `!window.location.port` — and a real domain has no port, since location.port is "" for https on
// 443. So https://storesdb.ec-workshops.online matched, and every browser that visited the live
// site was pointed at a hard-coded LAN address that nothing outside the workshop can reach. The
// only thing on screen was "Failed to fetch".
//
// Run in a hand-built window rather than a browser: the file is a plain IIFE reading `location`
// and `localStorage`, both of which are easy to fake honestly.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'server-config.js'), 'utf8');

// A minimal window. `store` is the localStorage contents, so a test can start with the stale LAN
// address a workshop PC would really have had.
function run({ href, capacitor = false, store = {} } = {}) {
  const url = new URL(href);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const win = {
    location: {
      href, origin: url.origin, protocol: url.protocol,
      port: url.port, hostname: url.hostname,
      reload() {},
    },
    localStorage,
    console: { warn() {}, log() {} },
    prompt: () => null,
    alert: () => {},
  };
  if (capacitor) win.Capacitor = {};
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return { base: win.WORKSHOPONE_API_BASE, packaged: win.WORKSHOPONE_IS_PACKAGED_APP, store };
}

test('the live site talks to itself, not to a LAN address', () => {
  const r = run({ href: 'https://storesdb.ec-workshops.online/' });
  assert.strictEqual(r.base, 'https://storesdb.ec-workshops.online');
  assert.strictEqual(r.packaged, false,
    'a domain has no port; treating "no port" as "mobile app" is what broke every company PC');
});

test('a stale LAN address saved on a workshop PC is ignored AND cleared', () => {
  // These machines had used the LAN version for months. Ignoring the value would leave them broken
  // on the next visit; nobody should be talked through clearing browser storage by phone.
  const store = { workshopone_server_url: 'http://192.168.8.200:3000' };
  const r = run({ href: 'https://storesdb.ec-workshops.online/', store });
  assert.strictEqual(r.base, 'https://storesdb.ec-workshops.online');
  assert.strictEqual('workshopone_server_url' in r.store, false, 'the stale value must be removed, not just skipped');
});

test('an http override on an https page cannot be honoured', () => {
  // Browsers block mixed content outright, so this could only ever produce "Failed to fetch".
  const r = run({ href: 'https://storesdb.ec-workshops.online/', store: { workshopone_server_url: 'http://10.0.0.9:3000' } });
  assert.ok(r.base.startsWith('https://'), 'must never leave the app calling http from an https page');
});

test('the office PC on the LAN still works', () => {
  const r = run({ href: 'http://192.168.8.200:3000/' });
  assert.strictEqual(r.base, 'http://192.168.8.200:3000');
});

test('a developer on localhost with a port still works', () => {
  const r = run({ href: 'http://localhost:1929/' });
  assert.strictEqual(r.base, 'http://localhost:1929');
  assert.strictEqual(r.packaged, false);
});

test('the packaged app is still allowed a configured address', () => {
  // The one case that genuinely needs it: loaded off the device, no origin of its own.
  const r = run({ href: 'https://localhost/', capacitor: true, store: { workshopone_server_url: 'https://storesdb.ec-workshops.online' } });
  assert.strictEqual(r.packaged, true);
  assert.strictEqual(r.base, 'https://storesdb.ec-workshops.online');
});

test('the packaged app falls back to the workshop server when nothing is set', () => {
  const r = run({ href: 'file:///android_asset/www/index.html', capacitor: false });
  assert.strictEqual(r.packaged, true, 'file:// has no server of its own');
  assert.strictEqual(r.base, 'http://192.168.8.200:3000');
});

test('a browser with no storage at all still resolves an origin', () => {
  // Private browsing throws on localStorage access. Sign-in must not depend on it.
  const url = new URL('https://storesdb.ec-workshops.online/');
  const win = {
    location: { href: url.href, origin: url.origin, protocol: url.protocol, port: url.port, hostname: url.hostname, reload() {} },
    get localStorage() { throw new Error('access denied'); },
    console: { warn() {} },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  assert.strictEqual(win.WORKSHOPONE_API_BASE, 'https://storesdb.ec-workshops.online');
});
