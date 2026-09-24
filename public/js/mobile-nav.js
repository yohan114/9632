'use strict';

// The bar along the bottom of a phone, standing in for the sidebar the mobile layout hides.
//
// EVERY ENTRY IS A REAL ROUTE. The first version sent the browser to "#jobs", "#mrn", "#oil" —
// the app routes on "#/jobs", and there is no "mrn" route at all (material requests are a tab of
// stores). So every tab on this bar cleared the screen instead of navigating. Anything added here
// has to be a hash the router actually answers to; the list of routes is `routes.<name>` in app.js.

(function () {
  // label, icon, and the hash the app router understands.
  const TABS = [
    { key: 'jobs', icon: '📋', label: 'Jobs', hash: '#/jobs' },
    { key: 'stores', icon: '📦', label: 'Stores', hash: '#/stores?tab=mrn' },
    { key: 'oil', icon: '🛢️', label: 'Oil & Lube', hash: '#/oil' },
    { key: 'assets', icon: '🚜', label: 'Assets', hash: '#/assets' },
    { key: 'server', icon: '⚙️', label: 'Server', action: 'configureServerIp' },
  ];

  document.addEventListener('DOMContentLoaded', () => {
    injectMobileBottomNav();
    syncActive();
    // Keep the highlight honest when the user navigates by any other means — a link in the page,
    // the back button, or the sidebar on a tablet held sideways.
    window.addEventListener('hashchange', syncActive);
  });

  function injectMobileBottomNav() {
    if (document.getElementById('mobile-bottom-nav')) return;
    const nav = document.createElement('nav');
    nav.id = 'mobile-bottom-nav';
    nav.className = 'mobile-bottom-nav';
    nav.innerHTML = TABS.map((t) => `
      <button type="button" class="mobile-nav-item" data-target="${t.key}">
        <span class="nav-icon">${t.icon}</span>
        <span class="nav-label">${t.label}</span>
      </button>`).join('');
    document.body.appendChild(nav);

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-nav-item');
      if (!btn) return;
      const tab = TABS.find((t) => t.key === btn.dataset.target);
      if (!tab) return;
      if (tab.action) { if (typeof window[tab.action] === 'function') window[tab.action](); return; }
      window.location.hash = tab.hash;
      syncActive();
    });
  }

  // Which tab is showing? Matched on the route name in the hash, so "#/stores?tab=grn" still
  // lights up Stores, and a screen that has no tab here (the dashboard, say) lights up none
  // rather than leaving the last one lit and lying about where you are.
  function syncActive() {
    const route = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/')[0];
    document.querySelectorAll('.mobile-nav-item').forEach((el) => {
      const tab = TABS.find((t) => t.key === el.dataset.target);
      const on = !!tab && !tab.action && tab.hash.replace(/^#\//, '').split('?')[0] === route;
      el.classList.toggle('active', on);
    });
  }

  window.navigateToMobileTab = function (key) {
    const tab = TABS.find((t) => t.key === key);
    if (!tab) return;
    if (tab.action) { if (typeof window[tab.action] === 'function') window[tab.action](); return; }
    window.location.hash = tab.hash;
    syncActive();
  };
})();
