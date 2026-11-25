'use strict';

/**
 * WorkshopOne Unified Navigation & Persistent Shell Module (Phases 1-5)
 *
 * Responsibilities:
 *  - Persistent app shell lifecycle (topbar, collapsible grouped sidebar, breadcrumb)
 *  - Domain-aligned collapsible group accordions with per-user persistence
 *  - Quick menu filter, pinned shortcuts (up to 5), and desktop compact icon-rail toggle
 *  - Keyboard-driven Ctrl+K / Cmd+K Command Palette (pages, sub-tabs, live asset/job/item search)
 *  - Live RBAC-scoped operational badge counts (Needs Attention, Fuel Alerts, Alias Queue)
 *  - Mobile drawer open/close & backdrop handling synced with mobile-nav.js
 */
(function () {
  const GROUP_META = {
    'Overview': { icon: '🧭', defaultOpen: true },
    'Workshop & Maintenance': { icon: '🔧', defaultOpen: true },
    'Fuel Management': { icon: '⛽', defaultOpen: true },
    'Stores & Procurement': { icon: '📦', defaultOpen: false },
    'Fleet & Master Data': { icon: '🚜', defaultOpen: false },
    'Finance & Costing': { icon: '💰', defaultOpen: false },
    'Reports & Hygiene': { icon: '📈', defaultOpen: false },
    'Administration': { icon: '🔐', defaultOpen: false },
  };

  const AUX_LABELS = {
    jobrequests: 'Job Requests',
    mechanicskpi: 'Mechanics KPI',
    jobreview: 'Job Review',
    stocktake: 'Stock & Inventory',
    stockcockpit: 'Stock Cockpit',
    generalstock: 'General Stock',
    oil: 'Oil & Lube',
    batteries: 'Batteries',
    filters: 'Filter Replacement',
    filterstock: 'Filter Stock',
    stockissues: 'Stock Issues',
    matreq: 'Material Requests',
    hire: 'Machine Hire & Billing',
    workshops: 'Workshops',
    auditlogs: 'Audit Logs',
    users: 'People & Users',
  };

  const QUICK_SUBTABS = [
    { parent: 'stores', label: 'Stores → Material Requests (MRN)', sub: 'Inventory request workflow', hash: '#/stores?tab=mrn', icon: '📦', keywords: 'mrn requisition request material' },
    { parent: 'stores', label: 'Stores → On-Hand Stock', sub: 'Current shelf balances & search', hash: '#/stores?tab=onhand', icon: '📦', keywords: 'stock balance shelf items inventory' },
    { parent: 'stores', label: 'Stores → Site Stores & Locations', sub: 'Main depot & site sub-stores', hash: '#/stores?tab=locations', icon: '🏪', keywords: 'locations site store depot' },
    { parent: 'stores', label: 'Stores → Material Transfers (MTN)', sub: 'Inter-store dispatch & receive', hash: '#/stores?tab=transfers', icon: '🚚', keywords: 'mtn transfer dispatch receive' },
    { parent: 'stores', label: 'Stores → Goods Received (GRN)', sub: 'Supplier deliveries & receipts', hash: '#/stores?tab=grn', icon: '🧾', keywords: 'grn goods received note' },
    { parent: 'fuel', label: 'Fuel Operations → Site Pump Console', sub: 'Pump dispensing console', hash: '#/fuel?tab=site-console', icon: '⛽', keywords: 'pump dispenser console site' },
    { parent: 'fuel', label: 'Fuel Operations → Fuel Issues Ledger', sub: 'Fuel issue entries & slips', hash: '#/fuel', icon: '⛽', keywords: 'fuel issues log slips diesel' },
    { parent: 'jobs', label: 'Job Cards → Job Requests', sub: 'Raise, certify & approve requests', hash: '#/jobrequests', icon: '📋', keywords: 'jr job request approve certify' },
    { parent: 'access', label: 'Access Control → People & Users', sub: 'Accounts, roles & caps', hash: '#/access?tab=people', icon: '👥', keywords: 'users accounts password staff' },
    { parent: 'access', label: 'Access Control → Audit Logs', sub: 'System security trail', hash: '#/access?tab=auditlogs', icon: '📜', keywords: 'audit log history security' },
    { parent: 'access', label: 'Access Control → Stand-In Delegations', sub: 'Approval hand-overs', hash: '#/access?tab=stand_ins', icon: '🛡️', keywords: 'stand in delegation handover' },
  ];

  const ROUTE_KEYWORDS = {
    'master-dashboard': 'cockpit executive kpi overview data hygiene',
    'dashboard': 'home summary kpis',
    'transport-fuel': 'chart bowser log daily transport',
    'fuel': 'diesel petrol dispense slip pump',
    'vehicle-costing': 'p&l pnl profit loss vehicle costing breakdown',
    'fleet-profitability': 'p&l pnl revenue margin profit monthly seal',
    'hire-billing': 'rental hire billing invoice rate',
    'fuel-tanks': 'tank bowser capacity bulk dip delivery',
    'fuel-readings': 'meter pump opening closing reading',
    'fuel-prices': 'tariff price rate effective date',
    'fuel-reports': 'norms efficiency l/hr km/l',
    'fuel-alerts': 'discrepancy variance warning low stock',
    'vehicledocuments': 'erl insurance fitness revenue licence expiry',
    'aliases': 'unresolved queue match duplicate',
    'attention': 'alerts overdue service anomaly integrity',
    'tbrequests': 'tyre battery tire request',
    'tyrebattery': 'tyre battery ledger',
    'lubecapacities': 'oil specs capacities lubricant',
    'serviceplan': 'pm preventive maintenance filter schedule',
    'teardown': 'cost teardown analytics',
  };

  const TAB_LABELS = {
    mrn: 'Material Requests (MRN)',
    mtn: 'Transfers (MTN)',
    transfers: 'Transfers (MTN)',
    onhand: 'On-Hand Stock',
    locations: 'Store Locations',
    grn: 'Goods Received (GRN)',
    'site-console': 'Site Pump Console',
    people: 'People & Users',
    auditlogs: 'Audit Logs',
    stand_ins: 'Stand-In Delegations',
    governance: 'Governance',
    roles: 'Roles',
  };

  const state = {
    mountedKey: null,
    currentRoute: 'dashboard',
    filterQuery: '',
    groupOpen: {},
    pins: [],
    compact: false,
    badges: {},
    paletteOpen: false,
    paletteResults: [],
    paletteIndex: 0,
    paletteSeq: 0,
    paletteDebounce: null,
    badgeRefreshTimer: null,
    badgeInterval: null,
    clockInterval: null,
    windowListenersBound: false,
  };

  function bridge() {
    return (typeof window !== 'undefined' && window.woShellBridge) || {};
  }

  function getMe() {
    const b = bridge();
    if (typeof b.getMe === 'function') return b.getMe();
    return typeof ME !== 'undefined' ? ME : (typeof window !== 'undefined' ? window.ME : null);
  }

  function getNav() {
    return (typeof window !== 'undefined' && window.NAV) || [];
  }

  function getGroupOrder() {
    return (typeof window !== 'undefined' && window.NAV_GROUP_ORDER) || Object.keys(GROUP_META);
  }

  function getNavGroupMap() {
    return (typeof window !== 'undefined' && window.NAV_GROUP) || {};
  }

  function isNavVisible(n) {
    if (typeof window !== 'undefined' && typeof window.navVisible === 'function') return !!window.navVisible(n);
    return true;
  }

  function getDefaultHome() {
    if (typeof window !== 'undefined' && typeof window.defaultHomeHash === 'function') return window.defaultHomeHash();
    return '#/dashboard';
  }

  function canViewSec(sec) {
    if (typeof canView === 'function') return !!canView(sec);
    if (typeof window !== 'undefined' && typeof window.canView === 'function') return !!window.canView(sec);
    return false;
  }

  function isAdminUser(me) {
    if (typeof isAdmin === 'function') return !!isAdmin();
    if (typeof window !== 'undefined' && typeof window.isAdmin === 'function') return !!window.isAdmin();
    return !!(me && me.roles && me.roles.includes('admin'));
  }

  function callApi(path, opts) {
    const fn = typeof api === 'function' ? api : (typeof window !== 'undefined' ? window.api : null);
    if (typeof fn !== 'function') return Promise.resolve(null);
    return fn(path, opts);
  }

  function showToast(msg, kind) {
    const fn = typeof toast === 'function' ? toast : (typeof window !== 'undefined' ? window.toast : null);
    if (typeof fn === 'function') fn(msg, kind);
  }

  function safeLsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function safeLsSet(key, val) {
    try { localStorage.setItem(key, val); } catch {}
  }

  function safeLsJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function groupStorageKey(me) {
    return `wo_nav_groups_${(me && me.id) || 'anon'}`;
  }

  function pinStorageKey(me) {
    return `wo_nav_pins_${(me && me.id) || 'anon'}`;
  }

  function loadUserPrefs(me) {
    const navItems = getNav().filter((n) => isNavVisible(n));
    const smallMenu = navItems.length <= 10;
    const savedGroups = safeLsJson(groupStorageKey(me), null);
    const openMap = {};
    for (const g of getGroupOrder()) {
      if (savedGroups && typeof savedGroups[g] === 'boolean') {
        openMap[g] = savedGroups[g];
      } else {
        const meta = GROUP_META[g] || { defaultOpen: false };
        openMap[g] = smallMenu ? true : !!meta.defaultOpen;
      }
    }
    state.groupOpen = openMap;

    const savedPins = safeLsJson(pinStorageKey(me), []);
    state.pins = Array.isArray(savedPins) ? savedPins.slice(0, 5) : [];
    state.compact = safeLsGet('wo_nav_collapsed', '0') === '1';
  }

  function saveGroupPrefs() {
    const me = getMe();
    if (!me) return;
    safeLsSet(groupStorageKey(me), JSON.stringify(state.groupOpen));
  }

  function savePinPrefs() {
    const me = getMe();
    if (!me) return;
    safeLsSet(pinStorageKey(me), JSON.stringify(state.pins));
  }

  function activeStoreLabelFor(me) {
    return (me && me.storeName)
      || (me && me.primaryStore && me.primaryStore.store_name)
      || (me && me.storeLocations && me.storeLocations.length && me.storeLocations[0].store_name)
      || (me && me.workshop && me.workshop.name)
      || 'Central Main Stores';
  }

  function getGroupForRoute(route) {
    return getNavGroupMap()[route] || 'Overview';
  }

  function getLabelForRoute(route) {
    const entry = getNav().find((n) => n[0] === route);
    if (entry) return entry[2];
    if (AUX_LABELS[route]) return AUX_LABELS[route];
    return route.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function badgeHtmlFor(route) {
    const b = state.badges && state.badges[route];
    const count = b && Number(b.count) > 0 ? Number(b.count) : 0;
    const tone = (b && b.tone) === 'red' ? 'tone-red' : 'tone-amber';
    const text = count > 99 ? '99+' : String(count);
    return `<span class="nav-badge ${tone}" data-badge-route="${esc(route)}" style="display:${count > 0 ? 'inline-flex' : 'none'}">${esc(text)}</span>`;
  }

  function renderPinnedSectionHtml() {
    const nav = getNav();
    const visiblePins = state.pins
      .map((r) => nav.find((n) => n[0] === r))
      .filter((n) => n && isNavVisible(n));

    if (!visiblePins.length) return '';

    const rows = visiblePins.map((n) => {
      const r = n[0];
      const active = state.currentRoute === r ? 'active' : '';
      return `
        <div class="nav-item-row" data-filter-label="${esc((n[2] + ' ' + r).toLowerCase())}">
          <a href="${esc(n[4] || '#/' + r)}" class="nav-link ${active}" data-route="${esc(r)}" title="${esc(n[2])}">
            <span class="ico">${n[1]}</span>
            <span class="nav-text">${esc(n[2])}</span>
            ${badgeHtmlFor(r)}
          </a>
          <button type="button" class="nav-pin-btn is-pinned" data-pin-route="${esc(r)}" title="Unpin shortcut" aria-label="Unpin ${esc(n[2])}">★</button>
        </div>
      `;
    }).join('');

    return `
      <div class="nav-pinned-block">
        <div class="nav-group-static"><span class="nav-group-static-ico">★</span><span class="nav-group-static-label">Pinned</span></div>
        ${rows}
      </div>
    `;
  }

  function renderGroupsHtml() {
    const nav = getNav();
    const groupMap = getNavGroupMap();
    const q = state.filterQuery.trim().toLowerCase();
    const activeGroup = getGroupForRoute(state.currentRoute);

    return getGroupOrder().map((g) => {
      const allGroupItems = nav.filter((n) => (groupMap[n[0]] || 'Overview') === g && isNavVisible(n));
      if (!allGroupItems.length) return '';

      const matching = q
        ? allGroupItems.filter((n) => {
            const kw = ROUTE_KEYWORDS[n[0]] || '';
            return `${n[2]} ${n[0]} ${g} ${kw}`.toLowerCase().includes(q);
          })
        : allGroupItems;

      if (q && !matching.length) return '';

      const isOpen = q ? true : (state.groupOpen[g] !== false || g === activeGroup);
      const meta = GROUP_META[g] || { icon: '•' };
      const hasChildBadge = allGroupItems.some((n) => state.badges[n[0]] && Number(state.badges[n[0]].count) > 0);

      const itemsHtml = matching.map((n) => {
        const r = n[0];
        const active = state.currentRoute === r ? 'active' : '';
        const pinned = state.pins.includes(r);
        return `
          <div class="nav-item-row">
            <a href="${esc(n[4] || '#/' + r)}" class="nav-link ${active}" data-route="${esc(r)}" title="${esc(n[2])}">
              <span class="ico">${n[1]}</span>
              <span class="nav-text">${esc(n[2])}</span>
              ${badgeHtmlFor(r)}
            </a>
            <button type="button" class="nav-pin-btn ${pinned ? 'is-pinned' : ''}" data-pin-route="${esc(r)}" title="${pinned ? 'Unpin shortcut' : 'Pin to top'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(n[2])}">${pinned ? '★' : '☆'}</button>
          </div>
        `;
      }).join('');

      return `
        <div class="nav-section ${isOpen ? '' : 'is-collapsed'}" data-group="${esc(g)}">
          <button type="button" class="nav-group-btn" data-toggle-group="${esc(g)}" aria-expanded="${isOpen ? 'true' : 'false'}" title="${esc(g)}">
            <span class="nav-group-ico">${meta.icon}</span>
            <span class="nav-group-label">${esc(g)}</span>
            <span class="nav-group-dot ${hasChildBadge ? 'has-badge' : ''}" title="Active items inside"></span>
            <span class="nav-chev">▾</span>
          </button>
          <div class="nav-group-items">${itemsHtml}</div>
        </div>
      `;
    }).join('');
  }

  function bindNavItemHandlers() {
    const groupsWrap = qs('#nav_groups_wrap');
    const pinnedWrap = qs('#nav_pinned_wrap');
    const navEl = qs('#nav');
    if (!navEl) return;

    qsa('[data-toggle-group]', navEl).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.filterQuery.trim()) return;
        const g = btn.dataset.toggleGroup;
        const next = state.groupOpen[g] === false;
        state.groupOpen[g] = next;
        saveGroupPrefs();
        const section = btn.closest('.nav-section');
        if (section) {
          section.classList.toggle('is-collapsed', !next);
          btn.setAttribute('aria-expanded', next ? 'true' : 'false');
        }
      });
    });

    qsa('[data-pin-route]', navEl).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePin(btn.dataset.pinRoute);
      });
    });

    [pinnedWrap, groupsWrap].forEach((wrap) => {
      if (!wrap) return;
      qsa('.nav-link', wrap).forEach((a) => {
        a.addEventListener('click', () => closeDrawer());
      });
    });
  }

  function refreshSidebarLists() {
    const pinnedWrap = qs('#nav_pinned_wrap');
    const groupsWrap = qs('#nav_groups_wrap');
    const emptyEl = qs('#nav_filter_empty');
    if (pinnedWrap) {
      pinnedWrap.innerHTML = state.filterQuery.trim() ? '' : renderPinnedSectionHtml();
    }
    if (groupsWrap) {
      groupsWrap.innerHTML = renderGroupsHtml();
    }
    if (emptyEl) {
      const hasAny = groupsWrap && groupsWrap.querySelector('.nav-link');
      emptyEl.style.display = (state.filterQuery.trim() && !hasAny) ? 'block' : 'none';
    }
    bindNavItemHandlers();
    syncCompactTooltips();
  }

  function togglePin(route) {
    if (!route) return;
    const idx = state.pins.indexOf(route);
    if (idx !== -1) {
      state.pins.splice(idx, 1);
    } else {
      if (state.pins.length >= 5) {
        showToast('You can pin up to 5 shortcuts (unpin one first)', 'err');
        return;
      }
      state.pins.push(route);
    }
    savePinPrefs();
    refreshSidebarLists();
  }

  function syncCompactTooltips() {
    const navEl = qs('#nav');
    const collapseBtn = qs('#nav_collapse_btn');
    if (!navEl) return;
    navEl.classList.toggle('is-compact', !!state.compact);
    if (collapseBtn) {
      collapseBtn.textContent = state.compact ? '»' : '«';
      collapseBtn.title = state.compact ? 'Expand sidebar' : 'Collapse sidebar to icon rail';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
    }
  }

  function applyBadgesToDom() {
    const navEl = qs('#nav');
    if (!navEl) return;

    qsa('[data-badge-route]', navEl).forEach((el) => {
      const r = el.dataset.badgeRoute;
      const b = state.badges && state.badges[r];
      const count = b && Number(b.count) > 0 ? Number(b.count) : 0;
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.remove('tone-red', 'tone-amber');
      el.classList.add(b && b.tone === 'red' ? 'tone-red' : 'tone-amber');
      el.style.display = count > 0 ? 'inline-flex' : 'none';
      const link = el.closest('.nav-link');
      if (link) link.classList.toggle('has-live-badge', count > 0);
    });

    qsa('.nav-section', navEl).forEach((sec) => {
      const hasAny = Array.from(sec.querySelectorAll('[data-badge-route]'))
        .some((el) => el.style.display !== 'none');
      const dot = sec.querySelector('.nav-group-dot');
      if (dot) dot.classList.toggle('has-badge', hasAny);
    });
  }

  async function refreshNavBadges() {
    const me = getMe();
    const b = bridge();
    if (!me || (b.isScreenLocked && b.isScreenLocked())) return;
    try {
      const res = await callApi('/notifications/nav-badges');
      if (res && res.badges && typeof res.badges === 'object') {
        state.badges = res.badges;
        applyBadgesToDom();
      }
    } catch {
      // Quiet on background poll failures
    }
  }

  function scheduleBadgeRefresh() {
    clearTimeout(state.badgeRefreshTimer);
    state.badgeRefreshTimer = setTimeout(() => {
      refreshNavBadges();
    }, 2200);
  }

  function updateBreadcrumb(route, rawHash, detailParts) {
    const bc = qs('#nav_breadcrumb');
    if (!bc) return;

    const groupName = getGroupForRoute(route);
    const pageLabel = getLabelForRoute(route);
    const qStr = String(rawHash || '').split('?')[1] || '';
    const sp = new URLSearchParams(qStr);
    const tabKey = sp.get('tab');
    const tabLabel = tabKey ? (TAB_LABELS[tabKey] || tabKey.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())) : '';
    const details = (detailParts || []).filter(Boolean);

    let trail = `
      <div class="bc-trail">
        <span class="bc-group">${esc(groupName)}</span>
        <span class="bc-sep">›</span>
        <a href="#/${esc(route)}" class="bc-page">${esc(pageLabel)}</a>
        ${tabLabel ? `<span class="bc-sep">›</span><span class="bc-tab">${esc(tabLabel)}</span>` : ''}
        ${details.length ? `<span class="bc-sep">›</span><span class="bc-detail">#${esc(details.join('/'))}</span>` : ''}
      </div>
    `;
    const backBtn = details.length
      ? `<button type="button" class="btn sm bc-back" data-back>← Back</button>`
      : '';
    bc.innerHTML = trail + backBtn;
  }

  function syncActiveNav(route, rawHash, detailParts) {
    state.currentRoute = route || 'dashboard';
    const navEl = qs('#nav');
    if (!navEl) return;

    const activeGroup = getGroupForRoute(state.currentRoute);
    const section = qsa('.nav-section', navEl).find((s) => s.dataset && s.dataset.group === activeGroup);
    if (section && section.classList.contains('is-collapsed')) {
      section.classList.remove('is-collapsed');
      const gBtn = section.querySelector('[data-toggle-group]');
      if (gBtn) gBtn.setAttribute('aria-expanded', 'true');
      state.groupOpen[activeGroup] = true;
    }

    let firstMatch = null;
    qsa('.nav-link', navEl).forEach((a) => {
      const isActive = a.dataset.route === state.currentRoute;
      a.classList.toggle('active', isActive);
      if (isActive && !firstMatch) firstMatch = a;
    });

    // Only nudge scroll container when the active link is outside visible bounds (preserves scroll position)
    const scrollBox = qs('#nav_scroll');
    if (firstMatch && scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight) {
      const boxTop = scrollBox.scrollTop;
      const boxBot = boxTop + scrollBox.clientHeight;
      const elTop = firstMatch.offsetTop;
      const elBot = elTop + firstMatch.offsetHeight;
      if (elTop < boxTop + 8) {
        scrollBox.scrollTop = Math.max(0, elTop - 16);
      } else if (elBot > boxBot - 8) {
        scrollBox.scrollTop = elBot - scrollBox.clientHeight + 16;
      }
    }

    updateBreadcrumb(state.currentRoute, rawHash, detailParts);
    closeDrawer();

    if (typeof window.refreshMobileNav === 'function') {
      window.refreshMobileNav();
    }
  }

  function openDrawer() {
    const navEl = qs('#nav');
    const bd = qs('#nav_backdrop');
    if (navEl) navEl.classList.add('open');
    if (bd) bd.classList.add('open');
    if (typeof window.refreshMobileNav === 'function') window.refreshMobileNav();
  }

  function closeDrawer() {
    const navEl = qs('#nav');
    const bd = qs('#nav_backdrop');
    if (navEl) navEl.classList.remove('open');
    if (bd) bd.classList.remove('open');
    if (typeof window.refreshMobileNav === 'function') window.refreshMobileNav();
  }

  function toggleDrawer() {
    const navEl = qs('#nav');
    if (!navEl) return;
    if (navEl.classList.contains('open')) closeDrawer();
    else openDrawer();
  }

  function syncStoreLabel(label) {
    const topName = qs('#topbar_site_name');
    const mobName = qs('#nav_mobile_site_name');
    if (topName) topName.textContent = label;
    if (mobName) mobName.textContent = label;
  }

  // ---- Ctrl+K Command Palette ----------------------------------------------
  function getPaletteEntries() {
    const entries = [];
    const nav = getNav();
    const groupMap = getNavGroupMap();

    for (const n of nav) {
      if (!isNavVisible(n)) continue;
      const r = n[0];
      const g = groupMap[r] || 'Overview';
      const kw = ROUTE_KEYWORDS[r] || '';
      entries.push({
        kind: 'page',
        category: 'Pages',
        icon: n[1],
        label: n[2],
        sub: g,
        hash: n[4] || `#/${r}`,
        searchText: `${n[2]} ${r} ${g} ${kw}`.toLowerCase(),
      });
    }

    for (const st of QUICK_SUBTABS) {
      const parentEntry = nav.find((x) => x[0] === st.parent);
      if (parentEntry && !isNavVisible(parentEntry)) continue;
      entries.push({
        kind: 'tab',
        category: 'Quick Tabs',
        icon: st.icon,
        label: st.label,
        sub: st.sub,
        hash: st.hash,
        searchText: `${st.label} ${st.sub} ${st.keywords}`.toLowerCase(),
      });
    }

    return entries;
  }

  function filterLocalPaletteEntries(q) {
    const allEntries = getPaletteEntries();
    const query = String(q || '').trim().toLowerCase();
    if (!query) return allEntries.slice(0, 14);

    const terms = query.split(/\s+/).filter(Boolean);
    return allEntries.filter((e) => terms.every((t) => e.searchText.includes(t))).slice(0, 12);
  }

  function renderPaletteList(items) {
    state.paletteResults = items;
    if (state.paletteIndex >= items.length) state.paletteIndex = 0;

    const listEl = qs('#cmd_palette_list');
    if (!listEl) return;

    if (!items.length) {
      listEl.innerHTML = `<div class="cmd-empty">No matching pages or records found.</div>`;
      return;
    }

    let lastCat = '';
    listEl.innerHTML = items.map((item, idx) => {
      const catHead = item.category !== lastCat
        ? `<div class="cmd-cat">${esc(item.category)}</div>`
        : '';
      lastCat = item.category;
      const sel = idx === state.paletteIndex ? 'is-selected' : '';
      return `${catHead}
        <button type="button" class="cmd-item ${sel}" data-cmd-idx="${idx}">
          <span class="cmd-ico">${item.icon || '→'}</span>
          <span class="cmd-main">
            <span class="cmd-title">${esc(item.label)}</span>
            <span class="cmd-sub">${esc(item.sub || '')}</span>
          </span>
          <span class="cmd-jump">↵</span>
        </button>`;
    }).join('');

    qsa('.cmd-item', listEl).forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.cmdIdx);
        executePaletteItem(state.paletteResults[idx]);
      });
      btn.addEventListener('mouseenter', () => {
        state.paletteIndex = Number(btn.dataset.cmdIdx);
        qsa('.cmd-item', listEl).forEach((el, i) => el.classList.toggle('is-selected', i === state.paletteIndex));
      });
    });
  }

  function executePaletteItem(item) {
    if (!item) return;
    closeCommandPalette();
    const sInp = qs('#global_search_input');
    if (sInp) sInp.value = '';
    if (item.hash) {
      if (location.hash === item.hash) {
        const b = bridge();
        if (typeof b.render === 'function') b.render();
      } else {
        location.hash = item.hash;
      }
    }
  }

  async function runPaletteQuery(q) {
    const seq = ++state.paletteSeq;
    const localItems = filterLocalPaletteEntries(q);
    state.paletteIndex = 0;
    renderPaletteList(localItems);

    const trimmed = String(q || '').trim();
    if (trimmed.length < 2) return;

    clearTimeout(state.paletteDebounce);
    state.paletteDebounce = setTimeout(async () => {
      const tasks = [];
      const me = getMe();
      const admin = isAdminUser(me);

      if (admin || canViewSec('assets')) {
        tasks.push(
          callApi(`/assets/search?limit=5&q=${encodeURIComponent(trimmed)}`)
            .then((rows) => (Array.isArray(rows) ? rows : []).map((a) => ({
              kind: 'asset',
              category: 'Assets',
              icon: '🚜',
              label: [a.code, a.registration].filter(Boolean).join(' · ') || `Asset #${a.id}`,
              sub: a.asset_class || 'Fleet asset',
              hash: `#/assets/${a.id}`,
            })))
            .catch(() => [])
        );
      }
      if (admin || canViewSec('jobs')) {
        tasks.push(
          callApi(`/jobs?limit=5&q=${encodeURIComponent(trimmed)}`)
            .then((rows) => (Array.isArray(rows) ? rows : []).map((j) => ({
              kind: 'job',
              category: 'Job Cards',
              icon: '🔧',
              label: `${j.job_no || 'Job #' + j.id}${j.asset_code ? ' · ' + j.asset_code : ''}`,
              sub: [j.status, j.description].filter(Boolean).join(' — ').slice(0, 70),
              hash: `#/jobs/${j.id}`,
            })))
            .catch(() => [])
        );
      }
      if (admin || canViewSec('stores')) {
        tasks.push(
          callApi(`/stores/items/search?limit=5&q=${encodeURIComponent(trimmed)}`)
            .then((rows) => (Array.isArray(rows) ? rows : []).map((it) => ({
              kind: 'item',
              category: 'Store Items',
              icon: '📦',
              label: `${it.item_no ? it.item_no + ' · ' : ''}${it.name || 'Item'}`,
              sub: `Balance: ${it.balance != null ? it.balance : '0'} ${it.unit || ''}`.trim(),
              hash: `#/stores?tab=onhand&q=${encodeURIComponent(it.name || it.item_no || trimmed)}`,
            })))
            .catch(() => [])
        );
      }

      if (!tasks.length) return;
      const chunks = await Promise.all(tasks);
      if (seq !== state.paletteSeq || !state.paletteOpen) return;

      const remoteItems = chunks.flat();
      renderPaletteList([...localItems, ...remoteItems]);
    }, 220);
  }

  function closeCommandPalette() {
    state.paletteOpen = false;
    clearTimeout(state.paletteDebounce);
    const el = qs('#cmd_palette_overlay');
    if (el) el.remove();
  }

  function openCommandPalette(initialQuery = '') {
    const me = getMe();
    const b = bridge();
    if (!me || (b.isScreenLocked && b.isScreenLocked())) return;

    closeCommandPalette();
    state.paletteOpen = true;
    state.paletteIndex = 0;

    const overlay = document.createElement('div');
    overlay.id = 'cmd_palette_overlay';
    overlay.className = 'cmd-palette-overlay';
    overlay.innerHTML = `
      <div class="cmd-palette" role="dialog" aria-modal="true" aria-label="Quick navigation and search">
        <div class="cmd-input-row">
          <span class="cmd-search-ico">🔍</span>
          <input type="search" id="cmd_palette_input" class="cmd-input" placeholder="Jump to page, sub-tab, asset code, job card, or store part…" autocomplete="off" value="${esc(initialQuery)}">
          <button type="button" class="cmd-esc-btn" id="cmd_palette_close">ESC</button>
        </div>
        <div class="cmd-list" id="cmd_palette_list"></div>
        <div class="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCommandPalette();
    });
    const closeBtn = qs('#cmd_palette_close', overlay);
    if (closeBtn) closeBtn.addEventListener('click', closeCommandPalette);

    const inp = qs('#cmd_palette_input', overlay);
    if (inp) {
      inp.focus();
      inp.select();
      inp.addEventListener('input', () => runPaletteQuery(inp.value));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeCommandPalette();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (state.paletteResults.length) {
            state.paletteIndex = (state.paletteIndex + 1) % state.paletteResults.length;
            const list = qs('#cmd_palette_list');
            qsa('.cmd-item', list).forEach((el, i) => el.classList.toggle('is-selected', i === state.paletteIndex));
            const selEl = list && list.querySelector('.cmd-item.is-selected');
            if (selEl && typeof selEl.scrollIntoView === 'function') selEl.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (state.paletteResults.length) {
            state.paletteIndex = (state.paletteIndex - 1 + state.paletteResults.length) % state.paletteResults.length;
            const list = qs('#cmd_palette_list');
            qsa('.cmd-item', list).forEach((el, i) => el.classList.toggle('is-selected', i === state.paletteIndex));
            const selEl = list && list.querySelector('.cmd-item.is-selected');
            if (selEl && typeof selEl.scrollIntoView === 'function') selEl.scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (state.paletteResults[state.paletteIndex]) {
            executePaletteItem(state.paletteResults[state.paletteIndex]);
          } else if (inp.value.trim()) {
            closeCommandPalette();
            location.hash = `#/jobs?q=${encodeURIComponent(inp.value.trim())}`;
          }
        }
      });
    }

    runPaletteQuery(initialQuery);
  }

  function bindGlobalListeners() {
    if (state.windowListenersBound) return;
    state.windowListenersBound = true;

    window.addEventListener('keydown', (e) => {
      const me = getMe();
      const b = bridge();
      if (!me || (b.isScreenLocked && b.isScreenLocked())) return;

      if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k') {
        e.preventDefault();
        if (state.paletteOpen) closeCommandPalette();
        else openCommandPalette('');
        return;
      }
      if (e.key === 'Escape') {
        if (state.paletteOpen) closeCommandPalette();
        else closeDrawer();
      }
    });

    if (window.LiveERP && typeof window.LiveERP.on === 'function') {
      ['data_changed', 'request_updated', 'stock_updated', 'job_updated', 'dashboard_refresh', 'notification_push'].forEach((ev) => {
        window.LiveERP.on(ev, scheduleBadgeRefresh);
      });
    }
  }

  function mountShell(me) {
    const b = bridge();
    loadUserPrefs(me);
    const roles = me.roles || [];
    const initials = (me.fullName || me.username || 'AD').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    const roleDisplay = roles[0] ? roles[0].replace(/_/g, ' ') : 'User';
    const activeLocationLabel = activeStoreLabelFor(me);
    const homeHash = getDefaultHome();
    const admin = isAdminUser(me);
    const isMain = admin || !!me.isMainStore;
    const siteIcon = isMain ? '<span class="live-dot">●</span>' : '<span style="font-size:11px;margin-right:2px">🔒</span>';
    const siteTip = isMain ? 'Active Store / Site Location — Click to view or switch' : 'Assigned Site Store — Operating locally (MTN for transfers)';
    const nowText = typeof b.slNowTime === 'function' ? b.slNowTime() : '';
    const isPackaged = !!(window.WORKSHOPONE_IS_PACKAGED_APP && typeof window.configureServerIp === 'function');

    const appEl = qs('#app');
    appEl.innerHTML = `
      <header class="topbar">
        <button type="button" class="hamburger" id="ham" aria-label="Open navigation menu" title="Menu">☰</button>
        <a href="${esc(homeHash)}" class="brand" title="Go to Home">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--primary,#0066ff);margin-right:2px"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          Workshop<span>One</span>
        </a>
        <div class="topbar-site-badge" id="topbar_site_badge" title="${esc(siteTip)}" style="cursor:pointer">
          ${siteIcon}
          <span id="topbar_site_name">${esc(activeLocationLabel)}</span> ▾
        </div>
        <div class="topbar-site-badge" id="topbar_sl_clock" title="Sri Lanka Standard Time (Asia/Colombo · UTC+05:30)" style="margin-left:4px;display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.16);padding:3px 10px;border-radius:16px;white-space:nowrap;flex-shrink:0">
          <span style="font-size:12px">🇱🇰</span>
          <span id="live_sl_clock" style="font-weight:700;font-size:11.5px;color:#e2e8f0;letter-spacing:0.2px">${esc(nowText)} SLST</span>
        </div>
        <div class="topbar-search-wrap" id="topbar_search_trigger">
          <span class="topbar-search-icon">🔍</span>
          <input type="search" class="topbar-search-input" id="global_search_input" placeholder="Jump to page, asset, job, or part… (Ctrl + K)" autocomplete="off">
          <span class="topbar-search-kbd">⌘K</span>
        </div>
        <div class="spacer"></div>
        <button type="button" class="topbar-icon-btn topbar-mobile-search" id="topbar_mobile_search" title="Quick Search (Ctrl+K)" aria-label="Search">🔍</button>
        <button type="button" class="topbar-icon-btn" id="topbar-bell" title="Live Notifications, Certifications & Approvals" style="position:relative">
          🔔
          <span class="topbar-badge-count" id="topbar_notif_badge" style="display:none">0</span>
        </button>
        <div id="notif_popover" style="display:none;position:fixed;top:54px;right:18px;width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 76px);background:var(--surface,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 16px 40px rgba(15,23,42,0.22);z-index:950;color:var(--text);flex-direction:column;overflow:hidden"></div>
        <div class="topbar-user-pill" id="user_profile_trigger" title="Account settings">
          <div class="topbar-user-avatar">${esc(initials)}</div>
          <div class="topbar-user-meta">
            <span class="topbar-user-name">${esc(me.fullName || me.username)}</span>
            <span class="topbar-user-role">${esc(roleDisplay)} ▾</span>
          </div>
        </div>
        <div id="user_popover" style="display:none;position:absolute;top:54px;right:18px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-lg);padding:8px;min-width:215px;z-index:200;color:var(--text)">
          <div style="padding:8px 12px;border-bottom:1px solid var(--border);margin-bottom:6px">
            <div style="font-weight:700;font-size:13px">${esc(me.fullName || me.username)}</div>
            <div class="muted" style="font-size:11px">${esc(roles.join(', '))}</div>
          </div>
          <a class="btn sm" id="pop_sig" style="display:flex;width:100%;margin-bottom:3px;border:none;justify-content:flex-start">✍ My Signature</a>
          <a class="btn sm" id="pop_pw" style="display:flex;width:100%;margin-bottom:3px;border:none;justify-content:flex-start">🔑 Change Password</a>
          <a class="btn sm" id="pop_mfa" style="display:flex;width:100%;margin-bottom:3px;border:none;justify-content:flex-start">🔐 Security (2FA)${me.mfaEnabled ? ' ✓' : ''}</a>
          ${isPackaged ? '<a class="btn sm" id="pop_server" style="display:flex;width:100%;margin-bottom:3px;border:none;justify-content:flex-start">⚙️ Server Address</a>' : ''}
          <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px">
            <a class="btn sm danger" id="pop_logout" style="display:flex;width:100%;border:none;justify-content:flex-start;color:#ef4444">🚪 Sign Out</a>
          </div>
        </div>
      </header>
      <div class="layout">
        <div class="nav-backdrop" id="nav_backdrop"></div>
        <nav class="nav ${state.compact ? 'is-compact' : ''}" id="nav" aria-label="Primary Navigation">
          <div class="nav-header">
            <div class="nav-filter-wrap">
              <span class="nav-filter-ico">🔍</span>
              <input type="search" id="nav_quick_filter" class="nav-quick-filter" placeholder="Filter menu…" autocomplete="off" aria-label="Filter menu">
              <button type="button" id="nav_filter_clear" class="nav-filter-clear" title="Clear filter" style="display:none">×</button>
            </div>
            <button type="button" id="nav_collapse_btn" class="nav-collapse-btn" title="${state.compact ? 'Expand sidebar' : 'Collapse sidebar to icon rail'}">${state.compact ? '»' : '«'}</button>
          </div>
          <div class="nav-mobile-ctx">
            <button type="button" class="nav-mobile-ctx-btn" id="nav_mobile_store_btn">
              <span>📍</span>
              <span id="nav_mobile_site_name">${esc(activeLocationLabel)}</span>
              <span style="margin-left:auto;opacity:.7">Switch ▾</span>
            </button>
          </div>
          <div class="nav-scroll" id="nav_scroll">
            <div id="nav_pinned_wrap"></div>
            <div id="nav_groups_wrap"></div>
            <div id="nav_filter_empty" class="nav-filter-empty" style="display:none">No matching menu items</div>
          </div>
          <div class="nav-footer">
            <button type="button" class="nav-footer-btn" id="nav_cmd_btn">
              <span>⌘K</span>
              <span class="nav-footer-hint">Quick Jump & Search</span>
            </button>
            ${isPackaged ? '<button type="button" class="nav-footer-btn" id="nav_server_btn"><span>⚙️</span><span class="nav-footer-hint">Server Config</span></button>' : ''}
          </div>
        </nav>
        <div class="main-col">
          <div id="standin-banner"></div>
          <div class="nav-breadcrumb" id="nav_breadcrumb"></div>
          <main class="content" id="content"><div class="muted">Loading…</div></main>
        </div>
      </div>
    `;

    refreshSidebarLists();
    bindShellControls();
    bindGlobalListeners();

    if (typeof b.renderStandInBanner === 'function') b.renderStandInBanner();
    if (!state.clockInterval && typeof b.slNowTime === 'function') {
      state.clockInterval = setInterval(() => {
        const el = document.getElementById('live_sl_clock');
        if (el) el.textContent = `${b.slNowTime()} SLST`;
      }, 10000);
    }

    if (typeof b.setupLiveNotifications === 'function') b.setupLiveNotifications();
    if (typeof b.refreshNotifications === 'function') b.refreshNotifications({ showToastOnNew: false });

    refreshNavBadges();
    if (!state.badgeInterval) {
      state.badgeInterval = setInterval(() => {
        if (getMe() && !(b.isScreenLocked && b.isScreenLocked())) refreshNavBadges();
      }, 60000);
    }

    state.mountedKey = `${me.id}:${roles.join(',')}`;
  }

  function bindShellControls() {
    const b = bridge();

    const siteBadge = qs('#topbar_site_badge');
    if (siteBadge && typeof b.openStoreSwitcher === 'function') {
      siteBadge.addEventListener('click', () => b.openStoreSwitcher());
    }
    const mobileStoreBtn = qs('#nav_mobile_store_btn');
    if (mobileStoreBtn && typeof b.openStoreSwitcher === 'function') {
      mobileStoreBtn.addEventListener('click', () => {
        closeDrawer();
        b.openStoreSwitcher();
      });
    }

    const pop = qs('#user_popover');
    const trig = qs('#user_profile_trigger');
    const notifPop = qs('#notif_popover');
    const btnBell = qs('#topbar-bell');

    if (trig && pop) {
      trig.addEventListener('click', (e) => {
        e.stopPropagation();
        if (notifPop) {
          notifPop.style.display = 'none';
          if (b.notifState) b.notifState.open = false;
        }
        pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
      });
    }

    if (btnBell && notifPop) {
      btnBell.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop) pop.style.display = 'none';
        const isOpen = notifPop.style.display === 'flex';
        if (isOpen) {
          notifPop.style.display = 'none';
          if (b.notifState) b.notifState.open = false;
        } else {
          notifPop.style.display = 'flex';
          if (b.notifState) b.notifState.open = true;
          if (typeof b.renderNotifPopover === 'function') b.renderNotifPopover();
          if (typeof b.refreshNotifications === 'function') b.refreshNotifications({ showToastOnNew: false });
        }
      });
    }

    const btnLogout = qs('#pop_logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        if (typeof b.setScreenLocked === 'function') b.setScreenLocked(false);
        if (typeof b.clearSessionStorage === 'function') b.clearSessionStorage();
        try { await api('/auth/logout', { method: 'POST' }); } catch {}
        if (typeof b.removeIdleLockOverlay === 'function') b.removeIdleLockOverlay();
        if (typeof b.live === 'function') b.live('disconnect');
        if (typeof b.setMe === 'function') b.setMe(null);
        resetShell();
        location.hash = '';
        if (typeof b.boot === 'function') b.boot();
      });
    }

    const btnPw = qs('#pop_pw');
    if (btnPw) btnPw.addEventListener('click', () => { if (pop) pop.style.display = 'none'; b.openPasswordModal && b.openPasswordModal(); });
    const btnSig = qs('#pop_sig');
    if (btnSig) btnSig.addEventListener('click', () => { if (pop) pop.style.display = 'none'; b.openSignatureModal && b.openSignatureModal(); });
    const btnMfa = qs('#pop_mfa');
    if (btnMfa) btnMfa.addEventListener('click', () => { if (pop) pop.style.display = 'none'; b.openSecurityModal && b.openSecurityModal(); });
    const btnSrv = qs('#pop_server');
    if (btnSrv) btnSrv.addEventListener('click', () => { if (pop) pop.style.display = 'none'; if (typeof window.configureServerIp === 'function') window.configureServerIp(); });

    const sInp = qs('#global_search_input');
    if (sInp) {
      sInp.addEventListener('focus', () => {
        const val = sInp.value || '';
        sInp.blur();
        openCommandPalette(val);
      });
      sInp.addEventListener('click', () => {
        if (state.paletteOpen) return;
        const val = sInp.value || '';
        openCommandPalette(val);
      });
      sInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openCommandPalette(sInp.value || '');
        }
      });
    }

    const mobSearch = qs('#topbar_mobile_search');
    if (mobSearch) mobSearch.addEventListener('click', () => openCommandPalette(''));

    const navCmdBtn = qs('#nav_cmd_btn');
    if (navCmdBtn) {
      navCmdBtn.addEventListener('click', () => {
        closeDrawer();
        openCommandPalette('');
      });
    }

    const navSrvBtn = qs('#nav_server_btn');
    if (navSrvBtn && typeof window.configureServerIp === 'function') {
      navSrvBtn.addEventListener('click', () => window.configureServerIp());
    }

    const collapseBtn = qs('#nav_collapse_btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        state.compact = !state.compact;
        safeLsSet('wo_nav_collapsed', state.compact ? '1' : '0');
        syncCompactTooltips();
      });
    }

    const filterInp = qs('#nav_quick_filter');
    const filterClr = qs('#nav_filter_clear');
    if (filterInp) {
      filterInp.addEventListener('input', () => {
        state.filterQuery = filterInp.value || '';
        if (filterClr) filterClr.style.display = state.filterQuery ? 'inline-flex' : 'none';
        refreshSidebarLists();
      });
    }
    if (filterClr && filterInp) {
      filterClr.addEventListener('click', () => {
        filterInp.value = '';
        state.filterQuery = '';
        filterClr.style.display = 'none';
        refreshSidebarLists();
        filterInp.focus();
      });
    }

    const hamBtn = qs('#ham');
    if (hamBtn) hamBtn.addEventListener('click', toggleDrawer);
    const bdEl = qs('#nav_backdrop');
    if (bdEl) bdEl.addEventListener('click', closeDrawer);
  }

  function syncShell(route, rawHash, detailParts) {
    const me = getMe();
    if (!me) return;
    const key = `${me.id}:${(me.roles || []).join(',')}`;
    const hasNav = !!document.getElementById('nav');
    if (!hasNav || state.mountedKey !== key) {
      mountShell(me);
    } else {
      syncStoreLabel(activeStoreLabelFor(me));
    }
    syncActiveNav(route || 'dashboard', rawHash || location.hash, detailParts || []);
  }

  function resetShell() {
    state.mountedKey = null;
    state.filterQuery = '';
    state.badges = {};
    closeCommandPalette();
    closeDrawer();
    clearInterval(state.badgeInterval);
    state.badgeInterval = null;
    clearInterval(state.clockInterval);
    state.clockInterval = null;
    clearTimeout(state.badgeRefreshTimer);
    if (typeof window.refreshMobileNav === 'function') window.refreshMobileNav();
  }

  if (typeof window !== 'undefined') {
    window.WONav = {
      GROUP_META,
      syncShell,
      resetShell,
      syncStoreLabel,
      togglePin,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      openCommandPalette,
      closeCommandPalette,
      getPaletteEntries,
      refreshNavBadges,
      scheduleBadgeRefresh,
      _state: state,
    };
  }
})();
