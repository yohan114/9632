'use strict';

// ===========================================================================
// Operations (multi-site Stage 7) — running several workshops and sites together.
//
//   MACHINE MOVES   A machine goes from one project or site to another on a date (S7-D2). Every
//                   move is kept (asset_moves); the machine's current project is the last move's.
//                   Before its first recorded move a machine was where that move took it from.
//   SITE FLEET      Per project or site: the machines there now and what each is doing, and the
//                   month's availability in machine-days (S7-D4): the days with no open repair.
//   AT A GLANCE     One row per workshop for head office (S7-D5), each number with its list.
//   HANDOVERS       A job card sent to another workshop needs a reason; the move is kept (S7-D6).
//
// A machine is DOWN (S7-D3) from the day its repair card is opened — or the breakdown reported —
// until the work is complete. Waiting for prices after that does not count; services are not
// downtime. A field job (Stage 6) is down until "working again", as on the Field Work board.
// Cards imported from the old job book do not count: the import stamped them all with the day it
// ran, so their dates say nothing about when the machine stopped (see src/lib/job_review.js).
// ===========================================================================

const { get, all, run, tx } = require('../db');
const jobstate = require('./jobstate');

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const clean = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const audit = (...a) => require('./audit').record(...a);
const d10 = (s) => (s ? String(s).slice(0, 10) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The card still holds the machine: opened and not yet complete (WORK_COMPLETE onwards it is out).
const HOLDING = jobstate.OPEN_STATUSES.filter((s) => s !== 'WORK_COMPLETE');

// ---- places ------------------------------------------------------------------------------------

/** The key of where a machine stands: 's:<site>' at a site, 'p:<project>' at a project, else null. */
const keyOf = (projectId, siteId) => (siteId ? `s:${siteId}` : projectId ? `p:${projectId}` : null);

function labelOf(key) {
  if (!key) return 'No site set';
  const p = require('./places').byKey(key);
  return p ? p.label : 'No site set';
}

/** A place picked for a move: a project or a site of one (never a workshop). */
function placeOf(key) {
  const m = /^([ps]):(\d+)$/.exec(String(key || '').trim());
  if (!m) {
    if (/^w:/.test(String(key || ''))) fail(400, 'A machine moves to a project or a site, not to a workshop.');
    fail(400, 'Choose where the machine goes: a project or a site from the list.');
  }
  const id = Number(m[2]);
  if (m[1] === 'p') {
    const p = get('SELECT id FROM projects WHERE id = ?', id);
    if (!p) fail(400, 'That project is not on the list.');
    return { key: `p:${id}`, project_id: id, site_id: null };
  }
  const s = get('SELECT id, project_id FROM sites WHERE id = ?', id);
  if (!s) fail(400, 'That site is not on the list.');
  return { key: `s:${id}`, project_id: s.project_id || null, site_id: id };
}

// ---- machine moves -----------------------------------------------------------------------------

const movesOf = (assetId) => all('SELECT * FROM asset_moves WHERE asset_id = ? ORDER BY move_date, id', assetId);

/** A machine's moves, newest first, with the places named. */
function history(assetId) {
  return movesOf(assetId).reverse().map((m) => ({
    id: m.id, move_date: m.move_date, note: m.note, created_at: m.created_at,
    from: labelOf(keyOf(m.from_project_id, m.from_site_id)), to: labelOf(keyOf(m.to_project_id, m.to_site_id)),
    from_key: keyOf(m.from_project_id, m.from_site_id), to_key: keyOf(m.to_project_id, m.to_site_id),
    moved_by: m.moved_by ? (get('SELECT COALESCE(full_name, username) n FROM users WHERE id = ?', m.moved_by) || {}).n || null : null,
  }));
}

/**
 * Move a machine to another project or site from a date (S7-D2). A move cannot be dated in the
 * future, nor before the machine's last move — the history reads in order, and the machine's
 * current place is always where its last move took it.
 */
function moveMachine(actor, assetId, body = {}) {
  const a = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!a) fail(404, 'Machine not found');
  const to = placeOf(body.place);
  const date = body.move_date == null || body.move_date === '' ? today() : String(body.move_date).slice(0, 10);
  if (!isDate(date)) fail(400, 'Give the date of the move.');
  if (date > today()) fail(400, 'A move cannot be dated in the future.');
  const last = get('SELECT move_date FROM asset_moves WHERE asset_id = ? ORDER BY move_date DESC, id DESC LIMIT 1', a.id);
  if (last && date < last.move_date) fail(400, `This machine last moved on ${last.move_date}. A new move cannot be dated before that.`);
  const fromKey = keyOf(a.current_project_id, a.current_site_id);
  if (fromKey === to.key) fail(400, 'The machine is already there.');
  const note = clean(body.note) || null;
  const id = tx(() => {
    const mid = run(`INSERT INTO asset_moves (asset_id, move_date, from_project_id, from_site_id, to_project_id, to_site_id, note, moved_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, date, a.current_project_id || null, a.current_site_id || null, to.project_id, to.site_id, note, actor.id).lastInsertRowid;
    run("UPDATE assets SET current_project_id = ?, current_site_id = ?, updated_at = datetime('now') WHERE id = ?", to.project_id, to.site_id, a.id);
    return mid;
  });
  audit({ userId: actor.id, entity: 'asset', entityId: a.id, action: 'move',
    before: { place: labelOf(fromKey) }, after: { place: labelOf(to.key), move_date: date, note, move_id: id } });
  return { asset: get('SELECT * FROM assets WHERE id = ?', a.id), moves: history(a.id) };
}

/**
 * The machine's project was changed on its page (the asset edit): keep that as a move today, and
 * drop a site that belonged to the old project.
 */
function recordEdit(actor, before, after) {
  if (Number(before.current_project_id || 0) === Number(after.current_project_id || 0)) return null;
  const siteStays = after.current_site_id
    && get('SELECT 1 x FROM sites WHERE id = ? AND project_id IS ?', after.current_site_id, after.current_project_id || null);
  const siteId = siteStays ? after.current_site_id : null;
  if (!siteStays && after.current_site_id) run('UPDATE assets SET current_site_id = NULL WHERE id = ?', after.id);
  const last = get('SELECT move_date FROM asset_moves WHERE asset_id = ? ORDER BY move_date DESC, id DESC LIMIT 1', after.id);
  const date = last && last.move_date > today() ? last.move_date : today();
  return run(`INSERT INTO asset_moves (asset_id, move_date, from_project_id, from_site_id, to_project_id, to_site_id, note, moved_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  after.id, date, before.current_project_id || null, before.current_site_id || null, after.current_project_id || null, siteId,
  'Changed on the machine page', actor.id).lastInsertRowid;
}

/** Where a machine was on a day, from its moves (sorted by date); `current` when it never moved. */
function placeOn(moves, current, day) {
  if (!moves || !moves.length) return current;
  let at = keyOf(moves[0].from_project_id, moves[0].from_site_id);
  for (const m of moves) {
    if (m.move_date <= day) at = keyOf(m.to_project_id, m.to_site_id);
    else break;
  }
  return at;
}

// ---- downtime ----------------------------------------------------------------------------------

/**
 * When a repair card held its machine (S7-D3): { start, end } as YYYY-MM-DD, both days counted.
 *   start  the breakdown report, else the day the card was opened
 *   end    a field job: "working again"; still holding: today; else the day the work was complete
 */
function downSpan(j, now = today()) {
  const start = d10(j.reported_at) || d10(j.requested_at);
  if (!start) return null;
  let end;
  if (j.working_at) end = d10(j.working_at);
  else if (j.field ? !jobstate.isFinal(j.status) : HOLDING.includes(j.status)) end = now;
  else end = d10(j.completed_at) || d10(j.partial_closed_at) || d10(j.closed_at) || start;
  return { start, end: end < start ? start : end };
}

const REPAIRS = `SELECT j.id, j.job_no, j.asset_id, j.status, j.field, j.workshop_id, j.requested_at, j.reported_at, j.working_at,
                        j.completed_at, j.partial_closed_at, j.closed_at, w.name AS workshop_name
                   FROM job_cards j LEFT JOIN workshops w ON w.id = j.workshop_id
                  WHERE j.type = 'repair' AND j.status <> 'REJECTED' AND j.asset_id IS NOT NULL
                    AND COALESCE(j.is_historical, 0) = 0`;

/** Is this card holding its machine right now? */
const holdsNow = (j) => (j.field ? !j.working_at && !jobstate.isFinal(j.status) : HOLDING.includes(j.status));

// ---- the site fleet board ----------------------------------------------------------------------

function monthDays(ym) {
  const now = today();
  if (!/^\d{4}-\d{2}$/.test(ym)) fail(400, 'A valid month (YYYY-MM) is required.');
  const first = `${ym}-01`;
  if (first > now) fail(400, 'That month has not started yet.');
  const days = [];
  for (let d = first; d.slice(0, 7) === ym && d <= now; d = addDays(d, 1)) days.push(d);
  return days;
}

const STATES = ['working', 'down_workshop', 'down_field', 'idle', 'out_of_use'];

/**
 * The site fleet board for a month: every project or site with machines, what each machine is
 * doing now, and the month's availability there. A machine counts where it stood on each day.
 * The fleet is the register, plus any machine placed at a project; machines out of use are shown
 * but not counted in availability.
 */
function fleet(user, ym = today().slice(0, 7)) {
  const scope = require('./scope');
  const days = monthDays(ym);
  const first = days[0];
  const last = days[days.length - 1];
  const assets = all(`SELECT a.id, a.code, a.registration, a.ec_code, a.type, a.status, a.current_project_id, a.current_site_id
                        FROM assets a
                       WHERE a.in_register = 1 OR a.current_project_id IS NOT NULL
                          OR EXISTS (SELECT 1 FROM asset_moves m WHERE m.asset_id = a.id)
                       ORDER BY a.code`);
  const moves = new Map();
  for (const m of all('SELECT * FROM asset_moves ORDER BY asset_id, move_date, id')) {
    if (!moves.has(m.asset_id)) moves.set(m.asset_id, []);
    moves.get(m.asset_id).push(m);
  }
  // Down days in the month, and the card holding each machine now.
  const downDays = new Map();
  const holding = new Map();
  const now = today();
  for (const j of all(`${REPAIRS} AND substr(COALESCE(j.reported_at, j.requested_at),1,10) <= ? ORDER BY j.id`, last)) {
    if (holdsNow(j)) holding.set(j.asset_id, j);
    const s = downSpan(j, now);
    if (!s || s.end < first) continue;
    if (!downDays.has(j.asset_id)) downDays.set(j.asset_id, new Set());
    const set = downDays.get(j.asset_id);
    for (let d = s.start < first ? first : s.start; d <= s.end && d <= last; d = addDays(d, 1)) set.add(d);
  }

  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) {
      rows.set(key, { key, label: labelOf(key), machines: 0, machine_days: 0, down_days: 0, availability: null, list: [],
        ...Object.fromEntries(STATES.map((s) => [s, 0])) });
    }
    return rows.get(key);
  };
  for (const a of assets) {
    const mv = moves.get(a.id) || [];
    const cur = keyOf(a.current_project_id, a.current_site_id);
    const j = holding.get(a.id);
    let state;
    if (a.status === 'decommissioned') state = 'out_of_use';
    else if (j) state = j.field ? 'down_field' : 'down_workshop';
    else if (a.status === 'under_repair') state = 'down_workshop';
    else if (a.status === 'idle') state = 'idle';
    else state = 'working';
    const r = row(cur);
    r.machines++; r[state]++;
    const down = downDays.get(a.id) || new Set();
    r.list.push({
      id: a.id, code: a.code, registration: a.registration, ec_code: a.ec_code, type: a.type, state,
      job: j ? (scope.mayReach(user, j.workshop_id)
        ? { id: j.id, job_no: j.job_no, workshop_name: j.workshop_name, reachable: true }
        : { job_no: j.job_no, workshop_name: j.workshop_name, reachable: false }) : null,
      down_days: a.status === 'decommissioned' ? null : down.size,
    });
    if (a.status === 'decommissioned') continue;
    // The month's machine-days, each at the place the machine stood that day.
    for (const d of days) {
      const at = row(placeOn(mv, cur, d));
      at.machine_days++;
      if (down.has(d)) at.down_days++;
    }
  }
  const pct = (r) => (r.machine_days ? Math.round(((r.machine_days - r.down_days) / r.machine_days) * 1000) / 10 : null);
  const out = [...rows.values()].map((r) => ({ ...r, availability: pct(r) }))
    .sort((a, b) => (a.key == null) - (b.key == null) || a.label.localeCompare(b.label));
  const total = { machines: 0, machine_days: 0, down_days: 0, ...Object.fromEntries(STATES.map((s) => [s, 0])) };
  for (const r of out) for (const k of Object.keys(total)) total[k] += r[k];
  total.availability = pct(total);
  return { month: ym, days: days.length, from: first, to: last, rows: out, total };
}

// ---- workshops at a glance (head office) -------------------------------------------------------

const NOT_GENERAL = "COALESCE(j.legacy_ref, '') NOT LIKE 'general-workshop%'";
const MRN_INFLOW = "m.requested_by IS NOT NULL AND TRIM(m.requested_by) <> ''";
const OUTSTANDING = `EXISTS (SELECT 1 FROM mrn m JOIN mrn_lines ml ON ml.mrn_id = m.id
                              WHERE m.job_id = j.id AND COALESCE(ml.qty_received,0) < ml.qty
                                AND COALESCE(m.approval_status,'requested') <> 'rejected' AND m.status <> 'cancelled')`;

function presentToday(ws) {
  const att = require('./attendance');
  const t = att.today();
  if (att.isEnabled()) {
    const d = att.day(t, { ws, split: true });
    return { mode: 'attendance', rows: d.rows.filter((r) => r.attendance && ['present', 'half_day'].includes(r.attendance.status))
      .map((r) => ({ name: r.name, detail: r.attendance.status === 'half_day' ? 'half day' : 'present' })) };
  }
  return { mode: 'daily_work', rows: all(`SELECT dw.mechanic AS name, ROUND(SUM(dw.hours),2) AS hours
                                             FROM job_daily_work dw JOIN job_cards j ON j.id = dw.job_id
                                            WHERE dw.work_date = ? AND j.workshop_id = ? AND COALESCE(dw.is_external,0) = 0
                                              AND COALESCE(TRIM(dw.mechanic),'') <> ''
                                            GROUP BY dw.mechanic ORDER BY dw.mechanic`, t, ws)
    .map((r) => ({ name: r.name, detail: `${r.hours} h booked` })) };
}

/** The list behind one number on the glance board. */
function glanceList(ws, what) {
  const JOB = `SELECT j.id, j.job_no, j.status, j.description, substr(COALESCE(j.reported_at, j.requested_at),1,10) AS since,
                      j.field, j.working_at, a.code AS asset_code, a.registration AS asset_reg
                 FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id`;
  switch (what) {
    case 'open':
      return all(`${JOB} WHERE j.workshop_id = ? AND ${jobstate.openSql('j')} AND ${NOT_GENERAL} ORDER BY j.id DESC`, ws);
    case 'down':
      return all(`${JOB} WHERE j.workshop_id = ? AND j.type = 'repair' AND j.asset_id IS NOT NULL AND ${jobstate.notFinalSql('j')}
                    AND COALESCE(j.is_historical, 0) = 0 ORDER BY j.id DESC`, ws).filter(holdsNow);
    case 'parts':
      return all(`${JOB} WHERE j.workshop_id = ? AND ${jobstate.openSql('j')} AND ${OUTSTANDING} ORDER BY j.id DESC`, ws);
    case 'approvals':
      return [
        ...all(`SELECT m.id, m.mrn_no AS ref, 'Material request' AS kind, m.approval_status AS status, m.req_date AS since, a.code AS asset_code
                  FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id
                 WHERE m.workshop_id = ? AND m.approval_status IN ('requested','certified') AND ${MRN_INFLOW} ORDER BY m.id DESC`, ws),
        ...all(`SELECT r.id, r.jr_no AS ref, 'Job request' AS kind, r.approval_status AS status, r.req_date AS since, a.code AS asset_code
                  FROM job_requests r LEFT JOIN assets a ON a.id = r.asset_id
                 WHERE r.workshop_id = ? AND r.approval_status IN ('requested','certified') ORDER BY r.id DESC`, ws),
      ];
    case 'present':
      return presentToday(ws).rows;
    case 'signoff': {
      const att = require('./attendance');
      return att.isEnabled() ? att.unsignedDays({ ws }) : [];
    }
    default:
      return fail(404, 'Unknown list');
  }
}

/** Workshops at a glance: one row per workshop, today's numbers and the month's cost so far. */
async function glance() {
  const att = require('./attendance');
  const now = today();
  const [y, m] = now.slice(0, 7).split('-').map(Number);
  const cost = new Map((await require('./monthly_cost_report').compare(y, m)).map((r) => [r.workshop_id, r.total]));
  const rows = all('SELECT id, code, name FROM workshops WHERE active = 1 ORDER BY is_default DESC, name').map((w) => {
    const n = (what) => glanceList(w.id, what).length;
    const present = presentToday(w.id);
    return {
      workshop_id: w.id, code: w.code, name: w.name,
      open_jobs: n('open'), machines_down: n('down'), waiting_parts: n('parts'), approvals: n('approvals'),
      present: present.rows.length, present_mode: present.mode,
      unsigned_days: att.isEnabled() ? n('signoff') : null,
      cost_month: cost.has(w.id) ? cost.get(w.id) : null,
    };
  });
  return { date: now, month: now.slice(0, 7), attendance: att.isEnabled(), rows };
}

// ---- job handovers -----------------------------------------------------------------------------

/** Check the reason for sending a card to another workshop (S7-D6). */
function handoverReason(body) {
  const reason = clean(body.workshop_reason, 300);
  if (reason.length < 3) fail(400, 'Say why the job goes to another workshop.');
  return reason;
}

/** Keep the move of a card to another workshop — inside the caller's transaction. */
function recordHandover(actor, jobId, fromWs, toWs, reason) {
  return run('INSERT INTO job_workshop_moves (job_id, from_workshop_id, to_workshop_id, reason, moved_by) VALUES (?, ?, ?, ?, ?)',
    jobId, fromWs || null, toWs, reason, actor.id).lastInsertRowid;
}

const HANDOVER = `SELECT h.id, h.job_id, h.reason, h.moved_at, h.from_workshop_id, h.to_workshop_id,
                         wf.name AS from_name, wt.name AS to_name, COALESCE(u.full_name, u.username) AS moved_by,
                         j.job_no, j.workshop_id, a.code AS asset_code
                    FROM job_workshop_moves h
                    JOIN job_cards j ON j.id = h.job_id
                    LEFT JOIN workshops wf ON wf.id = h.from_workshop_id
                    LEFT JOIN workshops wt ON wt.id = h.to_workshop_id
                    LEFT JOIN users u ON u.id = h.moved_by
                    LEFT JOIN assets a ON a.id = j.asset_id`;

/** One card's handovers, oldest first. */
const jobHandovers = (jobId) => all(`${HANDOVER} WHERE h.job_id = ? ORDER BY h.moved_at, h.id`, jobId);

/**
 * Recent handovers seen from this person's workshops: sent from them or to them (head office: all).
 * A card now at a workshop out of reach shows its number and where it went, but no link.
 */
function handovers(user, days = 90) {
  const scope = require('./scope');
  const r = scope.reach(user);
  const since = addDays(today(), -Math.max(1, Math.min(365, Number(days) || 90)));
  const ids = r == null ? null : r.map(Number);
  return all(`${HANDOVER} WHERE date(h.moved_at) >= ? ORDER BY h.moved_at DESC, h.id DESC`, since)
    .filter((h) => ids == null || ids.includes(h.from_workshop_id) || ids.includes(h.to_workshop_id))
    .map((h) => ({ ...h, reachable: scope.mayReach(user, h.workshop_id) }));
}

module.exports = {
  today, keyOf, labelOf, placeOf, history, moveMachine, recordEdit, placeOn, downSpan, holdsNow,
  fleet, glance, glanceList, handoverReason, recordHandover, jobHandovers, handovers, HOLDING,
};
