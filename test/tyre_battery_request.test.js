'use strict';

// Asking for a tyre, and accounting for the one that came off.
//
// The register the workshop has kept since 2012 records ISSUES, not requests: 6,061 lines that
// left the store with nothing behind them saying who asked or who agreed. And the item was always
// free text — 804 spellings of about 170 real tyre sizes, so a third of tyre issues never reached
// a price at all.
//
// So two rules carry this module, and both are tested here:
//   * the item is CHOSEN FROM A LIST, never typed;
//   * nothing leaves the store on a request nobody approved.
//
// A third follows from the first two: a replacement is not finished when the new one goes on. An
// old battery is worth money and an old tyre may still be retreadable, so the issue stays open
// until somebody says what became of the old one — "not returned" included, as long as it says why.

const os = require('os');
const path = require('path');
const fs = require('fs');
const TEST_DB = path.join(os.tmpdir(), 'workshopone-tb-request-test.db');
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + s); } catch {} }
process.env.DB_PATH = TEST_DB;
process.env.BACKUP_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, run, get, all } = require('../src/db');
const tb = require('../src/lib/tyre_battery');

migrate();

for (const n of ['admin', 'storekeeper', 'workshop', 'operational_manager', 'manager']) {
  run('INSERT INTO roles (name) VALUES (?)', n);
}
const mkUser = (name, roles) => {
  const id = run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, 1)', name,
    require('../src/lib/auth').hashPassword('pw')).lastInsertRowid;
  for (const r of roles) run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = ?))', id, r);
  return id;
};
mkUser('boss', ['admin']);
mkUser('keeper', ['storekeeper']);
mkUser('fitter', ['workshop']);
mkUser('opsman', ['operational_manager']);

const app = require('../src/server');
let server; let base;
const cookies = {};
test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['boss', 'keeper', 'fitter', 'opsman']) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'pw' }),
    });
    cookies[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
});
test.after(() => server && server.close());

const as = (who, method, url, body) => fetch(base + url, {
  method, headers: { 'content-type': 'application/json', cookie: cookies[who] },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

// The shelf and the machine.
const TYRE = run(`INSERT INTO tb_specs (kind, size, tyre_type, label, spec_key, unit_price, source)
                  VALUES ('tyre','1000 X 20','ORIGINAL - RADIAL','1000 X 20 · ORIGINAL - RADIAL',?,21600,'workbook')`,
tb.parse('tyre', '1000 X 20 ORIGINAL RADIAL').spec_key).lastInsertRowid;
const BATT = run(`INSERT INTO tb_specs (kind, rating, label, spec_key, unit_price, source)
                  VALUES ('battery','95 Amp','95 Amp',?,38645,'workbook')`,
tb.parse('battery', '95 AMP').spec_key).lastInsertRowid;
const ASSET = run(`INSERT INTO assets (code, code_norm, registration, in_register) VALUES ('LL-1782','LL1782','LL-1782',1)`).lastInsertRowid;

// ---- the item is chosen from a list ----------------------------------------

test('a tyre size is read as numbers, however it was written', () => {
  const a = tb.parse('tyre', '1000X20 ORIGIONAL RADIAL TYRE');
  const b = tb.parse('tyre', '1000 X 20 Original Radial');
  assert.strictEqual(a.spec_key, b.spec_key, 'the same tyre spelt two ways is one shelf');
  assert.strictEqual(a.size, '1000 X 20');
  assert.strictEqual(a.tyre_type, 'ORIGINAL - RADIAL');
});

test('the radial R is not part of the size', () => {
  assert.strictEqual(tb.parse('tyre', '275X70R 22.5').spec_key, tb.parse('tyre', '275 X 70 X 22.5').spec_key,
    'the R form and the X form are one tyre — otherwise the rim is lost and the size splits in two');
  assert.strictEqual(tb.parse('tyre', '275X70R 22.5').size, '275 X 70 X 22.5');
});

test('a bracket is a note, not a size', () => {
  assert.strictEqual(tb.parse('tyre', '1000 X 20 (ORIG-04)').size, '1000 X 20',
    'the 04 is a quantity — reading it as a rim invents a tyre nobody sells');
  assert.strictEqual(tb.parse('tyre', '1000 X 20 USE TYRE (43-3416)').size, '1000 X 20');
});

test('a battery is the number before AMP, not the voltage', () => {
  assert.strictEqual(tb.parse('battery', '12V - 95 AMP').rating, '95 Amp');
  assert.strictEqual(tb.parse('battery', '12 V / 150 AH').rating, '150 Amp');
});

test('words the vocabulary does not know are left alone, not guessed', () => {
  assert.strictEqual(tb.parse('tyre', '1000 X 20 SOMETHING ODD').tyre_type, 'NOT SPECIFIED');
});

test('the picklist is offered to anyone signed in, so the form can be filled', async () => {
  const r = await as('fitter', 'GET', '/api/tb/specs?kind=tyre');
  assert.strictEqual(r.status, 200, 'gating a list of tyre sizes is how a dropdown comes up empty');
  assert.ok((await json(r)).some((s) => s.id === TYRE));
});

// ---- raising the request ---------------------------------------------------

let requestId; let lineId; let mrnNo;

test('a request names the machine, the shelf and the reason', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, site: 'BADALGAMA',
    lines: [{ spec_id: TYRE, qty: 2, reason: 'worn', position: 'RL1', km_reading: 145320 }],
  });
  const b = await json(r);
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  requestId = b.id; mrnNo = b.mrn_no;
  assert.ok(mrnNo, 'it takes a number from the series the workshop already uses');
  const line = get(`SELECT * FROM tb_request_lines WHERE mrn_line_id =
                     (SELECT id FROM mrn_lines WHERE mrn_id = ? LIMIT 1)`, requestId);
  lineId = line.mrn_line_id;
  assert.strictEqual(line.position, 'RL1');
  assert.strictEqual(line.km_reading, 145320);
  assert.strictEqual(line.reason, 'worn');
});

