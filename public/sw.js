'use strict';

// Offline support for the installed (PWA / Android) app.
//
// A service worker sits in front of the network and answers from its own store, so it overrides
// HTTP caching entirely: `Cache-Control: no-cache` on a page means nothing once a worker decides
// to serve that page from its cache. That is worth stating plainly, because the previous version
// did exactly that and it took a day off the VPS cut-over.
//
// WHAT WENT WRONG, so it is not rebuilt the same way. The old worker cached '/', '/index.html' and
// '/js/live-client.js' by bare path and answered cache-first. index.html is the one file that must
// never be stale: it carries the ?v= token that versions every other asset. Serving yesterday's
// index.html hands out yesterday's tokens, so the whole cache-busting scheme silently stops
// working — and the cached live-client.js came back even after a hard reload, which is not
// something a service worker is obliged to bypass. Staff saw "LiveERP.connect is not a function"
// on the login screen and could not sign in, on machine after machine, while one browser that had
// never registered the worker was perfectly fine.
//
// THE RULES NOW:
//   1. Navigations and HTML     -> network first, always. Cache only as an offline fallback.
//   2. Assets carrying ?v=      -> cache first. They are immutable: a new build is a new URL.
//   3. /api/                    -> network only. Never a cached answer.
//   4. Anything else            -> network first, cache as fallback.
//
// Rule 3 is deliberate. This system's whole purpose is that a stock figure on screen is the real
// one; quietly serving a remembered balance because the connection dropped would be worse than
// showing an error. Offline reads are not worth a wrong number.

const CACHE = 'workshopone-v2';

// Only what is genuinely useful with no network. NOT index.html, and NOT any versioned asset.
const OFFLINE_FALLBACK = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.add(OFFLINE_FALLBACK))
      .catch(() => { /* first install with no network — nothing to pre-store */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A page can ask the worker to step aside immediately after an update, rather than waiting for
// every tab to close. app.js does this when it detects a new worker.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isVersioned = (url) => url.searchParams.has('v');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;      // someone else's server, not ours to cache

  // 3. The API is never answered from a cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // 1. Navigations and HTML: the network decides, so the ?v= tokens are always current.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(OFFLINE_FALLBACK, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(OFFLINE_FALLBACK).then((hit) => hit || Response.error()))
    );
    return;
  }

  // 2. Versioned assets are immutable — a new build changes the URL, so a hit is always correct.
  if (isVersioned(url)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 4. Everything else (icons, the manifest): fresh when possible, cached when not.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
