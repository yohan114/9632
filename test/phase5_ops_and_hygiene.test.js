'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-p5-ops-'));
const BACKUP_TMP = path.join(TMP, 'backups');
process.env.DB_PATH = path.join(TMP, 'p5.db');
process.env.MULTIDB = '0';
process.env.BACKUP_DIR = BACKUP_TMP;
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.NO_PORT = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db, get, all, run, migrate } = require('../src/db');
migrate();

const auth = require('../src/lib/auth');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const m066 = require('../src/migrate/066_phase5_ops_and_data_hygiene');

for (const r of ['admin', ...Object.keys(permissions.DEFAULT_MATRIX)]) {
  run('INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES (?, ?, 1, 1)', r, r);
}
permissions.seedDefaults();
capabilities.seedCapabilities();
run("INSERT OR IGNORE INTO roles (name, label, is_system, active) VALUES ('p5_viewer', 'P5 Viewer', 0, 1)");

const PW = 'PhaseFive#2026!';
function mkUser(username, roleName) {
  const uid = run(
    'INSERT INTO users (username, full_name, password_hash, active) VALUES (?, ?, ?, 1)',
    username, username, auth.hashPassword(PW)
  ).lastInsertRowid;
  run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', uid, roleName);
  return uid;
}

mkUser('p5_admin', 'admin');
mkUser('p5_viewer', 'p5_viewer');

const app = require('../src/server');
let server;
let port;
let adminCookie;
let viewerCookie;

