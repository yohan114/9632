'use strict';

// ===========================================================================
// Field work (multi-site Stage 6) — a repair done where the machine is, not in the workshop.
//
// A job card can say it is IN THE FIELD, and at which project or site (the Stage 2 places list).
// Its workshop is the one that sends the mechanics, so every Stage 3 rule applies unchanged.
//
// A BREAKDOWN reported from a site opens such a card at once (S6-D2): the mechanic can leave now,
// and the card's approvals follow as they do for any card. Three times are kept on the card:
//   reported_at   when the machine stopped / the site called
//   arrived_at    when the mechanic got there          response time = arrived − reported
//   working_at    when the machine was working again    downtime      = working − reported
//
// Travel is a daily-work line marked travel (S6-D4): costed at the mechanic's rate like any hour,
// shown apart. The field vehicle's km are charged at the rate per km in force when they were
// entered (S6-D5), as part of the card's other cost. A card nobody marks stays a workshop card:
// with no field jobs, nothing changes.
// ===========================================================================

const { get, all, run, tx } = require('../db');

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const audit = (...a) => require('./audit').record(...a);
const KM_RATE = 'field_km_rate';

/** Now, local time, to the minute: 'YYYY-MM-DD HH:MM'. */
function nowStamp() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
}
/** A time as typed ('YYYY-MM-DD HH:MM' or with a T) → the stored form, '' → null, else throws. */
function stampOf(v, label) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const s = String(v).trim().replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) || Number.isNaN(Date.parse(s.replace(' ', 'T')))) fail(400, `Give the ${label} as a date and time.`);
  return s;
}
const ms = (s) => Date.parse(String(s).replace(' ', 'T'));
/** Hours from a to b (b defaults to now), or null. */
function hoursBetween(a, b) {
  if (!a) return null;
  const end = b ? ms(b) : ms(nowStamp());
  return r2((end - ms(a)) / 3600000);
}

// ---- settings ---------------------------------------------------------------------------------

function settings() {
  const r = get('SELECT value FROM settings WHERE key = ?', KM_RATE);
  const v = r && r.value !== '' && r.value != null ? Number(r.value) : null;
  return { km_rate: Number.isFinite(v) ? v : null };
}

function saveSettings(actor, body = {}) {
  const before = settings();
  const raw = body.km_rate;
  const v = raw === '' || raw == null ? null : Number(raw);
  if (v != null && (!Number.isFinite(v) || v < 0)) fail(400, 'The rate per km is an amount: 0 or more.');
  run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, KM_RATE, v == null ? '' : String(r2(v)));
  audit({ userId: actor.id, entity: 'settings', action: 'field_settings', before, after: settings() });
  return settings();
}

// ---- one card ---------------------------------------------------------------------------------

/** The field side of a card, with the figures worked out from it. */
function view(job) {
  if (!job) return null;
  const transport = job.field && job.field_km > 0 && job.field_km_rate != null ? r2(job.field_km * job.field_km_rate) : 0;
  const travel = get('SELECT ROUND(COALESCE(SUM(hours),0),2) h FROM job_daily_work WHERE job_id = ? AND travel = 1', job.id).h;
  const final = ['CLOSED', 'REJECTED'].includes(job.status);
  return {
    field: !!job.field, breakdown: !!job.breakdown,
    place: job.field_place || null, location: job.field_location || null,
    reported_at: job.reported_at || null, arrived_at: job.arrived_at || null, working_at: job.working_at || null,
    km: job.field_km == null ? null : job.field_km, km_rate: job.field_km_rate == null ? null : job.field_km_rate,
    transport_cost: transport, travel_hours: travel,
    response_hours: job.reported_at && job.arrived_at ? hoursBetween(job.reported_at, job.arrived_at) : null,
    downtime_hours: job.reported_at && job.working_at ? hoursBetween(job.reported_at, job.working_at) : null,
    // Still down: in the field, not working again, card not finished.
    down: !!job.field && !job.working_at && !final,
    down_hours: !!job.field && !job.working_at && !final && job.reported_at ? hoursBetween(job.reported_at) : null,
  };
}

