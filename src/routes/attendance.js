'use strict';

// Mechanic attendance and the daily tally (src/lib/attendance.js; docs/WORKSHOPONE_PLAN.md §A.1).
//
//   GET  /settings            the rules (flag, start date, shift, break, tolerance)
//   PUT  /settings            change them                               attendance.settings
//   GET  /day?date=           the grid and tally for one day
//   POST /day                 save attendance rows for a day            attendance.record (today, yesterday)
//                                                                       attendance.unlock (any past day)
//   POST /day/book-rest       book a mechanic's unbooked hours to the General Workshop card
//                                                                       dailywork.add
//   POST /day/signoff         sign a day off (locks it)                 attendance.signoff
//   POST /day/unlock          unlock a signed-off day, with a reason    attendance.unlock
//   GET  /month?month=        attended, booked and utilisation per mechanic
//   GET  /hours-left?date=&names=&exclude_line=   for the daily-work entry forms
//
// Stage 4: with the workshops kept apart (src/lib/scope.js) every one of these is about ONE
// workshop's day: your own, or — for head office — the one asked for with workshop_id.
//
// Reading follows the Daily Work section clearance (view). Writes are decided by capability, not
// by the section's EDIT level: a manager holds Daily Work at view and still signs off and unlocks.

const express = require('express');
const { get, run } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const permissions = require('../lib/permissions');
const capabilities = require('../lib/capabilities');
const audit = require('../lib/audit');
const attendance = require('../lib/attendance');
const costing = require('../lib/costing');
const mechanics = require('../lib/mechanics');
const jobstate = require('../lib/jobstate');

const router = express.Router();

const dailyWorkLevel = (user) => permissions.levelForRoles(user.roles || [], 'dailywork');
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (permissions.meets(dailyWorkLevel(req.user), 'view')) return next();
  return res.status(403).json({ error: 'Your role has no view access to dailywork' });
});

const capsOf = (user) => (Array.isArray(user.caps) ? user.caps : capabilities.capsForRoles(user.roles || []));
const fail = (res, status, error) => res.status(status).json({ error });
const needOn = (res) => (attendance.isEnabled() ? false : (fail(res, 409, 'Attendance is switched off'), true));

// Whose day it is (Stage 4). Workshops not kept apart: the whole company's (null). Kept apart:
// your own workshop's; head office picks one with workshop_id, else their home workshop's.
function wsFor(req) {
  const scope = require('../lib/scope');
  if (!scope.enabled()) return null;
  const own = scope.onlyWorkshop(req.user, { store: false });
  if (own) return own;
  const ws = require('../lib/workshops');
  const asked = toInt((req.query || {}).workshop_id) || toInt((req.body || {}).workshop_id);
  return asked && ws.byId(asked) ? asked : ws.homeOf(req.user);
}

// ---- settings ------------------------------------------------------------------------------------
router.get('/settings', asyncHandler((_req, res) => res.json(attendance.settings())));

router.put('/settings', requireCap('attendance.settings'), asyncHandler((req, res) => {
  const before = attendance.settings();
  const after = attendance.saveSettings(req.body || {});
  audit.record({ userId: req.user.id, entity: 'settings', action: 'attendance_settings', before, after });
  res.json(after);
}));

// ---- one day -------------------------------------------------------------------------------------
// The day, and what THIS person may do on it (the screen shows only the buttons that will work).
function dayFor(req, date, opts) {
  const d = attendance.day(date, { ...opts, ws: wsFor(req) });
  const caps = capsOf(req.user);
  const rule = attendance.editRule(date, caps);
  d.can = {
    edit: d.enabled && !d.locked && rule.ok,
    edit_reason: !d.enabled ? 'Attendance is switched off' : d.locked ? 'The day is signed off' : (rule.ok ? null : rule.error),
    signoff: d.enabled && caps.includes('attendance.signoff'),
    unlock: d.enabled && caps.includes('attendance.unlock'),
    book_rest: d.enabled && !d.locked && caps.includes('dailywork.add') && permissions.meets(dailyWorkLevel(req.user), 'edit'),
    settings: caps.includes('attendance.settings'),
  };
  return d;
}

