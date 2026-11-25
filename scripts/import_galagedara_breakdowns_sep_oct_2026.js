'use strict';

/**
 * Stage 1 Importer: Galagedara (CEP-03F / GWS) September & October 2026 Breakdowns.
 *
 * Creates auto-approved, field-breakdown PARTIALLY_CLOSED repair job cards carrying
 * exact DOB (reported_at -> working_at) timestamps without attaching materials or daily work
 * (left for site entry in future). Marks the 3 struck-through October rows (#15, #16, #17)
 * as WAIVED in fleet_breakdowns so they do not double-deduct on Hire Billing.
 *
 * Idempotent via job_cards.ref ('GAL-BD-2026-09-#1', etc.).
 */

const { get, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');
const jobno = require('../src/lib/jobno');
const audit = require('../src/lib/audit');

// Format: [ym, sheetNo, startStamp, vehRef, endStamp, dhmLabel, totalHoursLabel, description, waiveBilling]
const BREAKDOWN_ROWS = [
  // ---- September 2026 (25 rows) ----
  ['2026-09', 1,  '2026-09-01 09:00', 'HEX-28',   '2026-09-02 12:45', '1d 3h 45m',  '27h 45m',  'Arm welding work (written: "Arame Welding work")', false],
  ['2026-09', 2,  '2026-09-01 11:30', 'MG-07',    '2026-09-01 13:15', '0d 1h 45m',  '1h 45m',   'Fuel repair', false],
  ['2026-09', 3,  '2026-09-01 14:10', 'SR-12',    '2026-09-01 15:40', '0d 1h 30m',  '1h 30m',   'Fuel and vibration motor repair', false],
  ['2026-09', 4,  '2026-09-01 15:30', 'LB-25',    '2026-09-26 15:30', '25d 0h 00m', '600h 00m', 'Engine sump repair', false],
  ['2026-09', 5,  '2026-09-03 09:00', 'HEX-42',   '2026-09-03 10:00', '0d 1h 00m',  '1h 00m',   'Hydraulic hose repair and fuel repair', false],
  ['2026-09', 6,  '2026-09-03 11:00', 'SR-13',    '2026-09-03 13:00', '0d 2h 00m',  '2h 00m',   'Drum mount repair', false],
  ['2026-09', 7,  '2026-09-04 11:00', 'SR-12',    '2026-09-04 12:00', '0d 1h 00m',  '1h 00m',   'Fuel repair (corrected Complete date from 2026-09-03 sheet typo)', false],
  ['2026-09', 8,  '2026-09-04 13:00', 'DAH-2491', '2026-09-04 16:00', '0d 3h 00m',  '3h 00m',   'Spring blade repair', false],
  ['2026-09', 9,  '2026-09-04 17:10', 'HEX-37',   '2026-09-06 09:00', '1d 15h 50m', '39h 50m',  'Bucket main pin repair', false],
  ['2026-09', 10, '2026-09-07 16:55', 'SR-12',    '2026-09-10 16:00', '2d 23h 05m', '71h 05m',  'Radiator tank repair and fuel repair', false],
  ['2026-09', 11, '2026-09-08 12:00', 'LO-4925',  '2026-09-10 11:00', '1d 23h 00m', '47h 00m',  'Shock absorber repair', false],
  ['2026-09', 12, '2026-09-08 13:45', 'LM-7949',  '2026-09-08 15:45', '0d 2h 00m',  '2h 00m',   'Alternator repair', false],
  ['2026-09', 13, '2026-09-10 12:00', 'SR-12',    '2026-09-10 13:00', '0d 1h 00m',  '1h 00m',   'Radiator repair', false],
  ['2026-09', 14, '2026-09-10 14:00', 'DAH-2491', '2026-09-10 16:00', '0d 2h 00m',  '2h 00m',   'Brake and radiator repair', false],
  ['2026-09', 15, '2026-09-10 14:00', 'HEX-23',   '2026-09-10 16:00', '0d 2h 00m',  '2h 00m',   'Hydraulic hose repair', false],
  ['2026-09', 16, '2026-09-12 10:00', 'SR-12',    '2026-09-12 12:00', '0d 2h 00m',  '2h 00m',   'Alternator repair', false],
  ['2026-09', 17, '2026-09-13 09:00', 'LH-5586',  '2026-09-14 10:00', '1d 1h 00m',  '25h 00m',  'Gear ball joint replace', false],
  ['2026-09', 18, '2026-09-13 15:00', 'HEX-26',   '2026-09-14 09:00', '0d 18h 00m', '18h 00m',  'Hydraulic hose repair', false],
  ['2026-09', 20, '2026-09-15 09:00', 'SR-13',    '2026-09-15 11:00', '0d 2h 00m',  '2h 00m',   'Drum mount repair', false],
  ['2026-09', 22, '2026-09-22 09:00', 'LO-7181',  '2026-09-22 12:00', '0d 3h 00m',  '3h 00m',   'Clutch repair', false],
  ['2026-09', 23, '2026-09-22 09:00', 'HEX-26',   '2026-09-26 11:00', '4d 2h 00m',  '98h 00m',  'Idler wheel repair', false],
  ['2026-09', 24, '2026-09-24 08:00', 'LO-5981',  '2026-09-24 10:00', '0d 2h 00m',  '2h 00m',   'Air dryer repair', false],
  ['2026-09', 25, '2026-09-24 09:00', 'MG-07',    '2026-09-24 11:00', '0d 2h 00m',  '2h 00m',   'Grader tilt repair (written: "G aderatil repair")', false],
  ['2026-09', 26, '2026-09-28 18:20', 'LI-3851',  '2026-09-29 10:00', '0d 15h 40m', '15h 40m',  'Starter motor repair', false],
  ['2026-09', 27, '2026-09-28 18:55', 'LM-5722',  '2026-09-30 10:00', '1d 15h 05m', '39h 05m',  'Alternator repair / Gear ball joint repair', false],

  // ---- October 2026 (22 rows) ----
  ['2026-10', 1,  '2026-10-03 10:40', 'LO-4824',  '2026-10-12 14:00', '9d 3h 20m',  '219h 20m', 'Clutch repair / Starter motor repair', false],
  ['2026-10', 2,  '2026-10-04 09:40', 'LK-4061',  '2026-10-12 23:30', '8d 13h 50m', '205h 50m', 'Clutch adjustment / Starter motor repair / Balance bar ball joint repair', false],
  ['2026-10', 3,  '2026-10-04 10:00', 'LI-3851',  '2026-10-04 12:00', '0d 2h 00m',  '2h 00m',   'Ball joint repair / Water pump welding repair', false],
  ['2026-10', 4,  '2026-10-04 10:20', 'SR-13',    '2026-10-05 13:10', '1d 2h 50m',  '26h 50m',  'Roller drum mount repair / Traveling hose repair', false],
  ['2026-10', 5,  '2026-10-05 08:30', '59-5421',  '2026-10-06 10:20', '1d 1h 50m',  '25h 50m',  'Universal joint repair', false],
  ['2026-10', 6,  '2026-10-06 09:40', 'LI-3851',  '2026-10-21 17:20', '15d 7h 40m', '367h 40m', 'Air compressor, radiator, injector pump, injector nozzle, fan belt, alternator repair', false],
  ['2026-10', 7,  '2026-10-07 09:00', 'HEX-17',   '2026-10-29 09:51', '22d 0h 51m', '528h 51m', 'Hydraulic oil change / All hydraulic filter change / Arm jack repair', false],
  ['2026-10', 8,  '2026-10-07 10:00', 'LM-7949',  '2026-10-08 14:00', '1d 4h 00m',  '28h 00m',  'Clutch repair / Gear adjustment', false],
  ['2026-10', 9,  '2026-10-08 10:00', 'LM-5722',  '2026-10-08 12:00', '0d 2h 00m',  '2h 00m',   'Starter motor repair', false],
  ['2026-10', 10, '2026-10-09 16:30', '59-5421',  '2026-10-10 10:00', '0d 17h 30m', '17h 30m',  'Brake adjustment / Top up power oil', false],
  ['2026-10', 11, '2026-10-10 14:20', 'HEX-23',   '2026-10-11 10:00', '0d 19h 40m', '19h 40m',  'Hydraulic hose repair / Top up hydraulic oil', false],
  ['2026-10', 12, '2026-10-10 15:51', 'LL-0920',  '2026-10-14 14:30', '3d 22h 39m', '94h 39m',  'Fuel block / Starter motor repair', false],
  ['2026-10', 13, '2026-10-13 18:00', 'LM-5722',  '2026-10-14 11:30', '0d 17h 30m', '17h 30m',  'Ball joint replace / Brake adjustment', false],
  ['2026-10', 14, '2026-10-14 14:00', 'LO-4824',  '2026-10-22 09:00', '7d 19h 00m', '187h 00m', 'Starter motor repair / Clutch plate / Gearbox re-fitting', false],
  ['2026-10', 15, '2026-10-17 09:00', 'SR-13',    '2026-10-21 08:30', '3d 23h 30m', '95h 30m',  'Hydraulic hose repair (struck through on sheet)', true],
  ['2026-10', 16, '2026-10-17 12:00', 'MG-18',    '2026-10-19 08:50', '1d 20h 50m', '44h 50m',  'Hydraulic hose repair (struck through on sheet)', true],
  ['2026-10', 17, '2026-10-19 09:00', 'LM-5722',  '2026-10-24 17:20', '5d 8h 20m',  '128h 20m', 'Pinion oil seal / Hub oil seal / Brake repair / Door welding (struck through on sheet)', true],
  ['2026-10', 18, '2026-10-21 15:00', '41-7225',  '2026-10-22 14:00', '0d 23h 00m', '23h 00m',  'Hub oil seal re-fitting / Adjustment', false],
  ['2026-10', 19, '2026-10-24 13:20', 'DAH-2491', '2026-10-27 11:20', '2d 22h 00m', '70h 00m',  'Ball joint replace / Power steering cross joint repair', false],
  ['2026-10', 20, '2026-10-31 10:00', '41-7225',  '2026-11-20 10:00', '20d 0h 00m', '480h 00m', 'Clutch repair / Gearbox repair', false],
  ['2026-10', 21, '2026-10-31 10:00', 'LP-1574',  '2026-11-03 15:40', '3d 5h 40m',  '77h 40m',  'Power steering pump repair', false],
  ['2026-10', 22, '2026-10-31 14:00', '41-1130',  '2026-10-31 22:00', '0d 8h 00m',  '8h 00m',   'Alternator repair / Diode plate replace / Regulator plate replace', false],
];

function validateDataset() {
  for (const [ym, sheetNo, startStamp, vehRef, endStamp, dhmLabel, totH] of BREAKDOWN_ROWS) {
    const startMs = Date.parse(startStamp.replace(' ', 'T') + ':00Z');
    const endMs = Date.parse(endStamp.replace(' ', 'T') + ':00Z');
    const m = /^(\d+)h\s*(\d+)m$/.exec(totH);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !m) {
      throw new Error(`Invalid timestamp or duration on ${ym} #${sheetNo} (${vehRef})`);
    }
    const diffMin = Math.round((endMs - startMs) / 60000);
    const expMin = Number(m[1]) * 60 + Number(m[2]);
    if (diffMin !== expMin || diffMin <= 0) {
      throw new Error(`Duration mismatch on ${ym} #${sheetNo} (${vehRef}): ${diffMin}m != ${expMin}m (${dhmLabel})`);
    }
  }
}