function rawReq(method, p, { headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json,
          text,
          cookie: sc ? sc[0].split(';')[0] : null,
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  adminCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p5_admin', password: PW } })).cookie;
  viewerCookie = (await rawReq('POST', '/api/auth/login', { body: { username: 'p5_viewer', password: PW } })).cookie;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('1. Migration 066 deactivates test accounts, links unambiguous aliases, prices catalog-matched issues, and closes zero-qty overdue MRNs', () => {
  // Seed legacy active test accounts + sessions
  const t1 = mkUser('testone', 'manager');
  const t2 = mkUser('test', 'p5_viewer');
  const t3 = mkUser('test_u', 'p5_viewer');
  run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'sess-test-1', datetime('now', '+1 day'))", t1);

  // Assets for alias & issue checks
  const a1 = run("INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('LO 0434', 'LO0434', 'LO-0434', 'loader', 'active')").lastInsertRowid;
  const a2 = run("INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('TM-18', 'TM18', 'ZA-8511', 'mixer', 'active')").lastInsertRowid;
  const a3 = run("INSERT INTO assets (code, code_norm, registration, type, status) VALUES ('LB-23', 'LB23', 'ZB-2587', 'jcb', 'active')").lastInsertRowid;

  // Aliases: direct exact, single-token extracted, AND multi-vehicle string (must NOT auto-link!)
  const alDirect = run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('LO-0434', 'LO0434', 0, 3, 'oilbook')").lastInsertRowid;
  const alToken = run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('ZA-8511-Front Engine', 'ZA8511FRONTENGINE', 0, 2, 'stores')").lastInsertRowid;
  const alMulti = run("INSERT INTO asset_aliases (raw_text, raw_norm, resolved, hit_count, source) VALUES ('01.ZA-8511, 02.ZB-2587', '01ZA851102ZB2587', 0, 1, 'stores')").lastInsertRowid;

  // Store items: unambiguous exact name vs ambiguous conflicting prices
  const siClean = run("INSERT INTO store_items (name, part_number, category, unit, balance, unit_cost) VALUES ('Petrol', 'GEN-PET', 'Fuel', 'L', 20, 750)").lastInsertRowid;
  run("INSERT INTO store_items (name, part_number, category, unit, balance, unit_cost) VALUES ('Ambig Part', 'AMB-1', 'Spares', 'nos', 2, 100)");
  run("INSERT INTO store_items (name, part_number, category, unit, balance, unit_cost) VALUES ('Ambig Part', 'AMB-2', 'Spares', 'nos', 2, 999)");

  const jc = run("INSERT INTO job_cards (job_no, type, description, status, asset_id) VALUES ('2026/11/R/555', 'repair', 'Test cleanup', 'IN_WORKSHOP', ?)", a1).lastInsertRowid;
  const issClean = run("INSERT INTO issues (asset_id, job_id, description, qty, unit_price, issue_date, store_id, voided) VALUES (?, ?, 'Petrol', 2, 0, '2026-10-05', 1, 0)", a1, jc).lastInsertRowid;
  run("INSERT INTO stock_moves (section, kind, item_key, item_name, qty, unit_price, source_table, source_id, asset_id, job_id, txn_date) VALUES ('general', 'out', 'petrol', 'Petrol', 2, 0, 'issues', ?, ?, ?, '2026-10-05')", issClean, a1, jc);
  const jpClean = run("INSERT INTO job_parts (job_id, source_type, source_id, description, qty, unit_price) VALUES (?, 'issue', ?, 'Petrol', 2, 0)", jc, issClean).lastInsertRowid;
  const issAmbig = run("INSERT INTO issues (asset_id, job_id, description, qty, unit_price, issue_date, store_id, voided) VALUES (?, ?, 'Ambig Part', 1, 0, '2026-10-05', 1, 0)", a3, jc).lastInsertRowid;

  // MRNs: zero-qty overdue (must auto-close) vs real unfulfilled overdue (must stay open)
  const mrnZero = run("INSERT INTO mrn (mrn_no, req_date, asset_id, purpose, requested_by, status) VALUES ('MRN-ZERO-1', date('now', '-60 days'), ?, 'Legacy empty', 'old', 'open')", a1).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Old item', 0, 0)", mrnZero);

  const mrnReal = run("INSERT INTO mrn (mrn_no, req_date, asset_id, purpose, requested_by, status) VALUES ('MRN-REAL-1', date('now', '-60 days'), ?, 'Pending bearing', 'old', 'open')", a1).lastInsertRowid;
  run("INSERT INTO mrn_lines (mrn_id, description, qty, qty_received) VALUES (?, 'Bearing', 4, 0)", mrnReal);

  const res = m066.runMigration(db);
  assert.equal(res.testAccountsDeactivated, 3);
  assert.equal(res.aliasesAutoLinked, 2);
  assert.equal(res.issuesPriced, 1);
  assert.equal(res.zeroQtyMrnsClosed, 1);

  assert.equal(get('SELECT active FROM users WHERE id = ?', t1).active, 0);
  assert.equal(get('SELECT active FROM users WHERE id = ?', t2).active, 0);
  assert.equal(get('SELECT active FROM users WHERE id = ?', t3).active, 0);
  assert.equal(get('SELECT active FROM users WHERE username = ?', 'p5_admin').active, 1);
  assert.equal(get("SELECT 1 FROM sessions WHERE token = 'sess-test-1'"), undefined);

  assert.equal(get('SELECT resolved, asset_id FROM asset_aliases WHERE id = ?', alDirect).asset_id, a1);
  assert.equal(get('SELECT resolved, asset_id FROM asset_aliases WHERE id = ?', alToken).asset_id, a2);
  assert.equal(get('SELECT resolved FROM asset_aliases WHERE id = ?', alMulti).resolved, 0);

  assert.equal(get('SELECT unit_price, store_item_id FROM issues WHERE id = ?', issClean).unit_price, 750);
  assert.equal(get('SELECT store_item_id FROM issues WHERE id = ?', issClean).store_item_id, siClean);
  assert.equal(get("SELECT unit_price FROM stock_moves WHERE source_table = 'issues' AND source_id = ?", issClean).unit_price, 750);
  assert.equal(get('SELECT unit_price FROM job_parts WHERE id = ?', jpClean).unit_price, 750);
  assert.equal(get('SELECT unit_price FROM issues WHERE id = ?', issAmbig).unit_price, 0);

  assert.equal(get('SELECT status FROM mrn WHERE id = ?', mrnZero).status, 'closed');
  assert.equal(get('SELECT status FROM mrn WHERE id = ?', mrnReal).status, 'open');

  // Re-running is strictly idempotent
  const second = m066.runMigration(db);
  assert.deepEqual(second, { testAccountsDeactivated: 0, aliasesAutoLinked: 0, issuesPriced: 0, zeroQtyMrnsClosed: 0 });
});

test('2. GET /api/master-dashboard/data-hygiene.xlsx exports multi-sheet workbook', async () => {
  const denied = await rawReq('GET', '/api/master-dashboard/data-hygiene.xlsx', { cookie: viewerCookie });
  assert.equal(denied.status, 403);

  const ok = await rawReq('GET', '/api/master-dashboard/data-hygiene.xlsx', { cookie: adminCookie });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type'] || ''), /spreadsheetml\.sheet/);
  assert.match(String(ok.headers['content-disposition'] || ''), /attachment;\s*filename="data-hygiene-worklist-.*\.xlsx"/);
  assert.equal(ok.raw[0], 0x50);
  assert.equal(ok.raw[1], 0x4b);
  assert.ok(ok.raw.length > 1000);
});

test('3. Backup inspection and pruning preserve manual backups, enforce keep >= 3 floor, and log audit', async () => {
  fs.mkdirSync(BACKUP_TMP, { recursive: true });
  for (let i = 1; i <= 6; i++) {
    const name = `workshopone-2026-11-20T0${i}-00-00-000Z.db`;
    fs.writeFileSync(path.join(BACKUP_TMP, name), Buffer.alloc(1024, i));
    fs.writeFileSync(path.join(BACKUP_TMP, name.replace(/\.db$/, '.manifest.json')), '{"ok":true}');
  }
  fs.writeFileSync(path.join(BACKUP_TMP, 'pre-manual-keep.db'), Buffer.alloc(2048, 9));
  fs.writeFileSync(path.join(BACKUP_TMP, 'pre-manual-keep.db-wal'), Buffer.alloc(512, 7));

  const deniedList = await rawReq('GET', '/api/master-dashboard/backups', { cookie: viewerCookie });
  assert.equal(deniedList.status, 403);
  const deniedPrune = await rawReq('POST', '/api/master-dashboard/backups/prune', { cookie: viewerCookie, body: { keep: 3 } });
  assert.equal(deniedPrune.status, 403);

  const list = await rawReq('GET', '/api/master-dashboard/backups', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.autoCount, 6);
  assert.equal(list.json.manualCount, 1);
  assert.equal(list.json.sidecarCount, 1);

  // Passing keep: 1 must clamp to safety floor of 3
  const prune = await rawReq('POST', '/api/master-dashboard/backups/prune', { cookie: adminCookie, body: { keep: 1 } });
  assert.equal(prune.status, 200, prune.text);
  assert.equal(prune.json.keep, 3);
  assert.equal(prune.json.snapshotsDeleted, 3);
  assert.equal(prune.json.sidecarsRemoved, 1);
  assert.equal(prune.json.remainingAutoCount, 3);
  assert.equal(prune.json.summary.manualCount, 1);
  assert.ok(fs.existsSync(path.join(BACKUP_TMP, 'pre-manual-keep.db')), 'Manual backup preserved');
  assert.equal(fs.existsSync(path.join(BACKUP_TMP, 'pre-manual-keep.db-wal')), false, 'Sidecar cleaned');
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'system_backup' AND action = 'prune'"));
});

test('4. Zero blocking alert() calls remain in public/app.js or any public/modules/*.js', () => {
  const root = path.join(__dirname, '..');
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.equal(/\balert\(/.test(appJs), false, 'Found blocking alert() in public/app.js');

  const modDir = path.join(root, 'public', 'modules');
  for (const f of fs.readdirSync(modDir)) {
    const src = fs.readFileSync(path.join(modDir, f), 'utf8');
    assert.equal(/\balert\(/.test(src), false, `Found blocking alert() in public/modules/${f}`);
  }
});