router.get('/day', asyncHandler((req, res) => {
  const date = String(req.query.date || attendance.today()).slice(0, 10);
  if (!attendance.isDate(date)) return fail(res, 400, 'A valid ?date=YYYY-MM-DD is required');
  res.json(dayFor(req, date, { queue: true }));
}));

router.post('/day', requireCap('attendance.record', 'attendance.unlock'), asyncHandler((req, res) => {
  if (needOn(res)) return;
  const b = req.body || {};
  const date = String(b.date || '').slice(0, 10);
  const rule = attendance.editRule(date, capsOf(req.user));
  if (!rule.ok) return fail(res, rule.status, rule.error);
  const ws = wsFor(req);
  const lock = attendance.checkDaysOpen([date], ws);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  // One workshop's day: only its own mechanics (where each belonged on that date).
  if (ws && Array.isArray(b.rows)) {
    const workshops = require('../lib/workshops');
    for (const r of b.rows) {
      const at = workshops.mechanicWorkshop(toInt(r && r.mechanic_id), date);
      if (at && at !== ws) {
        const m = get('SELECT name FROM mechanics WHERE id = ?', toInt(r.mechanic_id));
        return fail(res, 403, `${m ? m.name : 'That mechanic'} belongs to ${workshops.byId(at).name} on ${date}.`);
      }
    }
  }

  const changes = attendance.saveRows(date, b.rows, req.user.id);
  for (const c of changes) {
    audit.record({ userId: req.user.id, entity: 'mechanic_attendance', entityId: c.id, action: c.action,
      before: c.before, after: c.after ? { ...c.after, work_date: date, mechanic: c.name } : { work_date: date, mechanic: c.name } });
  }
  res.json({ saved: changes.length, day: dayFor(req, date) });
}));

// "Unbooked" — at work, but not every hour is on a job. One click books the rest to the General
// Workshop card, as ordinary daily work: it is costed like any other line (hours × rate).
router.post('/day/book-rest', requireCap('dailywork.add'), asyncHandler((req, res) => {
  if (needOn(res)) return;
  if (!permissions.meets(dailyWorkLevel(req.user), 'edit')) return fail(res, 403, 'Your role has no edit access to dailywork');
  const date = String((req.body || {}).date || '').slice(0, 10);
  const mechanicId = toInt((req.body || {}).mechanic_id);
  if (!attendance.isDate(date)) return fail(res, 400, 'A valid date (YYYY-MM-DD) is required');
  const ws = wsFor(req);
  const lock = attendance.checkDaysOpen([date], ws);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  const row = attendance.day(date, { ws }).rows.find((r) => r.mechanic_id === mechanicId);
  if (!row) return fail(res, 404, ws ? 'That mechanic is not in this workshop\'s day' : 'Mechanic not found');
  if (row.tally !== 'unbooked' || !(row.diff_hours > 0)) return fail(res, 409, `${row.name} has no unbooked hours on ${date}`);

  // The general card of the mechanic's own workshop on that day (one per workshop, Stage 3).
  const gid = require('./dailywork').generalWorkshopJob(require('../lib/workshops').mechanicWorkshop(mechanicId, date));
  const job = get('SELECT id, job_no, status FROM job_cards WHERE id = ?', gid);
  const g = jobstate.checkAdd(job, 'daily_work', { user: req.user, dates: [date] });
  if (!g.ok) return res.status(g.status).json(g.body);
  const description = String((req.body || {}).description || '').trim() || 'Unbooked time (from attendance)';
  const info = run(
    `INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, asset_id)
     VALUES (?, ?, ?, ?, ?, 0, 0, NULL)`, gid, date, row.name, description, row.diff_hours);
  costing.refreshJobTotals(gid);
  mechanics.syncJobLabourForMonth(date.slice(0, 7));
  audit.record({ userId: req.user.id, entity: 'job_daily_work', entityId: info.lastInsertRowid, action: 'create',
    after: { job_no: job.job_no, date, mechanic: row.name, hours: row.diff_hours, from: 'attendance_book_rest' } });
  res.status(201).json({ id: info.lastInsertRowid, job_no: job.job_no, hours: row.diff_hours, day: dayFor(req, date) });
}));

