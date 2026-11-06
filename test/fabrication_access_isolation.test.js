'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-fab-iso-'));
process.env.DB_PATH = path.join(TMP, 'test_fab_iso.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
process.env.MULTIDB = '0';

const { migrate, run, get, all } = require('../src/db');
const permissions = require('../src/lib/permissions');
const capabilities = require('../src/lib/capabilities');
const sod = require('../src/lib/sod');
const scope = require('../src/lib/scope');
const aliases = require('../src/lib/aliases');

migrate();
permissions.seedDefaults();
capabilities.seedCapabilities();

test('1. Section 23 fabrication and part fabrication_costing exist in canonical permissions', () => {
  const fabSection = permissions.SECTIONS.find((s) => s.key === 'fabrication');
  assert.ok(fabSection, 'Section fabrication exists');
  assert.strictEqual(fabSection.id, 23, 'Section id is 23');
  assert.strictEqual(fabSection.label, 'Fabrication & General Works');
  assert.ok(fabSection.parts.some((p) => p.key === 'fabrication_costing'), 'Has part fabrication_costing');

  const partModule = permissions.MODULES.find((p) => p.key === 'fabrication_costing');
  assert.ok(partModule, 'Part module fabrication_costing registered');
  assert.strictEqual(partModule.parent, 'fabrication');
});

test('2. Role fabrication_officer and default matrix clearances match design', () => {
  const m = permissions.DEFAULT_MATRIX.fabrication_officer;
  assert.ok(m, 'fabrication_officer template exists in DEFAULT_MATRIX');
  assert.strictEqual(m.fabrication, 'full');
  assert.strictEqual(m.fabrication_costing, 'full');
  assert.strictEqual(m.jobs, 'view');
  assert.strictEqual(m.stores, 'view');

  // Operations Manager and Manager have full
  assert.strictEqual(permissions.DEFAULT_MATRIX.operational_manager.fabrication, 'full');
  assert.strictEqual(permissions.DEFAULT_MATRIX.manager.fabrication, 'full');

  // Non-fabrication roles have none
  assert.strictEqual(permissions.DEFAULT_MATRIX.workshop.fabrication, 'none');
  assert.strictEqual(permissions.DEFAULT_MATRIX.storekeeper.fabrication, 'none');
  assert.strictEqual(permissions.DEFAULT_MATRIX.site_storekeeper.fabrication, 'none');
  assert.strictEqual(permissions.DEFAULT_MATRIX.viewer.fabrication, 'none');
  assert.strictEqual(permissions.DEFAULT_MATRIX.transport_manager.fabrication, 'none');
});

test('3. Fabrication capabilities and dual-authorization flags are properly registered', () => {
  const allCaps = new Set(capabilities.CAP_KEYS);
  const requiredCaps = [
    'fabrication.view',
    'jobrequests.create_fabrication',
    'fabrication.open_card',
    'fabrication.edit',
    'fabrication.dailywork',
    'fabrication.parts',
    'fabrication.drawings',
    'fabrication.cost.view',
    'fabrication.cost.edit',
    'fabrication.cost.approve',
    'fabrication.close',
    'fabrication.issue_target',
    'fabrication.export',
    'fabrication.settings',
    'fabrication.assign_access'
  ];

  for (const cap of requiredCaps) {
    assert.ok(allCaps.has(cap), `Capability ${cap} must be registered`);
  }

  // Dual auth flag on cost approval
  const approveCap = capabilities.get('fabrication.cost.approve');
  assert.ok(approveCap, 'fabrication.cost.approve exists');
  assert.strictEqual(approveCap.dualAuth, true, 'fabrication.cost.approve requires dual-authorization');

  // Officer capabilities
  const officerCaps = new Set(capabilities.capsForRole('fabrication_officer'));
  assert.ok(officerCaps.has('fabrication.view'));
  assert.ok(officerCaps.has('fabrication.open_card'));
  assert.ok(officerCaps.has('fabrication.edit'));
  assert.ok(officerCaps.has('fabrication.cost.edit'));
  assert.ok(officerCaps.has('fabrication.cost.view'));
  assert.ok(officerCaps.has('jobrequests.create_fabrication'));
  assert.ok(!officerCaps.has('fabrication.cost.approve'), 'Officer cannot approve own costing sheets');

  // Storekeeper has fabrication.issue_target but NOT fabrication.view or cost viewing
  const storekeeperCaps = new Set(capabilities.capsForRole('storekeeper'));
  assert.ok(storekeeperCaps.has('fabrication.issue_target'), 'Storekeeper can pick fabrication as issue target');
  assert.ok(!storekeeperCaps.has('fabrication.view'), 'Storekeeper cannot view fabrication jobs');
  assert.ok(!storekeeperCaps.has('fabrication.cost.view'), 'Storekeeper cannot view fabrication costs');
});

test('4. SoD Rule SOD-FAB-01 detects and blocks combining cost editing and cost approval', () => {
  const conflicts1 = sod.findSodConflicts(['fabrication.cost.edit', 'fabrication.cost.approve']);
  assert.strictEqual(conflicts1.length, 1);
  assert.strictEqual(conflicts1[0].rule.code, 'SOD-FAB-01');
  assert.strictEqual(conflicts1[0].rule.severity, 'CRITICAL');

  const conflicts2 = sod.findSodConflicts(['fabrication.cost.edit', 'fabrication.view']);
  assert.strictEqual(conflicts2.length, 0, 'No conflict for edit and view');
});

test('5. Row-level security: fabricationFilter hides fabrication records from unauthorized roles', () => {
  const officer = { id: 10, username: 'officer', roles: ['fabrication_officer'] };
  const admin = { id: 1, username: 'admin', roles: ['admin'] };
  const workshopUser = { id: 20, username: 'mechanic', roles: ['workshop'] };
  const storekeeperUser = { id: 30, username: 'storekeeper', roles: ['storekeeper'] };
  const viewerUser = { id: 40, username: 'viewer', roles: ['viewer'] };

  // Admin and officer see everything
  assert.strictEqual(scope.fabricationFilter(admin, 'j'), '');
  assert.strictEqual(scope.fabricationFilter(officer, 'j'), '');
  assert.strictEqual(scope.fabricationClause(admin, 'j'), null);
  assert.strictEqual(scope.fabricationClause(officer, 'j'), null);

  // Workshop, storekeeper, viewer are filtered
  const expectedFilter = " AND (j.type <> 'fabrication' OR j.type IS NULL)";
  assert.strictEqual(scope.fabricationFilter(workshopUser, 'j'), expectedFilter);
  assert.strictEqual(scope.fabricationFilter(storekeeperUser, 'j'), expectedFilter);
  assert.strictEqual(scope.fabricationFilter(viewerUser, 'j'), expectedFilter);

  const expectedClause = "(j.type <> 'fabrication' OR j.type IS NULL)";
  assert.strictEqual(scope.fabricationClause(workshopUser, 'j'), expectedClause);
  assert.strictEqual(scope.fabricationClause(storekeeperUser, 'j'), expectedClause);
  assert.strictEqual(scope.fabricationClause(viewerUser, 'j'), expectedClause);
});

test('6. Direct access returns 404 for unauthorized users on fabrication cards and requests', () => {
  // Create a fabrication job card and request
  run(`INSERT OR IGNORE INTO job_requests (id, jr_no, req_date, type, description, approval_status, requested_by, work_target, category, cost_centre)
       VALUES (9001, 'JR-FAB-001', '2026-11-06', 'fabrication', 'Test Fab Request', 'approved', 'Officer', 'general', 'beds', 'Camp')`);
  run(`INSERT OR IGNORE INTO job_cards (id, job_no, type, description, status, requested_at, job_request_id, work_target, category, cost_centre)
       VALUES (8001, '2026/11/F/001', 'fabrication', 'Test Fab Card', 'APPROVED_OPERATIONS', '2026-11-06', 9001, 'general', 'beds', 'Camp')`);

  const officer = { id: 10, username: 'officer', roles: ['fabrication_officer'] };
  const workshopUser = { id: 20, username: 'mechanic', roles: ['workshop'] };
  const storekeeperUser = { id: 30, username: 'storekeeper', roles: ['storekeeper'] };

  // fabricationRequestRefusal
  assert.strictEqual(scope.fabricationRequestRefusal(officer, 9001), null, 'Officer can reach request');
  const reqRefusal = scope.fabricationRequestRefusal(workshopUser, 9001);
  assert.ok(reqRefusal, 'Workshop mechanic refused request');
  assert.strictEqual(reqRefusal.status, 404, 'Returns 404');

  // fabricationJobRefusal
  assert.strictEqual(scope.fabricationJobRefusal(officer, 8001), null, 'Officer can reach card');
  const jobRefusal = scope.fabricationJobRefusal(workshopUser, 8001);
  assert.ok(jobRefusal, 'Workshop mechanic refused card');
  assert.strictEqual(jobRefusal.status, 404, 'Returns 404');

  // Storekeeper reading card details (jobReadRefusal) receives 404
  const skReadRefusal = scope.jobReadRefusal(storekeeperUser, 8001);
  assert.ok(skReadRefusal, 'Storekeeper cannot read job card details');
  assert.strictEqual(skReadRefusal.status, 404);

  // Storekeeper using card for issue (jobRefusal) is allowed because of fabrication.issue_target
  assert.strictEqual(scope.jobRefusal(storekeeperUser, 8001), null, 'Storekeeper can target for issue');
});

test('7. General Works are excluded from missing vehicle audit in aliases', () => {
  // Insert a vehicle job missing asset_id (should be flagged)
  run(`INSERT OR IGNORE INTO job_cards (id, job_no, type, description, status, requested_at, work_target)
       VALUES (8002, '2026/11/R/999', 'repair', 'Unallocated repair job', 'IN_WORKSHOP', '2026-11-06', 'vehicle')`);

  const missing = aliases.getMissingAllocations();
  const fabInMissing = missing.missingJobs.some((j) => j.id === 8001);
  assert.strictEqual(fabInMissing, false, 'General works fabrication card 8001 must NOT appear in missing vehicle allocations');

  const repairInMissing = missing.missingJobs.some((j) => j.id === 8002);
  assert.strictEqual(repairInMissing, true, 'Vehicle repair card 8002 must appear in missing vehicle allocations');
});