/** A place picked for a field job: a project or a site from the list (never a workshop). */
function placeOf(key, text) {
  const places = require('./places');
  const k = places.forEnd(key, text);
  if (k && k.startsWith('w:')) fail(400, 'A field job is at a project or a site, not at a workshop.');
  const p = k ? places.byKey(k) : null;
  return { key: k || null, label: clean(text, 120) || (p ? p.label : '') || null };
}

/** The project a place belongs to (a site's project), for the card's project. */
function projectOfPlace(key) {
  const m = /^([ps]):(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  if (m[1] === 'p') return Number(m[2]);
  const s = get('SELECT project_id FROM sites WHERE id = ?', Number(m[2]));
  return s ? s.project_id : null;
}

function checkOrder(t) {
  const now = ms(nowStamp()) + 5 * 60000;
  for (const [k, label] of [['reported_at', 'breakdown time'], ['arrived_at', 'arrival time'], ['working_at', 'working-again time']]) {
    if (t[k] && ms(t[k]) > now) fail(400, `The ${label} cannot be in the future.`);
  }
  if (t.reported_at && t.arrived_at && ms(t.arrived_at) < ms(t.reported_at)) fail(400, 'The mechanic cannot arrive before the breakdown was reported.');
  if (t.arrived_at && t.working_at && ms(t.working_at) < ms(t.arrived_at)) fail(400, 'The machine cannot be working again before the mechanic arrived.');
  if (!t.arrived_at && t.working_at) fail(400, 'Record the arrival before the machine is working again.');
}

function loadJob(jobId) {
  const job = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!job) fail(404, 'Job not found');
  if (['CLOSED', 'REJECTED'].includes(job.status)) fail(409, `Job ${job.job_no} is ${job.status === 'CLOSED' ? 'closed' : 'rejected'}. Reopen it to change its field work.`);
  return job;
}

/**
 * Mark a card in the field (or back in the workshop), and set its site, times and km. Only what is
 * given changes. Back in the workshop clears the field details — they described work that is not
 * being done there.
 */
function update(actor, jobId, body = {}) {
  const job = loadJob(jobId);
  const next = {
    field: job.field, breakdown: job.breakdown, field_place: job.field_place, field_location: job.field_location,
    reported_at: job.reported_at, arrived_at: job.arrived_at, working_at: job.working_at,
    field_km: job.field_km, field_km_rate: job.field_km_rate,
  };
  if (body.field !== undefined) next.field = body.field ? 1 : 0;
  const detail = ['place', 'location', 'reported_at', 'arrived_at', 'working_at', 'km'].some((k) => body[k] !== undefined);
  if (!next.field) {
    if (detail && body.field === undefined) fail(400, 'Mark the job "In the field" first.');
    Object.assign(next, { breakdown: 0, field_place: null, field_location: null, reported_at: null, arrived_at: null, working_at: null, field_km: null, field_km_rate: null });
  } else {
    if (body.place !== undefined || body.location !== undefined) {
      const p = placeOf(body.place !== undefined ? body.place : job.field_place, body.location !== undefined ? body.location : '');
      next.field_place = p.key; next.field_location = p.label;
    }
    for (const [k, label] of [['reported_at', 'breakdown time'], ['arrived_at', 'arrival time'], ['working_at', 'working-again time']]) {
      const v = stampOf(body[k], label);
      if (v !== undefined) next[k] = v;
    }
    if (body.km !== undefined) {
      const km = body.km === '' || body.km == null ? null : Number(body.km);
      if (km != null && (!Number.isFinite(km) || km < 0)) fail(400, 'The km driven is a distance: 0 or more.');
      if (km !== job.field_km) { next.field_km = km == null ? null : r2(km); next.field_km_rate = km == null ? null : settings().km_rate; }
    }
    checkOrder(next);
  }
  const costChanged = next.field_km !== job.field_km || next.field_km_rate !== job.field_km_rate || next.field !== job.field;
  tx(() => {
    run(`UPDATE job_cards SET field = ?, breakdown = ?, field_place = ?, field_location = ?, reported_at = ?, arrived_at = ?,
                              working_at = ?, field_km = ?, field_km_rate = ?, updated_at = datetime('now') WHERE id = ?`,
    next.field, next.breakdown, next.field_place, next.field_location, next.reported_at, next.arrived_at,
    next.working_at, next.field_km, next.field_km_rate, job.id);
    if (costChanged) require('./costing').refreshJobTotals(job.id);
  });
  const pick = (o) => ({ field: o.field, place: o.field_place, location: o.field_location, reported_at: o.reported_at,
    arrived_at: o.arrived_at, working_at: o.working_at, km: o.field_km, km_rate: o.field_km_rate });
  audit({ userId: actor.id, entity: 'job_card', entityId: job.id, action: 'field', before: pick(job), after: pick(next) });
  return view(get('SELECT * FROM job_cards WHERE id = ?', job.id));
}

