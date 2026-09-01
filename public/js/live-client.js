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
    if (socket) { socket.connect(); return; }   // re-open the one we already have (after a login)

    // Same-origin connection; socket.io auto-detects the host from the page.
    socket = window.io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000 });

    socket.on('connect', function () {
      status = 'connected';
      document.body.classList.add('live-connected');
      document.body.classList.remove('live-disconnected');
    });

    // The server refuses a socket that carries no valid session (see src/server.js). That is a
    // normal state on the login page, NOT a fault: retrying it once a second forever would spin
    // and toast at someone who simply has not signed in yet. So stop, quietly, and wait to be
    // asked again — app.js calls LiveERP.connect() once a session exists.
    socket.on('connect_error', function (err) {
      if (!err || err.message !== 'unauthorized') return;   // a real outage: let socket.io retry
      status = 'unauthenticated';
      socket.io.reconnection(false);
      socket.disconnect();
      document.body.classList.remove('live-connected');
    });

    socket.on('disconnect', function () {
      if (status === 'unauthenticated') return;             // expected; already explained above
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

    // Called by app.js once a session exists (sign-in, or a page load that finds one already).
    // Safe to call repeatedly — it is a no-op while a socket is up.
    connect: function () {
      if (socket && socket.connected) return this;
      if (socket) { status = 'connecting'; socket.io.reconnection(true); }
      start();
      return this;
    },

    // Called on sign-out: the socket carries the credentials of whoever just left, and the events
    // on it are not theirs to keep receiving.
    disconnect: function () {
      status = 'unauthenticated';
      if (socket) { socket.io.reconnection(false); socket.disconnect(); }
      document.body.classList.remove('live-connected', 'live-disconnected');
      return this;
    },
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
