'use strict';

// ===========================================================================
// Mechanic attendance and the daily tally (docs/WORKSHOPONE_PLAN.md §3.1, Stage W1).
//
// Every mechanic's in and out time is recorded each day, and the hours they were at work are
// checked against the hours booked on jobs in Daily Work:
//
//   Worked  = (Out − In) − Break. Out earlier than In is an overnight shift. Absent, leave and
//             holiday are 0.
//   Booked  = the hours of every daily-work line that names the mechanic, general-workshop lines
//             included, external lines left out. job_daily_work.hours is ALREADY PER PERSON: a crew
//             line "Govinda, Vinod — 4" is 4 h each, so each named mechanic counts the full 4 h —
//             never divided by the crew, never multiplied. The same rule costing uses.
//
// THIS NEVER CHANGES LABOUR COST. Job labour stays booked hours × rate (costing.computeJobCost).
// Attendance only adds a check and a utilisation figure; nothing here writes to a cost table.
//
// Names are read with the same resolver costing uses (mechanics.splitMechanics / resolveMechanic),
// so the tally and the cost agree on who worked. A name that does not resolve is listed as an
// unmatched name — never quietly dropped.
//
// The tally runs only from the attendance start date: the old imported daily work has duplicated
// rows, and would show as false over-bookings.
// ===========================================================================

const { get, all, run } = require('../db');
const mechanics = require('./mechanics');

// ---- settings ----------------------------------------------------------------------------------
//
// In the key/value `settings` table. attendance_enabled is the feature flag: while it is off,
// Daily Work behaves exactly as it did before attendance existed (no lock, no hints, no columns).
const KEYS = {
  enabled: 'attendance_enabled',
  start_date: 'attendance_start_date',
  shift_start: 'attendance_shift_start',
  shift_end: 'attendance_shift_end',
  break_minutes: 'attendance_break_minutes',
  tolerance_minutes: 'attendance_tolerance_minutes',
};
const DEFAULTS = { enabled: '0', start_date: '', shift_start: '08:00', shift_end: '17:00', break_minutes: '60', tolerance_minutes: '15' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };

function settings() {
  const stored = {};
  for (const r of all(`SELECT key, value FROM settings WHERE key IN (${Object.values(KEYS).map(() => '?').join(',')})`, ...Object.values(KEYS))) {
    stored[r.key] = r.value;
  }
  const val = (k) => (stored[KEYS[k]] != null ? stored[KEYS[k]] : DEFAULTS[k]);
  const int = (k) => { const n = parseInt(val(k), 10); return Number.isFinite(n) ? n : parseInt(DEFAULTS[k], 10); };
  const start = String(val('start_date') || '');
  return {
    enabled: val('enabled') === '1',
    start_date: DATE_RE.test(start) ? start : null,
    shift_start: TIME_RE.test(val('shift_start')) ? val('shift_start') : DEFAULTS.shift_start,
    shift_end: TIME_RE.test(val('shift_end')) ? val('shift_end') : DEFAULTS.shift_end,
    break_minutes: int('break_minutes'),
    tolerance_minutes: int('tolerance_minutes'),
  };
}

const isEnabled = () => settings().enabled;

/** Change some settings. Switching attendance on with no start date starts it today. */
function saveSettings(patch = {}) {
  const put = (k, v) => run(`INSERT INTO settings (key, value) VALUES (?, ?)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value`, KEYS[k], String(v));
  const cur = settings();
  const next = {};
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 1 || patch.enabled === '1' || patch.enabled === 'true';
  if (patch.start_date !== undefined) {
    const d = String(patch.start_date || '').slice(0, 10);
    if (d && !DATE_RE.test(d)) throw bad('Start date must be a date (YYYY-MM-DD)');
    next.start_date = d;
  }
  for (const k of ['shift_start', 'shift_end']) {
    if (patch[k] === undefined) continue;
    const t = normTime(patch[k]);
    if (!t) throw bad('Shift times must be HH:MM, e.g. 08:00');
    next[k] = t;
  }
  if (patch.break_minutes !== undefined) {
    const n = Number(patch.break_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 600) throw bad('Break must be 0 to 600 minutes');
    next.break_minutes = n;
  }
  if (patch.tolerance_minutes !== undefined) {
    const n = Number(patch.tolerance_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 120) throw bad('Tolerance must be 0 to 120 minutes');
    next.tolerance_minutes = n;
  }
  const turningOn = next.enabled === true && !cur.enabled;
  if (turningOn && !(next.start_date || cur.start_date)) next.start_date = today();
  if (next.enabled !== undefined) put('enabled', next.enabled ? '1' : '0');
  for (const k of ['start_date', 'shift_start', 'shift_end', 'break_minutes', 'tolerance_minutes']) {
    if (next[k] !== undefined) put(k, next[k]);
  }
  return settings();
}

