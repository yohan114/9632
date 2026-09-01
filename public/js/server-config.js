'use strict';

// Where the app sends its API calls.
//
// There are only two situations, and conflating them took the whole company offline for an
// afternoon:
//
//   A PAGE SERVED OVER http(s) TALKS TO THE ORIGIN IT CAME FROM. Always, with no exceptions and
//   nothing configurable. If you loaded the page from storesdb.ec-workshops.online then that is
//   where its API is; there is no circumstance in which a browser should fetch this app's data
//   from somewhere else.
//
//   THE PACKAGED APP (Capacitor / file://) has no origin to talk to — it is loaded off the
//   device — so it, and only it, needs a server address configured.
//
// WHAT WENT WRONG. The old check for "is this the packaged app" included `!window.location.port`.
// A real domain has no port: location.port is "" for https on 443. So the production site matched,
// and every browser that visited it was pointed at a hard-coded LAN address — http://192.168.8.200
// :3000 — which no machine outside the workshop can reach, and which a browser will not even
// attempt from an https page because it is mixed content. The error shown was "Failed to fetch",
// which says nothing about any of this. The check was written thinking of http://localhost:1929;
// the author simply never had a real domain to test against.
//
// A SAVED ADDRESS IS ALSO CLEARED, not just ignored. PCs that had been used on the LAN had the old
// address in localStorage, so they stayed broken even once the code was fixed. Nobody should have
// to be talked through clearing browser storage over the phone.

(function () {
  const KEY = 'workshopone_server_url';

  // The packaged app, and nothing else. Capacitor injects its global; a file:// page has no server
  // of its own. Both are true only inside the Android/desktop wrapper.
  const isPackagedApp = !!window.Capacitor || window.location.protocol === 'file:';
  window.WORKSHOPONE_IS_PACKAGED_APP = isPackagedApp;

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode: no storage, no override */ }

  if (!isPackagedApp) {
    window.WORKSHOPONE_API_BASE = window.location.origin;
    if (saved) {
      // Self-healing: the machines worst affected are the ones that used the LAN version, and they
      // are exactly the ones nobody can walk through browser settings.
      try { localStorage.removeItem(KEY); } catch (e) { /* nothing more we can do */ }
      console.warn('WorkshopOne: ignored and cleared a saved server address (' + saved +
        '). A page served over the web always uses its own origin: ' + window.location.origin);
    }
    return;
  }

  // ---- packaged app only ----------------------------------------------------
  window.WORKSHOPONE_API_BASE = (saved || 'http://192.168.8.200:3000').replace(/\/+$/, '');

  window.configureServerIp = function () {
    const current = window.WORKSHOPONE_API_BASE || '';
    const input = prompt(
      'WorkshopOne server address.\n\n' +
      'Over the internet:  https://storesdb.ec-workshops.online\n' +
      'On the workshop network:  http://192.168.8.200:3000',
      current
    );
    if (!input || !input.trim()) return;

    let clean = input.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) {
      // Default to https for a hostname, http for a bare IP or anything with a port. Typing a
      // domain and silently getting http would send the workshop's data over the internet in the
      // clear.
      const looksLocal = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(clean) || /^localhost(:\d+)?$/i.test(clean);
      clean = (looksLocal ? 'http://' : 'https://') + clean;
    }
    try { localStorage.setItem(KEY, clean); } catch (e) { /* fall through to the reload anyway */ }
    window.WORKSHOPONE_API_BASE = clean;
    alert('Server address saved:\n' + clean + '\n\nReloading.');
    window.location.reload();
  };
})();
