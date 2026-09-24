'use strict';

// The Daily Work sheet's Time(Hrs) column is the crew's TOTAL man-hours (owner-confirmed
// 2026-08-12): "Govinda, Vinod — 12" means the pair put in 12 hours between them, 6 each.
//
// job_daily_work.hours must therefore hold the PER-PERSON duration, because the costing engine
// charges that figure to every mechanic on the row (the confirmed crew rule). Where the raw
// man-hour total was stored instead, each mechanic is charged the whole crew's hours and the
// job's labour comes out multiplied by the crew size.
//
//   node scripts/fix_crew_manhours.js          (dry run, default)
//   node scripts/fix_crew_manhours.js --apply
//
// A row is corrected only on evidence, never on a guess:
//   (a) its stored hours equal the owner's file value exactly and it has 2+ mechanics, or
//   (b) it is absent from the file, has 2+ mechanics, and falls in a month whose crew rows
//       average about (crew x the single-mechanic norm) — i.e. Dec-2025..Apr-2026 and Aug-2026.
// Rows already divided (May–July, plus any that match file/crew) are left untouched.

const path = require('path');
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');

const FILE = path.join(__dirname, '..', 'backups', 'Site_SK_Admin_Excel_Backups', 'Daily_Work_Done updated.xlsx');
const APPLY = process.argv.includes('--apply');
// Months whose rows were loaded before the per-person conversion existed.
const MANHOUR_MONTHS = new Set(['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-08']);

const crewOf = (m) => String(m || '').split(/[,&]| and /i).map((s) => s.trim()).filter(Boolean).length;
const nd = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nv = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];
  const T = (v) => (v && v.text ? v.text : v);
  const d10 = (v) => {
    if (!v) return '';
    if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const s = String(v).trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const i = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return i ? i[1] : s;
  };

  const fileRows = new Map();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.values.map(T);
    const date = d10(v[1]); const veh = String(v[2] || '').trim();
    if (!date || !veh) return;
    const k = [date, nv(veh), nd(v[3]).slice(0, 45), nd(v[4]).slice(0, 32)].join('|');
    if (!fileRows.has(k)) fileRows.set(k, []);
    fileRows.get(k).push(Number(v[5]) || 0);
  });

  const live = all(`SELECT w.id, w.work_date, w.mechanic, w.hours, w.description, w.job_id,
                           COALESCE(a.registration,'') reg, COALESCE(a.code,'') code, COALESCE(a.ec_code,'') ec
                      FROM job_daily_work w
                      JOIN job_cards j ON j.id = w.job_id
                      LEFT JOIN assets a ON a.id = j.asset_id
                     WHERE w.hours > 0`);

  const fix = [];
  const leave = { single: 0, alreadyDivided: 0, otherMonth: 0 };
  for (const r of live) {
    const crew = crewOf(r.mechanic);
    if (crew < 2) { leave.single++; continue; }

    let fileHours = null;
    for (const vk of [...new Set([nv(r.reg), nv(r.code), nv(r.ec)].filter(Boolean))]) {
      const q = fileRows.get([r.work_date, vk, nd(r.description).slice(0, 45), nd(r.mechanic).slice(0, 32)].join('|'));
      if (q && q.length) { fileHours = q[0]; break; }
    }
    const month = r.work_date.slice(0, 7);

    if (fileHours != null && Math.abs(r.hours - fileHours) < 0.001) {
      fix.push({ ...r, crew, why: 'matches the sheet total', from: r.hours, to: r2(r.hours / crew) });
    } else if (fileHours == null && MANHOUR_MONTHS.has(month)) {
      fix.push({ ...r, crew, why: 'not in the sheet; loaded in a man-hour month', from: r.hours, to: r2(r.hours / crew) });
    } else if (fileHours != null) leave.alreadyDivided++;
    else leave.otherMonth++;
  }

  const manHoursBefore = live.reduce((s, r) => s + r.hours * crewOf(r.mechanic), 0);
  const manHoursAfter = manHoursBefore - fix.reduce((s, f) => s + (f.from - f.to) * f.crew, 0);

  console.log(`daily-work rows with hours : ${live.length}`);
  console.log(`  left alone — 1 mechanic  : ${leave.single}`);
  console.log(`  left alone — already per-person : ${leave.alreadyDivided + leave.otherMonth}`);
  console.log(`  TO CORRECT               : ${fix.length}`);
  const byWhy = {};
  fix.forEach((f) => { byWhy[f.why] = (byWhy[f.why] || 0) + 1; });
  console.log('    reason                 :', JSON.stringify(byWhy));
  const byMonth = {};
  fix.forEach((f) => { const m = f.work_date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  console.log('    by month               :', JSON.stringify(byMonth));
  console.log();
  console.log(`  man-hours charged now    : ${Math.round(manHoursBefore).toLocaleString()}`);
  console.log(`  man-hours after the fix  : ${Math.round(manHoursAfter).toLocaleString()}`);
  console.log(`  removed (was counted ${(manHoursBefore / manHoursAfter).toFixed(2)}x) : ${Math.round(manHoursBefore - manHoursAfter).toLocaleString()}`);
  console.log();
  console.log('  sample:');
  fix.slice(0, 8).forEach((f) => console.log(`    ${f.work_date}  ${String(f.mechanic).slice(0, 26).padEnd(27)} ${f.from} -> ${f.to}  (crew ${f.crew})`));

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

  const jobs = new Set();
  tx(() => {
    for (const f of fix) { run('UPDATE job_daily_work SET hours = ? WHERE id = ?', f.to, f.id); jobs.add(f.job_id); }
  });
  // Rebuild the costed labour lines for every month touched, then the job totals.
  const mechanics = require('../src/lib/mechanics');
  const costing = require('../src/lib/costing');
  for (const m of new Set(fix.map((f) => f.work_date.slice(0, 7)))) mechanics.syncJobLabourForMonth(m);
  for (const j of jobs) { try { costing.refreshJobTotals(j); } catch (e) { /* non-fatal */ } }

  console.log(`\nApplied to ${fix.length} rows across ${jobs.size} job cards.`);
  console.log('  labour now: Rs', get("SELECT ROUND(SUM(amount),2) v FROM job_labour").v.toLocaleString());
})();