/** One button on the phone: the mechanic arrived, or the machine is working again — now. */
function stamp(actor, jobId, which) {
  const job = loadJob(jobId);
  if (!job.field) fail(409, 'This job is not in the field.');
  const now = nowStamp();
  if (which === 'arrived') {
    if (job.arrived_at) fail(409, `The arrival is already recorded (${job.arrived_at}).`);
    run("UPDATE job_cards SET arrived_at = ?, updated_at = datetime('now') WHERE id = ?", now, job.id);
  } else if (which === 'working') {
    if (!job.arrived_at) fail(409, 'Press "Mechanic arrived" first.');
    if (job.working_at) fail(409, `Working again is already recorded (${job.working_at}).`);
    run("UPDATE job_cards SET working_at = ?, updated_at = datetime('now') WHERE id = ?", now, job.id);
  } else fail(404, 'Unknown step');
  audit({ userId: actor.id, entity: 'job_card', entityId: job.id, action: `field_${which}`, after: { at: now } });
  return view(get('SELECT * FROM job_cards WHERE id = ?', job.id));
}

/**
 * A breakdown reported from a site: a field job card, open at once (S6-D2). The one-open-card rule
 * still holds — a machine that already has an open card is marked on that card instead.
 */
function reportBreakdown(actor, body = {}) {
  const workshops = require('./workshops');
  const jobstate = require('./jobstate');
  const assetId = Number(body.asset_id) || null;
  if (!assetId || !get('SELECT 1 x FROM assets WHERE id = ?', assetId)) fail(400, 'Choose the machine that broke down.');
  const description = clean(body.description, 1000);
  if (!description) fail(400, 'Say what is wrong.');
  const p = placeOf(body.place, body.location);
  if (!p.key && !p.label) fail(400, 'Choose the site where the machine is.');
  const reportedAt = stampOf(body.stopped_at, 'breakdown time') || nowStamp();
  checkOrder({ reported_at: reportedAt });
  const guard = jobstate.checkOneOpenJob(assetId);
  if (!guard.ok) {
    fail(409, `This machine already has an open job card (${guard.blocking.job_no}). Open that card and mark it "In the field" instead.`);
  }
  const workshopId = workshops.forNew(actor, body.workshop_id);
  const jobNo = require('./jobno').nextJobNo('repair');
  const u = get('SELECT username, full_name FROM users WHERE id = ?', actor.id) || {};
  const id = run(
    `INSERT INTO job_cards (job_no, asset_id, project_id, site, type, description, status, requested_by, requested_by_user,
                            workshop_id, field, breakdown, field_place, field_location, reported_at)
     VALUES (?, ?, ?, ?, 'repair', ?, 'REQUESTED', ?, ?, ?, 1, 1, ?, ?, ?)`,
    jobNo, assetId, projectOfPlace(p.key), p.label, description, u.full_name || u.username || 'breakdown', actor.id,
    workshopId, p.key, p.label, reportedAt).lastInsertRowid;
  audit({ userId: actor.id, entity: 'job_card', entityId: id, action: 'create',
    after: { job_no: jobNo, breakdown: true, place: p.label, reported_at: reportedAt, workshop_id: workshopId } });
  return get('SELECT * FROM job_cards WHERE id = ?', id);
}

// ---- lists ------------------------------------------------------------------------------------

const JOB_LIST = `SELECT j.id, j.job_no, j.status, j.description, j.breakdown, j.field_location, j.reported_at, j.arrived_at,
         j.working_at, j.field_km, j.field_km_rate, j.workshop_id, w.name AS workshop_name,
         a.code AS asset_code, a.registration AS asset_reg, a.ec_code AS asset_ec, a.type AS asset_type,
         (SELECT GROUP_CONCAT(DISTINCT dw.mechanic) FROM job_daily_work dw
           WHERE dw.job_id = j.id AND dw.work_date >= date('now', '-3 day')) AS mechanics,
         (SELECT ROUND(COALESCE(SUM(dw.hours),0),2) FROM job_daily_work dw WHERE dw.job_id = j.id AND dw.travel = 1) AS travel_hours
    FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id LEFT JOIN workshops w ON w.id = j.workshop_id`;

