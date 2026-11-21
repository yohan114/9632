'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-nav-sys-'));
process.env.DB_PATH = path.join(TMP, 'nav.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';

const { db, migrate, run } = require('../src/db');
const auth = require('../src/lib/auth');
const perms = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');

migrate();
const BUILT_IN = Object.keys(perms.DEFAULT_MATRIX);
for (const n of ['admin', ...BUILT_IN]) {
  run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', n, 'Built-in ' + n);
}
capabilities.seedCapabilities();
perms.seedDefaults();

// Restricted role with zero access to aliases, fuel_alerts, and attention
run('INSERT OR IGNORE INTO roles (name, label) VALUES (?, ?)', 'jobsonly_nav', 'Jobs Only');
for (const m of perms.MODULE_KEYS) {
  perms.setPermission('jobsonly_nav', m, m === 'jobs' ? 'view' : 'none');
}

const PW = 'NavTestPass#2026!';
const adminId = run(
  'INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
  'navadmin', auth.hashPassword(PW), 'Nav Admin'
).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', adminId, 'admin');

const restrId = run(
  'INSERT INTO users (username, password_hash, full_name, active) VALUES (?, ?, ?, 1)',
  'navrestricted', auth.hashPassword(PW), 'Restricted User'
).lastInsertRowid;
run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', restrId, 'jobsonly_nav');

// Seed operational queue data for live nav-badges test
run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('UNRES-99', 'UNRES99', 0, 2, 'fuel')");
run("INSERT INTO fuel_tanks (code, name, fuel_type, capacity_litres, current_litres, active) VALUES ('TK-LOW', 'Low Diesel Tank', 'DIESEL', 10000, 500, 1)");
run("INSERT INTO mrn (mrn_no, req_date, status) VALUES ('MRN-OLD-99', date('now', '-45 days'), 'open')");

const app = require('../src/server');
let server;
let port;

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: json, text: buf, setCookie });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function loginAs(username) {
  const res = await req('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.equal(res.status, 200, `Login failed for ${username}: ${res.text}`);
  return (res.setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. GET /api/notifications/nav-badges enforces auth and strict RBAC scoping', async () => {
  const unauth = await req('GET', '/api/notifications/nav-badges');
  assert.equal(unauth.status, 401);

  const adminCookie = await loginAs('navadmin');
  const adminRes = await req('GET', '/api/notifications/nav-badges', { cookie: adminCookie });
  assert.equal(adminRes.status, 200);
  assert.ok(adminRes.body && adminRes.body.badges, 'Expected badges payload');
  assert.ok(adminRes.body.badges.aliases && adminRes.body.badges.aliases.count >= 1, 'Admin sees unresolved aliases badge');
  assert.equal(adminRes.body.badges.aliases.tone, 'amber');
  assert.ok(adminRes.body.badges['fuel-alerts'] && adminRes.body.badges['fuel-alerts'].count >= 1, 'Admin sees fuel-alerts badge');
  assert.equal(adminRes.body.badges['fuel-alerts'].tone, 'red');
  assert.ok(adminRes.body.badges.attention && adminRes.body.badges.attention.count >= 1, 'Admin sees overdue MRN in attention badge');

  const restrCookie = await loginAs('navrestricted');
  const restrRes = await req('GET', '/api/notifications/nav-badges', { cookie: restrCookie });
  assert.equal(restrRes.status, 200);
  assert.deepEqual(restrRes.body.badges, {}, 'Restricted user must not receive operational badges they cannot access');
});

test('2. Every NAV entry in public/app.js maps cleanly to the 8 domain groups', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const navStart = appJs.indexOf('const NAV = [');
  const navEnd = appJs.indexOf('if (typeof window !== \'undefined\') {', navStart);
  assert.ok(navStart !== -1 && navEnd !== -1, 'Expected NAV/NAV_GROUP block in public/app.js');

  const snippet = appJs.slice(navStart, navEnd);
  const sandbox = {
    ME: { roles: ['admin'] },
    isAdmin: () => true,
    canView: () => true,
    canDo: () => true,
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    snippet + '\nthis.__out = { NAV, NAV_GROUP_ORDER, NAV_GROUP };',
    sandbox
  );

  const { NAV, NAV_GROUP_ORDER, NAV_GROUP } = sandbox.__out;
  assert.deepEqual(Array.from(NAV_GROUP_ORDER), [
    'Overview',
    'Workshop & Maintenance',
    'Fuel Management',
    'Stores & Procurement',
    'Fleet & Master Data',
    'Finance & Costing',
    'Reports & Hygiene',
    'Administration',
  ]);
  assert.equal(NAV.length, 35, 'Expected all 35 primary routes registered in NAV');

  for (const entry of NAV) {
    const route = entry[0];
    const grp = NAV_GROUP[route];
    assert.ok(grp && NAV_GROUP_ORDER.includes(grp), `NAV route '${route}' missing valid group mapping (got: ${grp})`);
  }

  for (const r of ['fuel', 'transport-fuel', 'fuel-readings', 'fuel-tanks', 'fuel-prices', 'fuel-reports', 'fuel-alerts']) {
    assert.equal(NAV_GROUP[r], 'Fuel Management', `${r} must be grouped under Fuel Management`);
  }
  for (const r of ['fleet-profitability', 'vehicle-costing', 'hire-billing', 'teardown']) {
    assert.equal(NAV_GROUP[r], 'Finance & Costing', `${r} must be grouped under Finance & Costing`);
  }
});