function importGalagedaraBreakdowns({ dryRun = false } = {}) {
  validateDataset();

  const ws = get("SELECT id, code, name FROM workshops WHERE code = 'GWS' OR name LIKE '%Galagedara%' ORDER BY id LIMIT 1")
    || get('SELECT id, code, name FROM workshops ORDER BY id LIMIT 1');
  if (!ws) throw new Error('No Galagedara/default workshop found');

  const proj = get("SELECT id, code, name FROM projects WHERE code = 'CEP-03F' ORDER BY id LIMIT 1")
    || get("SELECT id, code, name FROM projects WHERE name LIKE '%Galagedara%' ORDER BY id LIMIT 1");
  if (!proj) throw new Error('Project CEP-03F (Galagedara) not found');

  const admin = get(`
    SELECT u.id, COALESCE(u.full_name, u.username) AS name
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE r.name = 'admin' AND COALESCE(u.active, 1) = 1
     ORDER BY u.id LIMIT 1
  `) || get('SELECT id, COALESCE(full_name, username) AS name FROM users ORDER BY id LIMIT 1');
  const adminId = admin ? admin.id : 1;
  const adminName = admin ? admin.name : 'System Admin';

  // Resolve all 26 distinct vehicles before writing
  const assetCache = new Map();
  for (const row of BREAKDOWN_ROWS) {
    const vehRef = row[3];
    if (assetCache.has(vehRef)) continue;
    const direct = get(
      `SELECT id, code, registration, ec_code FROM assets
        WHERE UPPER(code) = UPPER(?) OR UPPER(registration) = UPPER(?) OR UPPER(ec_code) = UPPER(?)
        ORDER BY in_register DESC, id ASC LIMIT 1`,
      vehRef, vehRef, vehRef
    );
    if (direct) {
      assetCache.set(vehRef, direct);
      continue;
    }
    const r = aliases.resolveAsset(vehRef, { source: 'galagedara_breakdown_sheet' });
    const resolved = r && r.assetId ? get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', r.assetId) : null;
    if (!resolved) {
      throw new Error(`Unresolved vehicle in Galagedara breakdown sheet: ${vehRef}`);
    }
    assetCache.set(vehRef, resolved);
  }

  const created = [];
  const skipped = [];
  const waived = [];

  if (dryRun) {
    for (const [ym, sheetNo, startStamp, vehRef] of BREAKDOWN_ROWS) {
      const refKey = `GAL-BD-${ym}-#${sheetNo}`;
      const existing = get('SELECT id, job_no FROM job_cards WHERE ref = ?', refKey);
      if (existing) skipped.push({ refKey, jobId: existing.id, jobNo: existing.job_no });
      else created.push({ refKey, vehRef, dryRun: true });
    }
    return {
      workshopId: ws.id,
      projectId: proj.id,
      totalRows: BREAKDOWN_ROWS.length,
      created: created.length,
      skipped: skipped.length,
      waived: BREAKDOWN_ROWS.filter((r) => r[8]).length,
      jobs: created,
    };
  }

  tx(() => {
    for (const [ym, sheetNo, startStamp, vehRef, endStamp, dhmLabel, totH, desc, waiveBilling] of BREAKDOWN_ROWS) {
      const refKey = `GAL-BD-${ym}-#${sheetNo}`;
      const existing = get('SELECT id, job_no FROM job_cards WHERE ref = ?', refKey);
      if (existing) {
        skipped.push({ refKey, jobId: existing.id, jobNo: existing.job_no });
        continue;
      }

      const asset = assetCache.get(vehRef);
      const startDay = startStamp.slice(0, 10);
      const endDay = endStamp.slice(0, 10);
      const jobNo = jobno.nextJobNo('repair', new Date(`${startDay}T00:00:00Z`));
      const fullDesc = `${desc}\n[DOB: ${startStamp} -> ${endStamp} | Breakdown: ${dhmLabel} (${totH})]`;

      const jobId = run(
        `INSERT INTO job_cards (
          job_no, ref, asset_id, project_id, site, type, description, status,
          requested_by, requested_by_user, requested_at,
          approved_transport_at, approved_ops_at, started_at, completed_at,
          partial_closed_at, partial_closed_by, partial_note,
          workshop_id, field, breakdown, field_place, field_location,
          reported_at, arrived_at, working_at, work_target
        ) VALUES (
          ?, ?, ?, ?, ?, 'repair', ?, 'PARTIALLY_CLOSED',
          'Galagedara Site Breakdown Sheet', ?, ?,
          ?, ?, ?, ?,
          ?, ?, 'Stage 1 Galagedara site breakdown — materials & daily work pending from site',
          ?, 1, 1, ?, ?,
          ?, ?, ?, 'vehicle'
        )`,
        jobNo, refKey, asset.id, proj.id, proj.name, fullDesc,
        adminId, startDay,
        startStamp, startStamp, startStamp, endDay,
        endDay, adminId,
        ws.id, `p:${proj.id}`, proj.name,
        startStamp, startStamp, endStamp
      ).lastInsertRowid;

      const reasonTxt = `Auto-approved Stage 1 Galagedara site breakdown (${refKey})`;
      run(
        `INSERT INTO job_approvals (job_id, role, approver_id, decision, reason, created_at, signed_name)
         VALUES (?, 'transport_manager', ?, 'approved', ?, ?, ?)`,
        jobId, adminId, reasonTxt, startStamp, adminName
      );
      run(
        `INSERT INTO job_approvals (job_id, role, approver_id, decision, reason, created_at, signed_name)
         VALUES (?, 'operational_manager', ?, 'approved', ?, ?, ?)`,
        jobId, adminId, reasonTxt, startStamp, adminName
      );

      if (waiveBilling) {
        const fbId = `fbd-jc-${jobId}`;
        run(
          `INSERT OR REPLACE INTO fleet_breakdowns (
            id, asset_id, asset_code, project_id, site_name,
            source_type, job_card_id, job_no, job_request_id, jr_no,
            breakdown_start, breakdown_end, orig_start_date, orig_end_date,
            total_days, reason, status, adjusted_by, adjusted_at, adjustment_note,
            reported_by, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            'JOB_CARD', ?, ?, NULL, NULL,
            ?, ?, ?, ?,
            0, ?, 'WAIVED', ?, datetime('now'),
            'Struck through on Galagedara October breakdown sheet — waived by default (editable in Breakdown Monitoring)',
            ?, datetime('now'), datetime('now')
          )`,
          fbId, asset.id, asset.code || vehRef, proj.id, proj.name,
          jobId, jobNo, startDay, endDay, startDay, endDay, desc, adminId, adminId
        );
        waived.push({ refKey, jobId, jobNo, vehRef });
      }

      created.push({ refKey, jobId, jobNo, vehRef, assetId: asset.id, startStamp, endStamp, waiveBilling });
    }

    if (created.length > 0) {
      audit.record({
        userId: adminId,
        entity: 'job_card',
        action: 'galagedara_stage1_breakdown_import',
        after: {
          workshopId: ws.id,
          projectId: proj.id,
          createdCount: created.length,
          waivedCount: waived.length,
        },
        reason: 'Stage 1 import of Galagedara Sep & Oct 2026 breakdown logs with DOB recovery times',
      });
    }
  });

  return {
    workshopId: ws.id,
    projectId: proj.id,
    totalRows: BREAKDOWN_ROWS.length,
    created: created.length,
    skipped: skipped.length,
    waived: waived.length,
    jobs: created,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const res = importGalagedaraBreakdowns({ dryRun });
  console.log(JSON.stringify(res, null, 2));
}

module.exports = {
  BREAKDOWN_ROWS,
  validateDataset,
  importGalagedaraBreakdowns,
};