// ---- dates and times ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** The server's own calendar day (the workshop's day), not the UTC one. */
function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDate = (s) => DATE_RE.test(String(s || '')) && !Number.isNaN(new Date(s + 'T12:00:00Z').getTime())
  && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;

function toMinutes(t) {
  const m = TIME_RE.exec(String(t == null ? '' : t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** 'H:MM' / 'HH:MM' → 'HH:MM'; blank → null; anything else → undefined (invalid). */
function normTime(t) {
  if (t == null || String(t).trim() === '') return null;
  const m = toMinutes(t);
  if (m == null) return undefined;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- worked ------------------------------------------------------------------------------------

const STATUSES = ['present', 'absent', 'leave', 'half_day', 'holiday'];
// Not at work: they worked 0 hours whatever the times say.
const OFF_STATUSES = ['absent', 'leave', 'holiday'];

/**
 * Minutes at work for one attendance row, or null when it cannot be told yet (no row, or an in or
 * out time still missing). Out earlier than In = an overnight shift.
 */
function workedMinutes(a) {
  if (!a) return null;
  if (OFF_STATUSES.includes(a.status)) return 0;
  const i = toMinutes(a.time_in);
  const o = toMinutes(a.time_out);
  if (i == null || o == null) return null;
  let span = o - i;
  if (span < 0) span += 24 * 60;
  return Math.max(0, span - (Number(a.break_minutes) || 0));
}

// ---- booked ------------------------------------------------------------------------------------

/**
 * Hours booked on jobs, per mechanic, for the days from..to. Every daily-work line that names a
 * mechanic counts its FULL hours for each name on it (hours are per person already). External
 * lines are left out; general-workshop lines count like any other job.
 *
 * @returns {{ byDay: Map<date, {byMech: Map<id, {hours, lines}>, unmatched: Map<norm, {...}>}> }}
 */
function bookedRange(from, to, { excludeLineId = null } = {}) {
  const byDay = new Map();
  const dayOf = (d) => {
    if (!byDay.has(d)) byDay.set(d, { byMech: new Map(), unmatched: new Map() });
    return byDay.get(d);
  };
  const lines = all(
    `SELECT w.id, w.job_id, w.work_date, w.mechanic, w.hours, w.description, j.job_no
       FROM job_daily_work w JOIN job_cards j ON j.id = w.job_id
      WHERE w.work_date BETWEEN ? AND ? AND COALESCE(w.is_external, 0) = 0
      ORDER BY w.work_date, w.id`, from, to);
  const seen = new Map(); // raw name → lookup, so a month does not look up the same spelling 500 times
  const look = (raw) => {
    if (!seen.has(raw)) seen.set(raw, mechanics.resolveMechanic(raw, { register: false }));
    return seen.get(raw);
  };
  for (const w of lines) {
    if (excludeLineId && w.id === excludeLineId) continue;
    const hours = Number(w.hours) || 0;
    const d = dayOf(String(w.work_date).slice(0, 10));
    const line = { id: w.id, job_id: w.job_id, job_no: w.job_no, hours, crew: w.mechanic || '', description: w.description || '' };
    const names = mechanics.splitMechanics(w.mechanic);
    if (!names.length) {
      if (!hours) continue;
      const u = d.unmatched.get('') || { name: '', hours: 0, lines: [] };
      u.hours += hours; u.lines.push(line); d.unmatched.set('', u);
      continue;
    }
    for (const raw of names) {
      const r = look(raw);
      if (r.resolved) {
        const b = d.byMech.get(r.mechanicId) || { hours: 0, lines: [] };
        b.hours += hours; b.lines.push(line); d.byMech.set(r.mechanicId, b);
      } else {
        const norm = mechanics.normalizeMechanic(raw);
        const u = d.unmatched.get(norm) || { name: raw, hours: 0, lines: [] };
        u.hours += hours; u.lines.push(line); d.unmatched.set(norm, u);
      }
    }
  }
  return byDay;
}

/**
 * Put an unmatched spelling in the Alias Queue so somebody can link it — once. Lines typed on the
 * Daily Work page are stored as typed and never passed through the resolver, so without this the
 * "link it in the Alias Queue" advice would point at an empty queue.
 */
function queueUnmatched(unmatched) {
  for (const [norm, u] of unmatched) {
    if (!norm) continue;
    if (get('SELECT 1 x FROM mechanic_aliases WHERE raw_norm = ?', norm)) continue;
    mechanics.resolveMechanic(u.name, { source: 'attendance' });
  }
}

// ---- the tally ---------------------------------------------------------------------------------

const TALLY = {
  matched: { label: 'Matched', tone: 'green', red: false },
  unbooked: { label: 'Unbooked', tone: 'amber', red: false },
  over_booked: { label: 'Over-booked', tone: 'red', red: true },
  no_attendance: { label: 'No attendance', tone: 'red', red: true },
  absent_with_work: { label: 'Absent with work', tone: 'red', red: true },
  not_entered: { label: 'Not entered', tone: 'grey', red: false },
  incomplete: { label: 'Out time missing', tone: 'grey', red: false },
  off: { label: 'Off', tone: 'grey', red: false },
  before_start: { label: 'Before start', tone: 'grey', red: false },
};
const STATUS_LABEL = { present: 'Present', absent: 'Absent', leave: 'Leave', half_day: 'Half day', holiday: 'Holiday' };

/**
 * One mechanic, one day.
 * @param {object|null} att        the mechanic_attendance row, if any
 * @param {number} bookedHours     from bookedRange
 * @param {{tolerance: number, beforeStart: boolean}} opts
 */
function tallyOne(att, bookedHours, { tolerance, beforeStart }) {
  const worked = workedMinutes(att);
  const bookedMin = round2((Number(bookedHours) || 0) * 60);
  let key;
  if (beforeStart) key = 'before_start';
  else if (!att) key = bookedMin > 0 ? 'no_attendance' : 'not_entered';
  else if (OFF_STATUSES.includes(att.status)) key = bookedMin > 0 ? 'absent_with_work' : 'off';
  else if (worked == null) key = bookedMin > 0 ? 'no_attendance' : 'incomplete';
  else {
    const d = worked - bookedMin;
    // Exactly the tolerance is still a match. 1e-6 soaks up float noise from hours like 7.1.
    if (Math.abs(d) <= tolerance + 1e-6) key = 'matched';
    else key = d > 0 ? 'unbooked' : 'over_booked';
  }
  const t = TALLY[key];
  let label = t.label;
  if (key === 'off') label = STATUS_LABEL[att.status];
  if (key === 'no_attendance' && att) label = 'In/out missing';
  return {
    worked_hours: worked == null ? null : round2(worked / 60),
    booked_hours: round2(bookedHours),
    diff_hours: worked == null ? null : round2((worked - bookedMin) / 60),
    tally: key, tally_label: label, tone: t.tone, red: t.red,
  };
}

const attRow = (a) => (a ? {
  id: a.id, status: a.status, time_in: a.time_in, time_out: a.time_out, break_minutes: a.break_minutes,
  note: a.note, unbooked_reason: a.unbooked_reason, recorded_by: a.recorded_by, updated_at: a.updated_at,
} : null);

// ---- sign-off and the day lock -----------------------------------------------------------------

function signoffFor(date) {
  const s = get(`SELECT s.*, su.username AS signed_by_name, uu.username AS unlocked_by_name
                   FROM workday_signoffs s
                   LEFT JOIN users su ON su.id = s.signed_by
                   LEFT JOIN users uu ON uu.id = s.unlocked_by
                  WHERE s.work_date = ?`, date);
  return s || null;
}
const signedOff = (s) => !!(s && s.signed_at && !s.unlocked_at);

/** Is this day signed off (and attendance switched on)? A signed-off day refuses every change. */
function isLocked(date, s = settings()) {
  if (!s.enabled || !isDate(date)) return false;
  return signedOff(get('SELECT signed_at, unlocked_at FROM workday_signoffs WHERE work_date = ?', date));
}

/**
 * The day lock, for every path that writes daily work or attendance. Returns { ok: true } or
 * { ok: false, status: 423, body } — the same shape as jobstate.checkAdd.
 */
function checkDaysOpen(dates) {
  const s = settings();
  if (!s.enabled) return { ok: true };
  for (const d of new Set((dates || []).filter(Boolean).map((x) => String(x).slice(0, 10)))) {
    if (isLocked(d, s)) {
      return { ok: false, status: 423, body: {
        error: `${d} is signed off, so its attendance and daily work are locked. Ask a manager to unlock the day.`,
        locked_date: d,
      } };
    }
  }
  return { ok: true };
}

/** checkDaysOpen, throwing — so a batch touching a locked day is refused whole inside its transaction. */
function assertDaysOpen(dates) {
  const g = checkDaysOpen(dates);
  if (!g.ok) throw bad(g.body.error, g.status);
}

// ---- one day -----------------------------------------------------------------------------------

/**
 * The attendance grid and tally for one day: one row per ACTIVE mechanic, plus anyone inactive who
 * has attendance or booked work that day (so nothing hides).
 */
function day(date, { queue = false } = {}) {
  if (!isDate(date)) throw bad('A valid date (YYYY-MM-DD) is required');
  const s = settings();
  const beforeStart = !s.start_date || date < s.start_date;
  const booked = bookedRange(date, date).get(date) || { byMech: new Map(), unmatched: new Map() };
  if (queue && s.enabled) queueUnmatched(booked.unmatched);
  const atts = new Map(all('SELECT * FROM mechanic_attendance WHERE work_date = ?', date).map((a) => [a.mechanic_id, a]));
  const extra = [...new Set([...atts.keys(), ...booked.byMech.keys()])];
  const mechs = all(
    `SELECT id, name, active FROM mechanics
      WHERE active = 1 ${extra.length ? `OR id IN (${extra.map(() => '?').join(',')})` : ''}
      ORDER BY name COLLATE NOCASE`, ...extra);

  const opts = { tolerance: s.tolerance_minutes, beforeStart };
  const rows = mechs.map((m) => {
    const b = booked.byMech.get(m.id) || { hours: 0, lines: [] };
    const a = atts.get(m.id) || null;
    return { mechanic_id: m.id, name: m.name, active: !!m.active, attendance: attRow(a), lines: b.lines, ...tallyOne(a, b.hours, opts) };
  });
  const unmatched = [...booked.unmatched.values()].map((u) => ({ name: u.name, hours: round2(u.hours), lines: u.lines }));
  const counts = {};
  for (const r of rows) counts[r.tally] = (counts[r.tally] || 0) + 1;
  const red = rows.filter((r) => r.red);
  const so = signoffFor(date);
  return {
    date, enabled: s.enabled, settings: s, today: today(), before_start: beforeStart,
    locked: s.enabled && signedOff(so),
    signoff: so ? { signed_by: so.signed_by_name, signed_at: so.signed_at, unlocked_by: so.unlocked_by_name, unlocked_at: so.unlocked_at, unlock_reason: so.unlock_reason } : null,
    rows, unmatched, counts, red_count: red.length,
    totals: {
      worked_hours: round2(rows.reduce((t, r) => t + (r.worked_hours || 0), 0)),
      booked_hours: round2(rows.reduce((t, r) => t + (r.booked_hours || 0), 0)),
      unmatched_hours: round2(unmatched.reduce((t, u) => t + u.hours, 0)),
    },
  };
}

// ---- recording attendance ----------------------------------------------------------------------

/**
 * Create, change or clear attendance rows for one day. Each row may be partial: only the fields it
 * carries change ({ mechanic_id, unbooked_reason } alone records a reason). { clear: true } removes
 * the row. Who may change which day, and the day lock, are the caller's to check first.
 * @returns {Array<{mechanic_id, name, id, action, before, after}>} what actually changed
 */
function saveRows(date, rows, userId) {
  if (!isDate(date)) throw bad('A valid date (YYYY-MM-DD) is required');
  if (!Array.isArray(rows) || !rows.length) throw bad('Nothing to save');
  const changes = [];
  for (const r of rows) {
    const mechanicId = parseInt(r && r.mechanic_id, 10);
    const mech = Number.isFinite(mechanicId) ? get('SELECT id, name FROM mechanics WHERE id = ?', mechanicId) : null;
    if (!mech) throw bad('Unknown mechanic');
    const before = get('SELECT * FROM mechanic_attendance WHERE mechanic_id = ? AND work_date = ?', mech.id, date) || null;

    if (r.clear) {
      if (!before) continue;
      run('DELETE FROM mechanic_attendance WHERE id = ?', before.id);
      changes.push({ mechanic_id: mech.id, name: mech.name, id: before.id, action: 'clear', before: attRow(before), after: null });
      continue;
    }

    const next = {
      status: before ? before.status : 'present',
      time_in: before ? before.time_in : null,
      time_out: before ? before.time_out : null,
      break_minutes: before ? before.break_minutes : 0,
      note: before ? before.note : null,
      unbooked_reason: before ? before.unbooked_reason : null,
    };
    if (r.status !== undefined) {
      if (!STATUSES.includes(r.status)) throw bad(`${mech.name}: status must be one of ${STATUSES.join(', ')}`);
      next.status = r.status;
    }
    for (const k of ['time_in', 'time_out']) {
      if (r[k] === undefined) continue;
      const t = normTime(r[k]);
      if (t === undefined) throw bad(`${mech.name}: ${k === 'time_in' ? 'In' : 'Out'} time must be HH:MM, e.g. 08:00`);
      next[k] = t;
    }
    if (r.break_minutes !== undefined) {
      const n = r.break_minutes === '' || r.break_minutes === null ? 0 : Number(r.break_minutes);
      if (!Number.isInteger(n) || n < 0 || n > 600) throw bad(`${mech.name}: break must be 0 to 600 minutes`);
      next.break_minutes = n;
    }
    for (const k of ['note', 'unbooked_reason']) {
      if (r[k] === undefined) continue;
      const v = String(r[k] == null ? '' : r[k]).trim();
      if (v.length > 200) throw bad(`${mech.name}: ${k === 'note' ? 'note' : 'reason'} is too long (200 characters at most)`);
      next[k] = v || null;
    }
    // Not at work: no times, no break. Kept consistent so the grid never shows stale hours.
    if (OFF_STATUSES.includes(next.status)) { next.time_in = null; next.time_out = null; next.break_minutes = 0; }
    const w = workedMinutes(next);
    if (w != null && w === 0 && !OFF_STATUSES.includes(next.status) && toMinutes(next.time_in) !== toMinutes(next.time_out)) {
      throw bad(`${mech.name}: the break is as long as the whole shift`);
    }

    const same = before && ['status', 'time_in', 'time_out', 'break_minutes', 'note', 'unbooked_reason']
      .every((k) => (before[k] == null ? null : before[k]) === (next[k] == null ? null : next[k]));
    if (same) continue;
    let id;
    if (before) {
      run(`UPDATE mechanic_attendance SET status = ?, time_in = ?, time_out = ?, break_minutes = ?, note = ?,
             unbooked_reason = ?, recorded_by = ?, updated_at = datetime('now') WHERE id = ?`,
      next.status, next.time_in, next.time_out, next.break_minutes, next.note, next.unbooked_reason, userId || null, before.id);
      id = before.id;
    } else {
      id = run(`INSERT INTO mechanic_attendance (mechanic_id, work_date, status, time_in, time_out, break_minutes, note, unbooked_reason, recorded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mech.id, date, next.status, next.time_in, next.time_out, next.break_minutes, next.note, next.unbooked_reason, userId || null).lastInsertRowid;
    }
    changes.push({ mechanic_id: mech.id, name: mech.name, id, action: before ? 'edit' : 'create', before: attRow(before), after: next });
  }
  return changes;
}

/** Which days may this person change? today and yesterday with attendance.record; any past day with attendance.unlock. */
function editRule(date, caps) {
  const t = today();
  if (!isDate(date)) return { ok: false, status: 400, error: 'A valid date (YYYY-MM-DD) is required' };
  if (date > t) return { ok: false, status: 400, error: 'Attendance cannot be entered for a day that has not come yet' };
  if (caps.includes('attendance.unlock')) return { ok: true };
  if (caps.includes('attendance.record') && date >= addDays(t, -1)) return { ok: true };
  if (caps.includes('attendance.record')) {
    return { ok: false, status: 403, error: 'Only today\'s and yesterday\'s attendance can be changed. Ask a manager to change an older day.' };
  }
  return { ok: false, status: 403, error: 'You cannot change attendance' };
}

// ---- sign-off ----------------------------------------------------------------------------------

/** Sign a day off. Refused while anybody is red, and before the start date. */
function signOff(date, userId) {
  const s = settings();
  if (!s.enabled) throw bad('Attendance is switched off', 409);
  if (!isDate(date)) throw bad('A valid date (YYYY-MM-DD) is required');
  if (date > today()) throw bad('A day can be signed off only once it has come');
  if (!s.start_date || date < s.start_date) throw bad(`Attendance starts on ${s.start_date || '(not set)'} — days before it are not signed off`, 409);
  const d = day(date);
  if (d.locked) throw bad(`${date} is already signed off`, 409);
  if (d.red_count) {
    const names = d.rows.filter((r) => r.red).map((r) => `${r.name} (${r.tally_label})`);
    throw bad(`Cannot sign off: ${d.red_count} red — ${names.join(', ')}. Fix them first.`, 409);
  }
  run(`INSERT INTO workday_signoffs (work_date, signed_by, signed_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(work_date) DO UPDATE SET signed_by = excluded.signed_by, signed_at = excluded.signed_at,
         unlocked_by = NULL, unlocked_at = NULL, unlock_reason = NULL`, date, userId || null);
  return d;
}

/** Unlock a signed-off day. Needs a reason; the caller checks attendance.unlock. */
function unlock(date, userId, reason) {
  const why = String(reason == null ? '' : reason).trim();
  if (!why) throw bad('Give a reason for unlocking the day');
  if (why.length > 300) throw bad('The reason is too long (300 characters at most)');
  if (!isEnabled()) throw bad('Attendance is switched off', 409);
  const so = signoffFor(date);
  if (!signedOff(so)) throw bad(`${date} is not signed off`, 409);
  run(`UPDATE workday_signoffs SET unlocked_by = ?, unlocked_at = datetime('now'), unlock_reason = ? WHERE work_date = ?`,
    userId || null, why, date);
  return signoffFor(date);
}

// ---- hours left, at the point of entry ---------------------------------------------------------

/**
 * For the entry forms: "attended 8.0 h · booked 6.5 h · 1.5 h left" for each named mechanic.
 * `excludeLineId`: the line being edited, whose own hours are about to be replaced.
 */
function hoursLeft(date, names, { excludeLineId = null } = {}) {
  const s = settings();
  if (!s.enabled) return { enabled: false };
  if (!isDate(date)) throw bad('A valid date (YYYY-MM-DD) is required');
  const booked = bookedRange(date, date, { excludeLineId }).get(date) || { byMech: new Map() };
  const out = [];
  const byId = new Map();
  for (const raw of (names || []).flatMap((n) => mechanics.splitMechanics(n))) {
    const r = mechanics.resolveMechanic(raw, { register: false });
    if (!r.resolved) { out.push({ name: raw, raws: [raw], resolved: false }); continue; }
    // One entry per person; `raws` says which of the typed spellings are this person, so a form
    // can add up its own rows (the quick grid) per mechanic.
    if (byId.has(r.mechanicId)) { byId.get(r.mechanicId).raws.push(raw); continue; }
    const a = get('SELECT * FROM mechanic_attendance WHERE mechanic_id = ? AND work_date = ?', r.mechanicId, date);
    const worked = workedMinutes(a);
    const b = booked.byMech.get(r.mechanicId);
    const bookedHours = round2(b ? b.hours : 0);
    const m = {
      name: r.name, mechanic_id: r.mechanicId, resolved: true, raws: [raw],
      status: a ? a.status : null,
      attended_hours: worked == null ? null : round2(worked / 60),
      booked_hours: bookedHours,
      left_hours: worked == null ? null : round2(worked / 60 - bookedHours),
    };
    byId.set(r.mechanicId, m);
    out.push(m);
  }
  return { enabled: true, date, before_start: !s.start_date || date < s.start_date, locked: isLocked(date, s),
    tolerance_minutes: s.tolerance_minutes, mechanics: out };
}

// ---- a month -----------------------------------------------------------------------------------

/**
 * Attended, booked and utilisation per mechanic for a month — counted only over the days the
 * tally runs (from the start date, up to today), so booked and attended cover the same days.
 */
function month(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) throw bad('A valid month (YYYY-MM) is required');
  const s = settings();
  const first = `${ym}-01`;
  const last = addDays(`${nextMonth(ym)}-01`, -1);
  let from = first; let to = last;
  if (s.start_date && s.start_date > from) from = s.start_date;
  if (today() < to) to = today();
  const empty = { month: ym, enabled: s.enabled, from: null, to: null, mechanics: [], days: [] };
  if (!s.start_date || from > to) return empty;

  const booked = bookedRange(from, to);
  const atts = all('SELECT * FROM mechanic_attendance WHERE work_date BETWEEN ? AND ?', from, to);
  const attBy = new Map(atts.map((a) => [`${a.work_date}|${a.mechanic_id}`, a]));
  const signed = new Map(all('SELECT work_date, signed_at, unlocked_at FROM workday_signoffs WHERE work_date BETWEEN ? AND ?', from, to)
    .map((r) => [r.work_date, signedOff(r)]));
  const names = new Map(all('SELECT id, name, active FROM mechanics').map((m) => [m.id, m]));
  const per = new Map();
  const acc = (id) => {
    if (!per.has(id)) per.set(id, { mechanic_id: id, name: (names.get(id) || {}).name || `#${id}`, attended_hours: 0, booked_hours: 0, days_present: 0, red_days: 0 });
    return per.get(id);
  };
  const days = [];
  const opts = { tolerance: s.tolerance_minutes, beforeStart: false };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const b = booked.get(d) || { byMech: new Map(), unmatched: new Map() };
    const ids = new Set([...b.byMech.keys()]);
    for (const a of atts) if (a.work_date === d) ids.add(a.mechanic_id);
    let red = 0;
    for (const id of ids) {
      const a = attBy.get(`${d}|${id}`) || null;
      const t = tallyOne(a, b.byMech.has(id) ? b.byMech.get(id).hours : 0, opts);
      const m = acc(id);
      m.attended_hours += t.worked_hours || 0;
      m.booked_hours += t.booked_hours || 0;
      if (a && !OFF_STATUSES.includes(a.status) && t.worked_hours) m.days_present++;
      if (t.red) { m.red_days++; red++; }
    }
    days.push({ date: d, red_count: red, unmatched: b.unmatched.size, signed_off: !!signed.get(d) });
  }
  const mechanicsOut = [...per.values()].map((m) => ({
    ...m,
    attended_hours: round2(m.attended_hours),
    booked_hours: round2(m.booked_hours),
    utilisation: m.attended_hours > 0 ? Math.round((m.booked_hours / m.attended_hours) * 1000) / 10 : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { month: ym, enabled: s.enabled, from, to, mechanics: mechanicsOut, days };
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

module.exports = {
  KEYS, STATUSES, OFF_STATUSES, TALLY,
  settings, saveSettings, isEnabled,
  today, addDays, isDate, toMinutes, normTime, workedMinutes,
  bookedRange, tallyOne, day, saveRows, editRule,
  signoffFor, isLocked, checkDaysOpen, assertDaysOpen, signOff, unlock,
  hoursLeft, month,
};