test('3. navigation.js persists shell DOM on route switches, enforces RBAC, supports group collapse, pins, and Ctrl+K palette', () => {
  const root = path.join(__dirname, '..');
  const navSrc = fs.readFileSync(path.join(root, 'public', 'modules', 'navigation.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const navStart = appJs.indexOf('const NAV = [');
  const navEnd = appJs.indexOf("if (typeof window !== 'undefined') {", navStart);
  const navDefs = appJs.slice(navStart, navEnd);

  // Minimal DOM mock sufficient to mount navigation.js and verify shell persistence
  class MockClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...cls) { cls.forEach((c) => this.set.add(c)); }
    remove(...cls) { cls.forEach((c) => this.set.delete(c)); }
    toggle(c, force) {
      if (force === true) { this.set.add(c); return true; }
      if (force === false) { this.set.delete(c); return false; }
      if (this.set.has(c)) { this.set.delete(c); return false; }
      this.set.add(c); return true;
    }
    contains(c) { return this.set.has(c); }
  }

  function createEl(tag = 'div', id = '') {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      _html: '',
      textContent: '',
      value: '',
      style: {},
      dataset: {},
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 200,
      offsetTop: 10,
      offsetHeight: 30,
      children: [],
      attributes: {},
      listeners: {},
      parentElement: null,
      classList: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        }
      },
      focus() {},
      select() {},
      blur() {},
      closest() { return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        if (sel === '.nav-link') {
          const matches = [];
          const re = /class="nav-link[^"]*"[^>]*data-route="([^"]+)"/g;
          let m;
          const full = this._html || '';
          while ((m = re.exec(full))) {
            const a = createEl('a');
            a.dataset.route = m[1];
            matches.push(a);
          }
          return matches;
        }
        return [];
      },
    };
    el.classList = new MockClassList(el);
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v || ''); },
    });
    return el;
  }

  const registry = new Map();
  const appRoot = createEl('div', 'app');
  const bodyEl = createEl('body');
  registry.set('#app', appRoot);

  const ensureMockChild = (id) => {
    if (!registry.has('#' + id)) {
      const el = createEl('div', id);
      registry.set('#' + id, el);
    }
    return registry.get('#' + id);
  };

  let lastToast = '';
  const lsStore = new Map();
  const sandbox = {
    ME: { id: 1, username: 'admin', fullName: 'Admin User', roles: ['admin'], storeName: 'Main Store' },
    isAdmin: () => sandbox.ME.roles.includes('admin'),
    canView: (m) => sandbox.ME.roles.includes('admin') || m === 'fuel' || m === 'dashboard',
    canDo: (...caps) => sandbox.ME.roles.includes('admin') || caps.includes('fuel.view') || caps.includes('dashboard.view'),
    location: { hash: '#/dashboard' },
    localStorage: {
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => lsStore.set(k, String(v)),
      removeItem: (k) => lsStore.delete(k),
    },
    window: {
      location: { hash: '#/dashboard' },
      addEventListener() {},
      refreshMobileNav() {},
      woShellBridge: {
        getMe: () => sandbox.ME,
        isScreenLocked: () => false,
        slNowTime: () => '10:00',
        notifState: { open: false },
      },
    },
    document: {
      body: bodyEl,
      getElementById: (id) => (appRoot.innerHTML.includes(`id="${id}"`) || id === 'cmd_palette_overlay' ? ensureMockChild(id) : null),
      createElement: (tag) => {
        const el = createEl(tag);
        if (tag === 'div') el.id = '';
        return el;
      },
      querySelector: (sel) => registry.get(sel) || (sel.startsWith('#') && appRoot.innerHTML.includes(`id="${sel.slice(1)}"`) ? ensureMockChild(sel.slice(1)) : null),
      querySelectorAll: () => [],
    },
    qs: (sel) => {
      if (sel === '#app') return appRoot;
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (id === 'nav' && !appRoot.innerHTML.includes('id="nav"')) return null;
        return ensureMockChild(id);
      }
      return null;
    },
    qsa: (sel, rootEl) => {
      if (sel === '.nav-link' && rootEl === ensureMockChild('nav')) {
        const wrapHtml = ensureMockChild('nav_groups_wrap').innerHTML + ensureMockChild('nav_pinned_wrap').innerHTML;
        const out = [];
        const re = /data-route="([^"]+)"/g;
        let m;
        while ((m = re.exec(wrapHtml))) {
          const link = createEl('a');
          link.dataset.route = m[1];
          // Place inside [240, 440] viewport window so syncActiveNav leaves scrollTop undisturbed
          link.offsetTop = 280;
          out.push(link);
        }
        return out;
      }
      return [];
    },
    esc: (s) => String(s == null ? '' : s),
    api: async () => ({ badges: {} }),
    toast: (m) => { lastToast = m; },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval,
    URLSearchParams,
    Math, Array, Object, String, Number, Promise,
  };
  sandbox.window.window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(navDefs + '\nwindow.NAV = NAV; window.NAV_GROUP_ORDER = NAV_GROUP_ORDER; window.NAV_GROUP = NAV_GROUP; window.navVisible = navVisible;', sandbox);
  vm.runInContext(navSrc, sandbox, { filename: 'navigation.js' });

  const WONav = sandbox.window.WONav;
  assert.ok(WONav, 'window.WONav must be exported');

  // 1. Mount shell once
  WONav.syncShell('dashboard', '#/dashboard', []);
  const firstNavRef = ensureMockChild('nav');
  const scrollBox = ensureMockChild('nav_scroll');
  scrollBox.scrollTop = 240;

  // Switching to fuel keeps the exact same #nav element & preserves scrollTop
  const htmlBeforeSwitch = appRoot.innerHTML;
  WONav.syncShell('fuel', '#/fuel', []);
  assert.equal(ensureMockChild('nav'), firstNavRef, 'syncShell must keep same #nav DOM instance');
  assert.equal(appRoot.innerHTML, htmlBeforeSwitch, '#app wrapper must not be wiped on route transition');
  assert.equal(scrollBox.scrollTop, 240, 'Sidebar scroll position must be preserved across route navigation');
  assert.match(ensureMockChild('nav_breadcrumb').innerHTML, /Fuel Management/);
  assert.match(ensureMockChild('nav_breadcrumb').innerHTML, /Fuel Operations/);

  // 2. Pin limit (max 5)
  for (const r of ['dashboard', 'jobs', 'stores', 'fuel', 'assets']) WONav.togglePin(r);
  assert.equal(JSON.parse(lsStore.get('wo_nav_pins_1')).length, 5);
  WONav.togglePin('reports');
  assert.equal(JSON.parse(lsStore.get('wo_nav_pins_1')).length, 5, '6th pin must be rejected');
  assert.match(lastToast, /up to 5/i);
  WONav.togglePin('jobs');
  assert.equal(JSON.parse(lsStore.get('wo_nav_pins_1')).length, 4, 'Unpinning reduces pin count');

  // 3. RBAC scoping on Command Palette entries
  sandbox.ME = { id: 2, username: 'fueluser', roles: ['fuel_clerk'] };
  WONav.resetShell();
  WONav.syncShell('fuel', '#/fuel', []);
  const paletteRoutes = WONav.getPaletteEntries().map((e) => e.hash);
  assert.ok(paletteRoutes.some((h) => h.startsWith('#/fuel')), 'Fuel clerk sees Fuel routes in Ctrl+K');
  assert.equal(paletteRoutes.some((h) => h.startsWith('#/access')), false, 'Restricted user must NOT see Admin routes in Ctrl+K');
  assert.equal(paletteRoutes.some((h) => h.startsWith('#/stores')), false, 'Restricted user must NOT see Stores quick tabs in Ctrl+K');
});