test('it is an ordinary MRN, so it lands in the inbox the managers already read', () => {
  const m = get('SELECT * FROM mrn WHERE id = ?', requestId);
  assert.strictEqual(m.approval_status, 'requested');
  assert.strictEqual(m.request_type, 'tyre');
  assert.strictEqual(get('SELECT COUNT(*) c FROM mrn_lines WHERE mrn_id = ?', requestId).c, 1);
});

test('a size that is not on the list is refused', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, lines: [{ spec_id: 99999, qty: 1, reason: 'worn' }],
  });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /from the list/i, 'this is the rule that stops the next ten years reading like the last ten');
});

test('a battery cannot be requested on a tyre request', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, lines: [{ spec_id: BATT, qty: 1, reason: 'worn' }],
  });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /battery does not belong on a tyre request/i);
});

test('a request with no machine on it is refused', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', lines: [{ spec_id: TYRE, qty: 1, reason: 'worn' }],
  });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /vehicle or machine/i, 'a tyre is always FOR something, or there is no cost to carry');
});

test('a reason outside the list is refused, so the pattern stays countable', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, lines: [{ spec_id: TYRE, qty: 1, reason: 'because' }],
  });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /say why/i);
});

// ---- nothing leaves the store unapproved -----------------------------------

test('an unapproved request issues nothing', async () => {
  const r = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 1 });
  assert.strictEqual(r.status, 409);
  assert.match((await json(r)).error, /approved/i);
  assert.strictEqual(get('SELECT COUNT(*) c FROM tyre_battery_issues WHERE mrn_line_id = ?', lineId).c, 0,
    'and writes nothing while refusing');
});

