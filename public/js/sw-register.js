'use strict';

// Registers the service worker. A file of its own, not an inline script: the browser's
// Content-Security-Policy refuses inline scripts (access plan, Part 4).
//
// The service worker gives the installed app something to show with no network. It also sits
// in front of every request, so a stale one can serve stale code indefinitely — that is what
// stranded staff on "LiveERP.connect is not a function" and survived hard reloads. Two guards:
// ask the browser to check for a new worker on every load, and when one is waiting, tell it to
// take over at once and reload rather than waiting for every tab to be closed.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update();
      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          // 'installed' with a controller present means an UPDATE, not a first install.
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            fresh.postMessage('skip-waiting');
          }
        });
      });
    }).catch(err => console.error('SW reg error:', err));

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;          // guard: controllerchange can fire more than once
      reloading = true;
      location.reload();
    });
  });
}
