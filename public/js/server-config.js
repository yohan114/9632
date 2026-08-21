'use strict';

(function () {
  const customUrl = localStorage.getItem('workshopone_server_url');
  // Only the packaged mobile app needs a server address: it is loaded from the device
  // (file:// or a portless localhost shell), so there is no API behind its own origin.
  // A page actually SERVED over http(s) from a port — including the workshop PC opening
  // http://localhost:1929 — must talk to its own origin, never a hard-coded IP.
  const isMobileApp = !!window.Capacitor
                      || window.location.protocol === 'file:'
                      || !window.location.port;

  if (customUrl) {
    window.WORKSHOPONE_API_BASE = customUrl.replace(/\/+$/, '');
  } else if (isMobileApp) {
    // Default server address for the mobile app on this network.
    window.WORKSHOPONE_API_BASE = 'http://192.168.8.200:3000';
  } else {
    window.WORKSHOPONE_API_BASE = window.location.origin;
  }

  window.configureServerIp = function () {
    const current = localStorage.getItem('workshopone_server_url') || window.WORKSHOPONE_API_BASE || 'http://192.168.8.200:3000';
    const input = prompt('Enter WorkshopOne Server URL (e.g. http://192.168.8.200:3000):', current);
    if (input && input.trim()) {
      let clean = input.trim().replace(/\/+$/, '');
      if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
        clean = 'http://' + clean;
      }
      localStorage.setItem('workshopone_server_url', clean);
      window.WORKSHOPONE_API_BASE = clean;
      alert('Server URL saved: ' + clean + '\nReloading app...');
      window.location.reload();
    }
  };
})();