test('once certified and approved, the store can issue it', async () => {
  const c = await as('fitter', 'POST', `/api/stores/mrn/${requestId}/certify`, { signed_name: 'fitter' });
  assert.ok(c.status < 300, JSON.stringify(await json(c)));
  const a = await as('opsman', 'POST', `/api/stores/mrn/${requestId}/approve`, { signed_name: 'opsman' });
  assert.ok(a.status < 300, JSON.stringify(await json(a)));
  assert.strictEqual(get('SELECT approval_status FROM mrn WHERE id = ?', requestId).approval_status, 'approved');

  const r = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 2, serial_no: 'TY-0001' });
  assert.strictEqual(r.status, 201, JSON.stringify(await json(r)));
  const issue = get('SELECT * FROM tyre_battery_issues WHERE mrn_line_id = ?', lineId);
  assert.strictEqual(issue.qty, 2);
  assert.strictEqual(issue.min_number, mrnNo, 'the issue carries the request number, as the old register always did');
  assert.strictEqual(issue.spec_id, TYRE, 'and the shelf it came off');
  assert.strictEqual(issue.position, 'RL1');
  assert.strictEqual(issue.unit_price, 21600, 'priced from the specification, not typed again');
});

test('more cannot go out than was approved', async () => {
  const r = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 1 });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /already went out/i);
});

test('a fitter cannot issue from the store', async () => {
  const r = await as('fitter', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 1 });
  assert.strictEqual(r.status, 403);
});

// ---- what came off ---------------------------------------------------------

let issueId;

test('an issue is not finished until the old one is accounted for', async () => {
  issueId = get('SELECT id FROM tyre_battery_issues WHERE mrn_line_id = ?', lineId).id;
  const out = await json(await as('keeper', 'GET', '/api/tb/returns/outstanding?kind=tyre'));
  assert.ok(out.some((o) => o.issue_id === issueId), 'it stands on the outstanding list until somebody says');
});

test('"not returned" is a real answer, but it has to say why', async () => {
  const bad = await as('keeper', 'POST', '/api/tb/returns', { issue_id: issueId, condition: 'not_returned' });
  assert.strictEqual(bad.status, 400);
  assert.match((await json(bad)).error, /why/i, 'otherwise a lost tyre is indistinguishable from a forgotten one');
});

test('recording what came off clears it from the outstanding list', async () => {
  const r = await as('keeper', 'POST', '/api/tb/returns', {
    issue_id: issueId, condition: 'retreadable', serial_no: 'TY-OLD-9', km_reading: 145320,
    returned_to: 'Main Store',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(await json(r)));
  const out = await json(await as('keeper', 'GET', '/api/tb/returns/outstanding?kind=tyre'));
  assert.ok(!out.some((o) => o.issue_id === issueId));
  assert.strictEqual(get('SELECT condition FROM tb_returns WHERE issue_id = ?', issueId).condition, 'retreadable');
});

test('the old one is only accounted for once', async () => {
  const r = await as('keeper', 'POST', '/api/tb/returns', { issue_id: issueId, condition: 'scrap' });
  assert.strictEqual(r.status, 409);
});

test('a condition outside the list is refused', async () => {
  const i = run(`INSERT INTO tyre_battery_issues (kind, issue_date, qty, source) VALUES ('tyre', '2026-08-22', 1, 'request')`).lastInsertRowid;
  const r = await as('keeper', 'POST', '/api/tb/returns', { issue_id: i, condition: 'thrown away' });
  assert.strictEqual(r.status, 400);
});

test('the store can see what it is holding in old units', async () => {
  const s = await json(await as('keeper', 'GET', '/api/tb/returns/summary'));
  assert.ok(s.some((r) => r.kind === 'tyre' && r.condition === 'retreadable' && r.n === 1));
});

// ---- the issue reaches the shared ledger -----------------------------------

test('a new issue reaches the stock ledger through the rebuild, not by a second write', () => {
  const stock = require('../src/lib/stock');
  stock.rebuild({ wipe: true });
  const rows = all(`SELECT section, kind, qty FROM stock_moves WHERE source_table = 'tyre_battery_issues' AND source_id = ?`, issueId);
  assert.strictEqual(rows.length, 1, 'exactly one movement — writing one by hand as well would hold it twice');
  assert.strictEqual(rows[0].section, 'tyre');
  assert.strictEqual(rows[0].kind, 'out');
  assert.strictEqual(rows[0].qty, 2);
});

// ---- naming the job is enough ---------------------------------------------
//
// The request form pins the machine with the asset picker, but a request raised from a job card
// should not have to say the vehicle twice — the card already knows it. This is also the guard
// against a form that can never succeed: an earlier version passed a field the picker does not
// return, so asset_id arrived empty every time and the API refused every request.

test('a request can name the job card instead, and takes the vehicle from it', async () => {
  const job = run(`INSERT INTO job_cards (job_no, asset_id, description, status, requested_at)
                   VALUES ('TB/JOB/1', ?, 'tyre change', 'IN_PROGRESS', '2026-08-22')`, ASSET).lastInsertRowid;
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'battery', job_id: job, lines: [{ spec_id: BATT, qty: 1, reason: 'no_crank' }],
  });
  const b = await json(r);
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  const m = get('SELECT asset_id, job_id FROM mrn WHERE id = ?', b.id);
  assert.strictEqual(m.asset_id, ASSET, 'the vehicle comes off the card rather than being asked for twice');
  assert.strictEqual(m.job_id, job);
});

