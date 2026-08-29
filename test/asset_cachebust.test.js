'use strict';

// Every script and stylesheet the page loads must carry the per-boot token.
//
// This is not tidiness. The SPA is several files that browsers cache independently, so a visitor
// can end up holding a NEW app.js against an OLD /js/live-client.js. That is exactly what happened
// on the VPS the day the socket gained authentication: app.js called LiveERP.connect(), the cached
// client had no such function, and the login screen reported
//
//     Server connection issue: LiveERP.connect is not a function
//
// Nobody could sign in, because of a stale copy of an optional feature. The quieter half was
// worse — the stale client had no handling for a refused socket and retried once a second forever,
// so every open tab became a permanent stream of failing connections and the site felt slow.
//
// The token only covered app.js and styles.css at the time. This pins the rule for every asset,
// because the next file added under /js/ will be added by someone who has forgotten all of this.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-cachebust-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
require('../src/db').migrate();

const app = require('../src/server');
let server; let base;
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

// src="..." / href="..." for local .js and .css, ignoring anything absolute (a CDN is not ours to
// version) and the manifest (not code).
function localAssets(html) {
  const out = [];
  const re = /(?:src|href)="(\/[^"]+?\.(?:js|css))(\?[^"]*)?"/g;
  let m;
  while ((m = re.exec(html))) out.push({ file: m[1], query: m[2] || '' });
  return out;
}

test('every local script and stylesheet is versioned', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const assets = localAssets(html);
  assert.ok(assets.length >= 4, `expected the SPA's several assets, found ${assets.length}`);

  const bare = assets.filter((a) => !/^\?v=/.test(a.query)).map((a) => a.file);
  assert.deepStrictEqual(bare, [],
    'these load whatever the browser cached last, which may be from before the deploy: ' + bare.join(', '));
});

test('the files under /js/ are covered, not just app.js', async () => {
  // The regression that caused the outage: app.js and styles.css were versioned and /js/* was not.
  const html = await (await fetch(`${base}/`)).text();
  const js = localAssets(html).filter((a) => a.file.startsWith('/js/'));
  assert.ok(js.length >= 2, 'expected several files under /js/ — has the page been restructured?');
  for (const a of js) {
    assert.match(a.query, /^\?v=\d+/, `${a.file} is not versioned`);
  }
});

test('the token is the same across a single page load', async () => {
  // One token per boot. Mixed tokens would mean assets from different builds on the same page,
  // which is the very mismatch this exists to prevent.
  const html = await (await fetch(`${base}/`)).text();
  const tokens = new Set(localAssets(html).map((a) => a.query));
  assert.strictEqual(tokens.size, 1, `assets carry different versions: ${[...tokens].join(' ')}`);
});

test('the page itself is never cached, or the tokens inside it would be stale too', async () => {
  const r = await fetch(`${base}/`);
  assert.match(r.headers.get('cache-control') || '', /no-cache/,
    'the token lives in the HTML; a cached page hands out cached tokens and the whole scheme stops working');
});

test('a deep SPA route is served the same versioned page', async () => {
  // Hard reloads land on /#/... paths, which the catch-all serves. It must go through the same
  // rewriting, or a bookmarked page loads unversioned assets.
  const html = await (await fetch(`${base}/stores/mrn`)).text();
  const bare = localAssets(html).filter((a) => !/^\?v=/.test(a.query)).map((a) => a.file);
  assert.deepStrictEqual(bare, [], 'unversioned on a deep route: ' + bare.join(', '));
});
