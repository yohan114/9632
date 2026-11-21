'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const vm = require('vm');
const zlib = require('zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p5c-mod-'));
process.env.DB_PATH = path.join(TMP, 'p5c.db');
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, migrate } = require('../src/db');
migrate();

const app = require('../src/server');
let server;
let port;

const EXTRACTED_MODULES = [
  'vehicle_documents.js',
  'asset_aliases.js',
  'access_control.js',
  'outsourcing_ccom.js',
];

const CROSS_MODULE_SYMBOLS = [
  'showErlChecklistModal',
  'showRenewDocumentModal',
  'showDocumentHistoryModal',
  'showDocumentExemptionModal',
  'renderGovernanceTab',
  'renderPeopleAccess',
  'renderAuditLogs',
  'renderRolesManager',
  'renderOutsourcingJobSectionHtml',
  'renderOutsourcingServiceSectionHtml',
  'wireOutsourcingSection',
  'jobsOutsourcing',
];

function rawReq(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw });
      });
    }).on('error', reject);
  });
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

test('1. Extracted frontend modules parse cleanly, use capability checks, and contain zero alert()/prompt()', () => {
  const root = path.join(__dirname, '..');
  const modDir = path.join(root, 'public', 'modules');

  let combinedModulesSrc = '';
  for (const modName of EXTRACTED_MODULES) {
    const filePath = path.join(modDir, modName);
    assert.ok(fs.existsSync(filePath), `Missing extracted module: ${modName}`);
    const src = fs.readFileSync(filePath, 'utf8');
    new vm.Script(src, { filename: modName });
    assert.equal(/\balert\s*\(/.test(src), false, `Found blocking alert() in ${modName}`);
    assert.equal(/(^|[^\w.])can\(/m.test(src), false, `Found legacy can(role) in ${modName}`);
    assert.equal(/roles\.includes\('(?!admin')/.test(src), false, `Found hardcoded non-admin roles.includes() in ${modName}`);
    if (modName === 'outsourcing_ccom.js') {
      assert.equal(/\bprompt\s*\(/.test(src), false, 'Found blocking prompt() in outsourcing_ccom.js');
      assert.match(src, /fieldId:\s*'txt-cancel-reason'/);
    }
    combinedModulesSrc += '\n' + src;
  }

  for (const sym of CROSS_MODULE_SYMBOLS) {
    const defRe = new RegExp(`(?:function\\s+${sym}\\b|\\b${sym}\\s*=)`);
    assert.match(combinedModulesSrc, defRe, `Missing cross-module symbol definition: ${sym}`);
  }
});

test('2. public/app.js shrunk below 24,000 lines and parses cleanly via vm.Script', () => {
  const root = path.join(__dirname, '..');
  const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const lineCount = appSrc.split(/\r?\n/).length;
  assert.ok(lineCount < 24000, `Expected public/app.js < 24,000 lines, got ${lineCount}`);
  new vm.Script(appSrc, { filename: 'public/app.js' });
  assert.match(appSrc, /\/\/ Extracted to public\/modules\/vehicle_documents\.js/);
  assert.match(appSrc, /\/\/ Extracted to public\/modules\/asset_aliases\.js/);
  assert.match(appSrc, /\/\/ Extracted to public\/modules\/access_control\.js/);
  assert.match(appSrc, /\/\/ Extracted to public\/modules\/outsourcing_ccom\.js/);
});

test('3. Service worker cache is >= workshopone-v17 and index.html loads all modules with uniform cache-bust tokens', async () => {
  const root = path.join(__dirname, '..');
  const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  const swMatch = swSrc.match(/const CACHE = 'workshopone-v(\d+)';/);
  assert.ok(swMatch && Number(swMatch[1]) >= 17, `Expected sw.js CACHE >= workshopone-v17, got ${swMatch ? swMatch[0] : 'none'}`);

  const res = await rawReq('/');
  assert.equal(res.status, 200);
  const html = res.raw.toString('utf8');

  const tokens = new Set();
  for (const modName of EXTRACTED_MODULES) {
    const m = html.match(new RegExp(`<script src="/modules/${modName.replace('.', '\\.')}(\\?v=\\d+)">`));
    assert.ok(m, `Expected versioned <script> for /modules/${modName} in index.html`);
    tokens.add(m[1]);
  }
  const appMatch = html.match(/<script src="\/app\.js(\?v=\d+)">/);
  assert.ok(appMatch, 'Expected versioned <script> for /app.js');
  tokens.add(appMatch[1]);
  assert.equal(tokens.size, 1, `Expected uniform ?v= token across app.js and extracted modules, got ${[...tokens].join(', ')}`);
});

test('4. All 4 extracted modules are served with HTTP gzip compression', async () => {
  for (const modName of EXTRACTED_MODULES) {
    const res = await rawReq(`/modules/${modName}`, { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200, `Expected 200 for /modules/${modName}`);
    assert.equal(res.headers['content-encoding'], 'gzip', `Expected gzip encoding for /modules/${modName}`);
    const body = zlib.gunzipSync(res.raw).toString('utf8');
    const expected = fs.readFileSync(path.join(__dirname, '..', 'public', 'modules', modName), 'utf8');
    assert.equal(body, expected, `Gzip body mismatch for /modules/${modName}`);
  }
});

test('5. routes.aliases executes without TDZ ReferenceError, styles.css drops CSP-blocked CDN fonts, and fleet_profitability.js includes pagination', async () => {
  const root = path.join(__dirname, '..');
  const aliasesSrc = fs.readFileSync(path.join(root, 'public', 'modules', 'asset_aliases.js'), 'utf8');
  const declIdx = aliasesSrc.indexOf('const canResolve =');
  const btnIdx = aliasesSrc.indexOf('btn_alias_auto_suggest');
  assert.ok(declIdx !== -1 && btnIdx !== -1 && declIdx < btnIdx, 'const canResolve must be declared before btn_alias_auto_suggest template');

  const mkEl = () => ({
    innerHTML: '',
    value: '',
    style: {},
    dataset: {},
    disabled: false,
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    onclick: null,
    oninput: null,
    onchange: null,
  });

  const mockPending = Array.from({ length: 250 }, (_, idx) => ({
    id: idx + 1,
    raw_text: `VEH-${idx + 1}`,
    hit_count: 1,
    source: 'stores',
  }));
  const mockAssets = Array.from({ length: 1000 }, (_, idx) => ({
    id: idx + 1,
    code: `DT-${idx + 1}`,
    registration: `LM-${1000 + idx}`,
    brand: 'SINOTRUK',
    type: 'tipper',
  }));

  const apiResponses = {
    '/aliases?resolved=0': mockPending,
    '/aliases?resolved=1&limit=500': [],
    '/assets?limit=10000': mockAssets,
    '/mechanics/aliases?resolved=0': [],
    '/mechanics': [],
    '/aliases/sections-audit': { missingJobs: [], missingJobRequests: [], missingServices: [], missingIssues: [], missingMrn: [], counts: { jobs: 0, jobRequests: 0, services: 0, issues: 0, mrn: 0, totalMissing: 0 } },
  };

  const elementsBySelector = new Map();
  const sandbox = {
    routes: {},
    api: async (p) => apiResponses[p] ?? [],
    qs: (sel) => {
      if (!elementsBySelector.has(sel)) elementsBySelector.set(sel, mkEl());
      return elementsBySelector.get(sel);
    },
    qsa: () => [],
    esc: (s) => String(s == null ? '' : s),
    pageHeader: (t, sub) => `<h1>${t}</h1><p>${sub}</p>`,
    tableWrap: (cols, rows) => `<table>${rows.join('')}</table>`,
    canDo: () => true,
    isAdmin: () => true,
    toast: () => {},
    modal: () => {},
    Math,
    Array,
    Promise,
    String,
    Number,
    Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(aliasesSrc, sandbox, { filename: 'asset_aliases.js' });

  const container = mkEl();
  await sandbox.routes.aliases(container);
  assert.match(container.innerHTML, /btn_alias_auto_suggest/, 'Rendered aliases screen should contain Auto-Match Suggestions button');

  const wrapEl = elementsBySelector.get('#alias_veh_table_wrap');
  assert.ok(wrapEl && wrapEl.innerHTML, 'Expected #alias_veh_table_wrap to be rendered');
  assert.match(wrapEl.innerHTML, /data-lazy-assets="1"/);
  assert.match(wrapEl.innerHTML, /id="alias_veh_pager"/);
  assert.equal((wrapEl.innerHTML.match(/data-alias-row="/g) || []).length, 50, 'Pending aliases table should paginate at 50 rows');
  assert.ok((wrapEl.innerHTML.match(/<option/g) || []).length < 200, 'Initial DOM must not duplicate 1,000 asset <option> elements per row');

  const sugModalSrc = aliasesSrc.slice(aliasesSrc.indexOf('async function openAliasAutoSuggestionsModal'));
  assert.match(sugModalSrc, /data-lazy-assets="optgroup"/);
  assert.equal(/<optgroup label="All Registered Assets">\$\{aopts\}<\/optgroup>/.test(sugModalSrc), false, 'Auto-Match modal must lazy-load all-assets optgroup');

  const cssSrc = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  assert.equal(/fonts\.googleapis\.com/i.test(cssSrc), false, 'styles.css must not import CSP-blocked external Google Fonts');

  const plSrc = fs.readFileSync(path.join(root, 'public', 'modules', 'fleet_profitability.js'), 'utf8');
  new vm.Script(plSrc, { filename: 'fleet_profitability.js' });
  assert.match(plSrc, /id="pl_pager"/);
  assert.match(plSrc, /#pl_pager/);
  assert.match(plSrc, /id="pl_filter_active_only"/);
});