test('a request naming neither a machine nor a job is still refused', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'battery', lines: [{ spec_id: BATT, qty: 1, reason: 'no_crank' }],
  });
  assert.strictEqual(r.status, 400);
});

// ---- a tyre rarely goes on alone ------------------------------------------
//
// The register has been writing "750 X 16 TYER /TUBE/COLLER" into the tyre's own description
// because a request could only ever name one thing. A tyre request now carries the tyre, its tube
// and its flap as separate lines — which is what makes "how many tubes did we fit" answerable.

const TUBE = run(`INSERT INTO tb_specs (kind, size, label, spec_key, source)
                  VALUES ('tube','750 X 16','750 X 16 tube',?,'workbook')`,
tb.parse('tube', '750 X 16').spec_key).lastInsertRowid;
const FLAP = run(`INSERT INTO tb_specs (kind, size, label, spec_key, source)
                  VALUES ('flap','750 X 16','750 X 16 flap',?,'workbook')`,
tb.parse('flap', '750 X 16').spec_key).lastInsertRowid;

test('a tube is keyed by size alone — one tube fits the canvas and the remould', () => {
  assert.strictEqual(tb.parse('tube', '750 X 16 CANVAS').spec_key, tb.parse('tube', '750 X 16 DAG').spec_key,
    'putting the tyre type on a tube would split one tube into five');
});

test('a quantity written with a leading zero is not a rim', () => {
  assert.strictEqual(tb.parse('tyre', '1100 X 20 X 02').size, '1100 X 20',
    'the workbook carried eight of these through, and each spawned a tyre, a tube and a flap nobody sells');
  assert.strictEqual(tb.parse('tyre', '12.5 X 80 X 18').size, '12.5 X 80 X 18', 'a real rim still survives');
  assert.strictEqual(tb.parse('tyre', '265 X 65 X 17').size, '265 X 65 X 17');
});

test('one request carries the tyre, its tube and its flap', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn',
    lines: [
      { spec_id: TYRE, qty: 2, position: 'RL1' },
      { spec_id: TUBE, qty: 2 },
      { spec_id: FLAP, qty: 2 },
    ],
  });
  const b = await json(r);
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  assert.strictEqual(b.lines, 3, 'three items on one request, not three requests');
  const kinds = all(`SELECT r.kind FROM tb_request_lines r JOIN mrn_lines l ON l.id = r.mrn_line_id
                      WHERE l.mrn_id = ? ORDER BY r.kind`, b.id).map((x) => x.kind);
  assert.deepStrictEqual(kinds, ['flap', 'tube', 'tyre'],
    'each line keeps its OWN kind — recording them all as "tyre" makes the tube uncountable');
});

test('the reason is given once for the job, not argued for each tube', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'puncture',
    lines: [{ spec_id: TYRE, qty: 1 }, { spec_id: TUBE, qty: 1 }],
  });
  const b = await json(r);
  assert.strictEqual(r.status, 201, JSON.stringify(b));
  const reasons = all(`SELECT r.reason FROM tb_request_lines r JOIN mrn_lines l ON l.id = r.mrn_line_id
                        WHERE l.mrn_id = ?`, b.id).map((x) => x.reason);
  assert.deepStrictEqual(reasons, ['puncture', 'puncture']);
});