router.post('/day/signoff', requireCap('attendance.signoff'), asyncHandler((req, res) => {
  const date = String((req.body || {}).date || '').slice(0, 10);
  const ws = wsFor(req);
  attendance.signOff(date, req.user.id, ws);
  const so = attendance.signoffFor(date, ws);
  audit.record({ userId: req.user.id, entity: 'workday_signoff', entityId: so && so.id, action: 'signoff', after: { work_date: date, workshop_id: ws } });
  res.json(dayFor(req, date));
}));

router.post('/day/unlock', requireCap('attendance.unlock'), asyncHandler((req, res) => {
  const date = String((req.body || {}).date || '').slice(0, 10);
  const reason = String((req.body || {}).reason || '').trim();
  const ws = wsFor(req);
  const before = attendance.signoffFor(date, ws);
  attendance.unlock(date, req.user.id, reason, ws);
  audit.record({ userId: req.user.id, entity: 'workday_signoff', entityId: before && before.id, action: 'unlock',
    before: { work_date: date, signed_at: before && before.signed_at }, after: { work_date: date, workshop_id: ws }, reason });
  res.json(dayFor(req, date));
}));

// ---- a month, and hours left ---------------------------------------------------------------------
router.get('/month', asyncHandler((req, res) => {
  const ym = String(req.query.month || attendance.today().slice(0, 7)).slice(0, 7);
  res.json(attendance.month(ym, { ws: wsFor(req) }));
}));

// The month as a spreadsheet: attended, booked and utilisation per mechanic, and each day's red
// count and sign-off.
router.get('/month.xlsx', asyncHandler(async (req, res) => {
  const ym = String(req.query.month || attendance.today().slice(0, 7)).slice(0, 7);
  const m = attendance.month(ym, { ws: wsFor(req) });
  const sheets = [
    { name: `Mechanics ${ym}`, columns: [
      { header: 'Mechanic', key: 'name', width: 26 }, { header: 'Days at work', key: 'days_present', width: 13 },
      { header: 'Attended (h)', key: 'attended_hours', width: 13 }, { header: 'Booked on jobs (h)', key: 'booked_hours', width: 17 },
      { header: 'Utilisation %', key: 'utilisation', width: 13 }, { header: 'Red days', key: 'red_days', width: 10 }],
    rows: m.mechanics.map((x) => ({ ...x, utilisation: x.utilisation == null ? '' : x.utilisation })) },
    { name: `Days ${ym}`, columns: [
      { header: 'Date', key: 'date', width: 12 }, { header: 'Red', key: 'red_count', width: 8 },
      { header: 'Unmatched names', key: 'unmatched', width: 16 }, { header: 'Signed off', key: 'signed', width: 11 }],
    rows: m.days.map((d) => ({ ...d, signed: d.signed_off ? 'Yes' : '' })) },
  ];
  return require('../lib/export').sendXlsx(res, `attendance-${ym}.xlsx`, sheets);
}));

router.get('/hours-left', asyncHandler((req, res) => {
  const date = String(req.query.date || '').slice(0, 10);
  const names = String(req.query.names || '').split('|').map((s) => s.trim()).filter(Boolean);
  res.json(attendance.hoursLeft(date, names, { excludeLineId: toInt(req.query.exclude_line), ws: wsFor(req) }));
}));

module.exports = router;