/** The field board: every field job still open, the machines still down first, longest down first. */
function board(user) {
  const jobstate = require('./jobstate');
  const own = require('./scope').filter(user, 'j.workshop_id');
  const rows = all(`${JOB_LIST} WHERE j.field = 1 AND ${jobstate.notFinalSql('j')} ${own.sql ? 'AND ' + own.sql : ''}
                    ORDER BY (j.working_at IS NULL) DESC, COALESCE(j.reported_at, j.requested_at), j.id`, ...own.params);
  for (const r of rows) {
    r.down = !r.working_at;
    r.down_hours = r.down && r.reported_at ? hoursBetween(r.reported_at) : null;
    r.response_hours = r.reported_at && r.arrived_at ? hoursBetween(r.reported_at, r.arrived_at) : null;
    r.downtime_hours = r.reported_at && r.working_at ? hoursBetween(r.reported_at, r.working_at) : null;
  }
  return { rows, down: rows.filter((r) => r.down).length, settings: settings() };
}

/** Machines down in the field (the dashboard tile), for this person's workshops. */
function downCount(user) {
  const jobstate = require('./jobstate');
  const own = require('./scope').filter(user, 'j.workshop_id');
  return get(`SELECT COUNT(*) n FROM job_cards j WHERE j.field = 1 AND j.working_at IS NULL AND ${jobstate.notFinalSql('j')}
               ${own.sql ? 'AND ' + own.sql : ''}`, ...own.params).n;
}

/**
 * A month of field work (the Job Cost workbook's "Field work" sheet): every field job reported in
 * the month, and per site the jobs, the average response, the downtime, travel, km and transport.
 * `ws`: one workshop's (Stage 5), else all.
 */
function month(ym, ws = null) {
  const wsSql = ws ? ` AND COALESCE(j.workshop_id, (SELECT id FROM workshops WHERE is_default = 1 ORDER BY id LIMIT 1)) = ${Number(ws)}` : '';
  const rows = all(`${JOB_LIST} WHERE j.field = 1 AND j.status <> 'REJECTED' AND substr(COALESCE(j.reported_at, j.requested_at),1,7) = ?${wsSql}
                    ORDER BY COALESCE(j.reported_at, j.requested_at), j.id`, ym);
  const sites = new Map();
  for (const r of rows) {
    r.response_hours = r.reported_at && r.arrived_at ? hoursBetween(r.reported_at, r.arrived_at) : null;
    r.downtime_hours = r.reported_at && r.working_at ? hoursBetween(r.reported_at, r.working_at) : null;
    r.transport_cost = r.field_km > 0 && r.field_km_rate != null ? r2(r.field_km * r.field_km_rate) : 0;
    const k = r.field_location || '(site not given)';
    if (!sites.has(k)) sites.set(k, { site: k, jobs: 0, responses: [], downtime: 0, travel_hours: 0, km: 0, transport_cost: 0 });
    const s = sites.get(k);
    s.jobs++; if (r.response_hours != null) s.responses.push(r.response_hours);
    s.downtime += r.downtime_hours || 0; s.travel_hours += r.travel_hours || 0; s.km += r.field_km || 0; s.transport_cost += r.transport_cost;
  }
  const bySite = [...sites.values()].map((s) => ({
    site: s.site, jobs: s.jobs,
    avg_response_hours: s.responses.length ? r2(s.responses.reduce((a, b) => a + b, 0) / s.responses.length) : null,
    downtime_hours: r2(s.downtime), travel_hours: r2(s.travel_hours), km: r2(s.km), transport_cost: r2(s.transport_cost),
  }));
  return { month: ym, rows, sites: bySite };
}

module.exports = {
  KM_RATE, nowStamp, hoursBetween, settings, saveSettings, view, update, stamp, reportBreakdown, board, downCount, month,
  projectOfPlace,
};