test('a battery request will not carry a tube', async () => {
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'battery', asset_id: ASSET, reason: 'no_crank',
    lines: [{ spec_id: BATT, qty: 1 }, { spec_id: TUBE, qty: 1 }],
  });
  assert.strictEqual(r.status, 400);
  assert.match((await json(r)).error, /tube does not belong on a battery request/i);
});

test('each line on a multi-item request is approved and issued on its own', async () => {
  const made = await json(await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn',
    lines: [{ spec_id: TYRE, qty: 1, position: 'FL' }, { spec_id: TUBE, qty: 1 }],
  }));
  await as('fitter', 'POST', `/api/stores/mrn/${made.id}/certify`, { signed_name: 'fitter' });
  await as('opsman', 'POST', `/api/stores/mrn/${made.id}/approve`, { signed_name: 'opsman' });
  const detail = await json(await as('keeper', 'GET', '/api/tb/requests/' + made.id));
  assert.strictEqual(detail.lines.length, 2);
  // Issue only the tyre; the tube stays outstanding on the same approved request.
  const tyreLine = detail.lines.find((l) => l.kind === 'tyre');
  const r = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: tyreLine.mrn_line_id, qty: 1 });
  assert.strictEqual(r.status, 201, JSON.stringify(await json(r)));
  const after = await json(await as('keeper', 'GET', '/api/tb/requests/' + made.id));
  assert.strictEqual(after.lines.find((l) => l.kind === 'tyre').issued, 1);
  assert.strictEqual(after.lines.find((l) => l.kind === 'tube').issued, 0,
    'one approval, but each item leaves the store when the store actually has it');
});

// ---- who may do what ------------------------------------------------------
//
// Tyres and batteries are held in MAIN STORES, and asking for one, taking it in from the supplier
// and handing it out are three different jobs done by three different people. One permission
// column cannot say that, so the board carries three: tb_request, tb_grn, tb_issue. They gate the
// ACTIONS rather than the router — the size picklist stays open to anyone signed in, because a
// gated dropdown is an empty dropdown.

const perms = require('../src/lib/permissions');
const setLevel = (role, mod, lvl) => run(
  `INSERT INTO role_permissions (role, module, level) VALUES (?, ?, ?)
   ON CONFLICT(role, module) DO UPDATE SET level = excluded.level`, role, mod, lvl);

test('the three columns are on the board', () => {
  const keys = perms.MODULES.map((m) => m.key);
  for (const k of ['tb_request', 'tb_grn', 'tb_issue']) assert.ok(keys.includes(k), k + ' is missing from the board');
});

test('the seeded policy is the one the owner asked for', () => {
  perms.seedDefaults();
  assert.strictEqual(perms.levelForRoles(['workshop'], 'tb_request'), 'edit', 'the workshop raises requests');
  assert.strictEqual(perms.levelForRoles(['workshop'], 'tb_issue'), 'none', 'but does not hand stock out');
  assert.strictEqual(perms.levelForRoles(['storekeeper'], 'tb_grn'), 'edit', 'the Main Store takes goods in');
  assert.strictEqual(perms.levelForRoles(['storekeeper'], 'tb_issue'), 'edit', 'and hands them out');
  assert.strictEqual(perms.levelForRoles(['manager'], 'tb_issue'), 'view', 'managers watch, they do not move stock');
});

test('the picklist stays open even to a role with nothing granted', async () => {
  setLevel('workshop', 'tb_request', 'none');
  const r = await as('fitter', 'GET', '/api/tb/specs?kind=tyre');
  assert.strictEqual(r.status, 200, 'gating reference data is how a form comes up with an empty dropdown');
  setLevel('workshop', 'tb_request', 'edit');
});