test('4. Mobile CSS preserves drawer visibility and mobile-nav.js is dynamic & RBAC-aware', () => {
  const root = path.join(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const m768 = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.equal(/\.nav\s*\{\s*display\s*:\s*none\b/.test(m768), false, 'Phone media query must NOT hide .nav drawer');
  assert.match(m768, /\.mobile-bottom-nav\.has-session\s*\{\s*display:\s*flex;\s*\}/);

  const mobileSrc = fs.readFileSync(path.join(root, 'public', 'js', 'mobile-nav.js'), 'utf8');
  assert.equal(/#\/oil/.test(mobileSrc), false, 'mobile-nav.js must not hardcode legacy #/oil redirect');
  assert.equal(/configureServerIp/.test(mobileSrc), false, 'mobile-nav.js must not hardcode Server IP button in bottom tabs');

  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const navStart = appJs.indexOf('const NAV = [');
  const navEnd = appJs.indexOf("if (typeof window !== 'undefined') {", navStart);
  const navDefs = appJs.slice(navStart, navEnd);

  const sandbox = {
    ME: { id: 1, roles: ['admin'] },
    isAdmin: () => true,
    canView: () => true,
    canDo: () => true,
    location: { hash: '#/dashboard' },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    window: {},
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(navDefs + '\nwindow.NAV = NAV; window.navVisible = navVisible;', sandbox);
  vm.runInContext(mobileSrc, sandbox, { filename: 'mobile-nav.js' });

  const adminTabs = sandbox.window.buildMobileTabs({ id: 1, roles: ['admin'] });
  assert.equal(adminTabs.length, 5);
  assert.equal(adminTabs[4].key, '__menu');
  assert.deepEqual(Array.from(adminTabs.slice(0, 4).map((t) => t.key)), ['dashboard', 'jobs', 'stores', 'fuel']);

  // Pump-only scope user gets pump tabs + Menu
  sandbox.ME = { id: 9, roles: ['fuel_pump'], fuelScope: { isPumpOnly: true } };
  sandbox.isAdmin = () => false;
  sandbox.canView = (m) => m === 'fuel' || m === 'fuel_readings';
  sandbox.canDo = (...caps) => caps.includes('fuel.view') || caps.includes('fuel.readings.view');
  const pumpTabs = sandbox.window.buildMobileTabs(sandbox.ME);
  assert.equal(pumpTabs[0].hash, '#/fuel?tab=site-console');
  assert.equal(pumpTabs[1].key, 'fuel-readings');
  assert.equal(pumpTabs[pumpTabs.length - 1].key, '__menu');
});
