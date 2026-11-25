'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-gal-bd-'));
process.env.DB_PATH = path.join(TMP, 'gal_bd.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const test = require('node:test');
const assert = require('node:assert');
const dbMod = require('../src/db');
const { migrate, run, get, all } = dbMod;
const auth = require('../src/lib/auth');
const field = require('../src/lib/field');
const jobstate = require('../src/lib/jobstate');
const breakdowns = require('../src/lib/billing/breakdowns');
const { importGalagedaraBreakdowns } = require('../scripts/import_galagedara_breakdowns_sep_oct_2026');

migrate();

run(`INSERT OR IGNORE INTO roles (name, label) VALUES ('admin', 'Admin')`);
const adminId = run(
  `INSERT INTO users (username, password_hash, full_name, active, must_change_password)
   VALUES ('gal_admin', ?, 'Gal Admin', 1, 0)`,
  auth.hashPassword('GalAdmin2026!')
).lastInsertRowid;
run(`INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE name = 'admin'))`, adminId);

run(`INSERT OR IGNORE INTO workshops (id, code, name, place, is_default, active) VALUES (2, 'GWS', 'Galagedara', 'Galagedara', 0, 1)`);
run(`INSERT OR IGNORE INTO projects (id, code, name, active) VALUES (38, 'CEP-03F', 'CEP-03 F (Galagedara)', 1)`);

const VEHICLES = [
  ['HEX-28', null], ['MG-07', 'ZA-4344'], ['SR-12', null], ['LB-25', null], ['HEX-42', null],
  ['SR-13', null], ['SC-14', 'DAH-2491'], ['HEX-37', null], ['LO-4925', null], ['DT-37', 'LM-7949'],
  ['HEX-23', null], ['DT-22', 'LH-5586'], ['HEX-26', null], ['DT-56', 'LO-7181'], ['DT-51', 'LO-5981'],
  ['DT-30', 'LI-3851'], ['DT-15', 'LM-5722'], ['DT-44', 'LO-4824'], ['DT-26', 'LK-4061'], ['DC-08', '59-5421'],
  ['HEX-17', null], ['DT-02', 'LL-0920'], ['MG-18', null], ['41-7225', '41-7225'], ['DT-70', 'LP-1574'],
  ['DB-04', '41-1130'],
];
for (const [code, reg] of VEHICLES) {
  run(
    `INSERT INTO assets (code, code_norm, registration, current_project_id, in_register)
     VALUES (?, ?, ?, 38, 1)`,
    code, code.replace(/[^A-Z0-9]/gi, '').toUpperCase(), reg
  );
}

test.after(() => {
  try { if (dbMod.rawDb && typeof dbMod.rawDb.close === 'function') dbMod.rawDb.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('imports 47 Galagedara Sep & Oct 2026 breakdown job cards idempotently with DOB & approvals', () => {
  const first = importGalagedaraBreakdowns();
  assert.strictEqual(first.totalRows, 47);
  assert.strictEqual(first.created, 47);
  assert.strictEqual(first.skipped, 0);
  assert.strictEqual(first.waived, 3);
  assert.strictEqual(first.workshopId, 2);
  assert.strictEqual(first.projectId, 38);

  // Idempotent second run creates 0 duplicates
  const second = importGalagedaraBreakdowns();
  assert.strictEqual(second.created, 0);
  assert.strictEqual(second.skipped, 47);

  // Check exact DOB downtime hours on sample jobs
  const hex28 = get("SELECT * FROM job_cards WHERE ref = 'GAL-BD-2026-09-#1'");
  assert.strictEqual(hex28.status, 'PARTIALLY_CLOSED');
  assert.strictEqual(hex28.workshop_id, 2);
  assert.strictEqual(hex28.project_id, 38);
  assert.strictEqual(hex28.breakdown, 1);
  assert.strictEqual(hex28.field, 1);
  assert.match(hex28.job_no, /^2026\/9\/R\/\d+$/);
  assert.strictEqual(field.view(hex28).downtime_hours, 27.75);

  const sep7 = get("SELECT * FROM job_cards WHERE ref = 'GAL-BD-2026-09-#7'");
  assert.strictEqual(sep7.reported_at, '2026-09-04 11:00');
  assert.strictEqual(sep7.working_at, '2026-09-04 12:00');
  assert.strictEqual(field.view(sep7).downtime_hours, 1);

  const hex17 = get("SELECT * FROM job_cards WHERE ref = 'GAL-BD-2026-10-#7'");
  assert.match(hex17.job_no, /^2026\/10\/R\/\d+$/);
  assert.strictEqual(field.view(hex17).downtime_hours, 528.85);

  // Approvals attached to every job
  const appCount = get("SELECT COUNT(*) c FROM job_approvals WHERE job_id IN (SELECT id FROM job_cards WHERE ref LIKE 'GAL-BD-%')").c;
  assert.strictEqual(appCount, 47 * 2);

  // No open duplicate cards
  assert.strictEqual(jobstate.duplicateOpenJobs().length, 0);

  // Breakdown Monitoring view for 2026-10 shows 0 open billing blockers and 3 WAIVED struck-through rows
  const octBd = breakdowns.listBreakdowns({ projectId: 38, month: '2026-10' });
  assert.strictEqual(octBd.summary.openCount, 0);
  const waivedOct = octBd.breakdowns.filter((b) => b.status === 'WAIVED');
  assert.strictEqual(waivedOct.length, 3);
});
