'use strict';

/**
 * WorkshopOne Role-Aware Mobile Bottom Navigation
 *
 * Replaces static hardcoded tabs with dynamic RBAC-filtered primary shortcuts
 * computed from window.NAV + window.navVisible + signed-in user scope, plus
 * a Menu drawer trigger connected to window.WONav.toggleDrawer().
 */
(function () {
  const SHORT_LABELS = {
    dashboard: 'Home',
    'master-dashboard': 'Cockpit',
    jobs: 'Jobs',
    stores: 'Stores',
    fuel: 'Fuel',
    assets: 'Assets',
    purchasing: 'Buying',
    reports: 'Reports',
    'fuel-readings': 'Readings',
    'fuel-tanks': 'Tanks',
    'fuel-alerts': 'Alerts',
    'transport-fuel': 'Transport',
  };

  let currentTabs = [];
  let lastUserSig = null;

  function currentMe() {
    if (typeof window !== 'undefined' && window.woShellBridge && typeof window.woShellBridge.getMe === 'function') {
      return window.woShellBridge.getMe();
    }
    if (typeof ME !== 'undefined') return ME;
    return null;
  }

  function safeEsc(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildMobileTabs(meOverride) {
    const me = meOverride || currentMe();
    if (!me) return [];

    const nav = (typeof window !== 'undefined' && window.NAV) || (typeof NAV !== 'undefined' ? NAV : []);
    const isVis = (typeof window !== 'undefined' && typeof window.navVisible === 'function')
      ? window.navVisible
      : (typeof navVisible === 'function' ? navVisible : () => true);

    let priority;
    if (me.fuelScope && me.fuelScope.isPumpOnly) {
      priority = ['fuel', 'fuel-readings', 'fuel-tanks', 'fuel-alerts'];
    } else if (me.fuelScope && me.fuelScope.isRequesterOnly) {
      priority = ['transport-fuel', 'fuel', 'assets', 'dashboard'];
    } else {
      priority = ['dashboard', 'jobs', 'stores', 'fuel', 'assets', 'master-dashboard', 'purchasing', 'reports'];
    }

    const tabs = [];
    for (const key of priority) {
      if (tabs.length >= 4) break;
      const entry = nav.find((n) => n[0] === key);
      if (!entry) continue;
      if (!isVis(entry)) continue;
      let hash = entry[4] || `#/${entry[0]}`;
      if (entry[0] === 'fuel' && me.fuelScope && me.fuelScope.isPumpOnly) {
        hash = '#/fuel?tab=site-console';
      }
      tabs.push({
        key: entry[0],
        icon: entry[1],
        label: SHORT_LABELS[entry[0]] || entry[2],
        hash,
      });
    }

    tabs.push({
      key: '__menu',
      icon: '☰',
      label: 'Menu',
      action: 'toggleNavDrawer',
    });

    return tabs;
  }

  function injectMobileBottomNav() {
    let nav = document.getElementById('mobile-bottom-nav');
    if (nav) return nav;
    nav = document.createElement('nav');
    nav.id = 'mobile-bottom-nav';
    nav.className = 'mobile-bottom-nav';
    nav.setAttribute('aria-label', 'Mobile quick navigation');
    document.body.appendChild(nav);

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-nav-item');
      if (!btn) return;
      const tab = currentTabs.find((t) => t.key === btn.dataset.target);
      if (!tab) return;
      if (tab.action === 'toggleNavDrawer') {
        if (window.WONav && typeof window.WONav.toggleDrawer === 'function') {
          window.WONav.toggleDrawer();
        } else {
          const drawer = document.getElementById('nav');
          if (drawer) drawer.classList.toggle('open');
        }
        syncActive();
        return;
      }
      if (tab.action && typeof window[tab.action] === 'function') {
        window[tab.action]();
        return;
      }
      if (window.WONav && typeof window.WONav.closeDrawer === 'function') {
        window.WONav.closeDrawer();
      }
      window.location.hash = tab.hash;
      syncActive();
    });

    return nav;
  }

  function renderTabsDom(nav, tabs) {
    nav.innerHTML = tabs.map((t) => `
      <button type="button" class="mobile-nav-item" data-target="${safeEsc(t.key)}">
        <span class="nav-icon">${t.icon}</span>
        <span class="nav-label">${safeEsc(t.label)}</span>
      </button>`).join('');
  }

  function syncActive() {
    const route = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'dashboard';
    const drawerEl = document.getElementById('nav');
    const drawerOpen = !!(drawerEl && drawerEl.classList.contains('open'));
    document.querySelectorAll('#mobile-bottom-nav .mobile-nav-item').forEach((el) => {
      const tab = currentTabs.find((t) => t.key === el.dataset.target);
      if (!tab) return;
      if (tab.key === '__menu') {
        el.classList.toggle('active', drawerOpen);
        return;
      }
      const tabRoute = String(tab.hash || '').replace(/^#\//, '').split('?')[0];
      el.classList.toggle('active', !drawerOpen && tabRoute === route);
    });
  }

  function refreshMobileNav() {
    const nav = injectMobileBottomNav();
    const me = currentMe();
    if (!me) {
      nav.classList.remove('has-session');
      lastUserSig = null;
      return;
    }

    nav.classList.add('has-session');
    const sig = `${me.id}:${(me.roles || []).join(',')}:${me.fuelScope ? (me.fuelScope.isPumpOnly ? 'P' : me.fuelScope.isRequesterOnly ? 'R' : 'F') : ''}`;
    if (sig !== lastUserSig || !nav.children.length) {
      currentTabs = buildMobileTabs(me);
      renderTabsDom(nav, currentTabs);
      lastUserSig = sig;
    }
    syncActive();
  }

  document.addEventListener('DOMContentLoaded', () => {
    refreshMobileNav();
    window.addEventListener('hashchange', syncActive);
  });

  window.buildMobileTabs = buildMobileTabs;
  window.refreshMobileNav = refreshMobileNav;
  window.navigateToMobileTab = function (key) {
    const tab = currentTabs.find((t) => t.key === key);
    if (!tab) return;
    if (tab.action === 'toggleNavDrawer') {
      if (window.WONav && typeof window.WONav.toggleDrawer === 'function') window.WONav.toggleDrawer();
      return;
    }
    if (tab.action && typeof window[tab.action] === 'function') {
      window[tab.action]();
      return;
    }
    window.location.hash = tab.hash;
    syncActive();
  };
})();