test('a role without Request cannot raise one', async () => {
  setLevel('workshop', 'tb_request', 'view');
  const r = await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn', lines: [{ spec_id: TYRE, qty: 1 }],
  });
  assert.strictEqual(r.status, 403);
  assert.match((await json(r)).error, /tb_request/);
  setLevel('workshop', 'tb_request', 'edit');
});

test('a role without Issue cannot issue, even on an approved request', async () => {
  const made = await json(await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn', lines: [{ spec_id: TYRE, qty: 1 }],
  }));
  await as('fitter', 'POST', `/api/stores/mrn/${made.id}/certify`, { signed_name: 'fitter' });
  await as('opsman', 'POST', `/api/stores/mrn/${made.id}/approve`, { signed_name: 'opsman' });
  const detail = await json(await as('keeper', 'GET', '/api/tb/requests/' + made.id));
  const lineId = detail.lines[0].mrn_line_id;

  setLevel('storekeeper', 'tb_issue', 'view');
  const denied = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 1 });
  assert.strictEqual(denied.status, 403, 'approval is not the same thing as being allowed to hand it over');
  assert.strictEqual(get('SELECT COUNT(*) c FROM tyre_battery_issues WHERE mrn_line_id = ?', lineId).c, 0);

  setLevel('storekeeper', 'tb_issue', 'edit');
  const ok = await as('keeper', 'POST', '/api/tb/issue', { mrn_line_id: lineId, qty: 1 });
  assert.strictEqual(ok.status, 201, 'and granting it live lets the same request through');
});

test('receiving a tyre needs its own permission, not just Stores', async () => {
  const made = await json(await as('fitter', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn', lines: [{ spec_id: TYRE, qty: 4 }],
  }));
  const detail = await json(await as('keeper', 'GET', '/api/tb/requests/' + made.id));
  const lineId = detail.lines[0].mrn_line_id;

  setLevel('storekeeper', 'tb_grn', 'view');
  const denied = await as('keeper', 'POST', '/api/stores/grn', { mrn_id: made.id, mrn_line_id: lineId, qty: 4 });
  assert.strictEqual(denied.status, 403);
  assert.match((await json(denied)).error, /tyres or batteries/i);

  setLevel('storekeeper', 'tb_grn', 'edit');
  const ok = await as('keeper', 'POST', '/api/stores/grn', { mrn_id: made.id, mrn_line_id: lineId, qty: 4 });
  assert.strictEqual(ok.status, 201, JSON.stringify(await json(ok)));
});

test('tightening the tyre cell never blocks an ordinary part', async () => {
  // The guard asks the LINE's own category, so a bolt is still governed by `stores` alone.
  const m = run(`INSERT INTO mrn (mrn_no, req_date, status) VALUES ('TBPERM-1', '2026-08-22', 'open')`).lastInsertRowid;
  const l = run(`INSERT INTO mrn_lines (mrn_id, description, qty, category) VALUES (?, 'Wheel Stud', 10, 'Fasteners')`, m).lastInsertRowid;
  setLevel('storekeeper', 'tb_grn', 'none');
  const r = await as('keeper', 'POST', '/api/stores/grn', { mrn_id: m, mrn_line_id: l, qty: 10 });
  assert.strictEqual(r.status, 201, 'a tightened tyre cell must not stop the store receiving a bolt');
  setLevel('storekeeper', 'tb_grn', 'edit');
});

test('a receipt with no request line behind it is not blocked by the tyre cell', async () => {
  setLevel('storekeeper', 'tb_grn', 'none');
  const r = await as('keeper', 'POST', '/api/stores/grn', { description: 'loose delivery', qty: 1 });
  assert.strictEqual(r.status, 201);
  setLevel('storekeeper', 'tb_grn', 'edit');
});

test('admin is never locked out of any of it', async () => {
  for (const m of ['tb_request', 'tb_grn', 'tb_issue']) assert.strictEqual(perms.levelForRoles(['admin'], m), 'full');
  const r = await as('boss', 'POST', '/api/tb/requests', {
    kind: 'tyre', asset_id: ASSET, reason: 'worn', lines: [{ spec_id: TYRE, qty: 1 }],
  });
  assert.strictEqual(r.status, 201);
});
