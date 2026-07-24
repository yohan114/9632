/* WorkshopOne — live (real-time) client. Pure vanilla JS, no framework.
 *
 * - Lazily loads the socket.io browser client (served by the server at
 *   /socket.io/socket.io.js), then connects to the SAME origin.
 * - Exposes window.LiveERP = { on(event, cb), connectionStatus() }.
 * - Reflects connection state on <body> (.live-connected / .live-disconnected)
 *   and shows a tiny toast on drop / recovery. Reconnect uses socket.io's
 *   built-in mechanism.
 *
 * Usage from app code:
 *   LiveERP.on('stock_updated', (data) => refreshStores());
 */
(function () {
  'use strict';

  var socket = null;
  var status = 'connecting';            // connecting | connected | disconnected | error
  var pending = {};                      // event -> [cb]  (registered before socket exists)

  // -- minimal self-contained toast (no dependency on app.js) ---------------
  function toast(msg, kind) {
    var id = 'live-toast';
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);' +
        'z-index:99999;padding:8px 14px;border-radius:6px;font:13px/1.4 system-ui,Arial,sans-serif;' +
        'color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'ok' ? '#1f8f4e' : '#b4531f';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; }, kind === 'ok' ? 2500 : 4000);
  }

  // -- wire a live socket ---------------------------------------------------
  function bind() {
    // Same-origin connection; socket.io auto-detects the host from the page.
    socket = window.io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });

    socket.on('connect', function () {
      status = 'connected';
      document.body.classList.add('live-connected');
      document.body.classList.remove('live-disconnected');
    });

    socket.on('disconnect', function () {
      status = 'disconnected';
      document.body.classList.add('live-disconnected');
      document.body.classList.remove('live-connected');
      toast('Connection lost – retrying', 'warn');
    });

    // 'reconnect' fires on the Manager, only after a real reconnection (not the
    // first connect), so we won't show "Reconnected" on initial load.
    socket.io.on('reconnect', function () { toast('Reconnected', 'ok'); });

    // Attach any listeners registered before the socket existed.
    Object.keys(pending).forEach(function (ev) {
      pending[ev].forEach(function (cb) { socket.on(ev, cb); });
    });
  }

  // -- public API -----------------------------------------------------------
  window.LiveERP = {
    on: function (event, cb) {
      if (socket) { socket.on(event, cb); }
      else { (pending[event] = pending[event] || []).push(cb); }
      return this;
    },
    connectionStatus: function () { return status; },
  };

  // -- boot: ensure the socket.io client is present, then connect -----------
  function start() {
    if (typeof window.io !== 'undefined') { bind(); return; }
    var s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.async = true;
    s.onload = bind;
    s.onerror = function () { status = 'error'; document.body.classList.add('live-disconnected'); };
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
