'use strict';

// ===========================================================================
// Tyres and batteries as units, each known by its serial number (stores plan, Part 4).
//
// A battery has had its register for years (batteries, battery_events, battery_photos); a tyre now
// has the same (tyres, tyre_events, tyre_photos). Issuing one against its request FIXES it to the
// vehicle at that moment (ST-D6, D7): the serial is required, a tyre also names its wheel position,
// and the unit that was there comes off. What became of the old one — repaired, retreaded, reused,
// claimed on warranty, scrapped, or not returned with a reason (ST-D8) — moves it on in its register.
// A scrapped unit leaves on a disposal note (src/lib/disposal.js).
// ===========================================================================

const { get, all, run } = require('../db');

const TABLE = { tyre: 'tyres', battery: 'batteries' };
const LABEL = { tyre: 'Tyre', battery: 'Battery' };
const MAX_BATTERIES = 2;             // as src/routes/batteries.js: a heavy machine runs a pair

/** What an old unit becomes, by what the store decided about it. */
const AFTER_RETURN = {
  tyre: { repairable: 'repair', retreadable: 'retread', reusable: 'in_store', warranty: 'warranty', scrap: 'scrap', not_returned: 'lost' },
  battery: { repairable: 'in_store', retreadable: 'in_store', reusable: 'in_store', warranty: 'handed_over', scrap: 'scrap', not_returned: 'lost' },
};
/** States a unit cannot be fitted from. */
const FINISHED = ['scrap', 'lost', 'disposed', 'decommissioned'];

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const cleanSerial = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, 60);
const isUnitKind = (kind) => kind === 'tyre' || kind === 'battery';
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

const byId = (kind, id) => get(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`, id);
const bySerial = (kind, serial) => get(`SELECT * FROM ${TABLE[kind]} WHERE UPPER(serial_no) = UPPER(?)`, cleanSerial(serial));
const assetName = (id) => { const a = id && get('SELECT code, registration FROM assets WHERE id = ?', id); return a ? (a.code || a.registration) : 'another vehicle'; };

/** One line of a unit's story. Batteries keep theirs as before; a tyre's also knows the wheel. */
function event(kind, unitId, e) {
  if (kind === 'tyre') {
    run(`INSERT INTO tyre_events (tyre_id, event_type, from_asset_id, to_asset_id, position, km_reading, reason, issue_id, user_id, event_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, unitId, e.type, e.from || null, e.to || null, e.position || null,
    e.km == null ? null : e.km, e.reason || null, e.issueId || null, e.userId || null, e.date || today());
  } else {
    run(`INSERT INTO battery_events (battery_id, event_type, from_asset_id, to_asset_id, reason, user_id, event_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, unitId, e.type, e.from || null, e.to || null, e.reason || null, e.userId || null, e.date || today());
  }
}

/** The units a vehicle carries now (a tyre: at one wheel, when asked). */
function onVehicle(kind, assetId, position) {
  if (kind === 'tyre' && position) {
    return all('SELECT * FROM tyres WHERE current_asset_id = ? AND UPPER(position) = UPPER(?)', assetId, position);
  }
  return all(`SELECT * FROM ${TABLE[kind]} WHERE current_asset_id = ? ORDER BY ${kind === 'tyre' ? 'position, ' : ''}serial_no`, assetId);
}

/** Take a unit off the vehicle it is on. It waits, as 'removed', for the store to say what it is. */
function takeOff(kind, unit, { assetId, issueId, userId, date, km, reason } = {}) {
  if (unit && !unit.current_asset_id) fail(409, `${LABEL[kind]} ${unit.serial_no} is not on a vehicle.`);
  if (!unit || Number(unit.current_asset_id) !== Number(assetId)) {
    fail(409, `${LABEL[kind]} ${unit ? unit.serial_no : ''} is not on ${assetName(assetId)}.`);
  }
  run(`UPDATE ${TABLE[kind]} SET current_asset_id = NULL, state = 'removed'${kind === 'tyre' ? ', position = NULL' : ''} WHERE id = ?`, unit.id);
  event(kind, unit.id, { type: 'remove', from: assetId, position: unit.position, km, reason: reason || 'Taken off for a new one', issueId, userId, date });
  return unit.id;
}

/**
 * Fit a unit to a vehicle — the one with this serial from the register, or a new one. Refused when
 * it is on another vehicle, already finished with, or (a battery) the vehicle already has its pair.
 */
function fit(kind, { serial, specId, assetId, position, storeId, issueId, userId, date, km, reason }) {
  const s = cleanSerial(serial);
  if (!s) fail(400, kind === 'battery' ? 'Give the battery\'s serial number.' : 'Give the tyre\'s serial number.');
  if (kind === 'tyre' && !String(position || '').trim()) fail(400, `Give the wheel position of tyre ${s} (FL, FR, RL1 …).`);
  const pos = kind === 'tyre' ? String(position).trim().toUpperCase().slice(0, 12) : null;
  let unit = bySerial(kind, s);
  if (unit) {
    if (FINISHED.includes(unit.state)) fail(409, `${LABEL[kind]} ${unit.serial_no} is ${unit.state}. It cannot be fitted.`);
    if (unit.current_asset_id && Number(unit.current_asset_id) !== Number(assetId)) {
      fail(409, `${LABEL[kind]} ${unit.serial_no} is on ${assetName(unit.current_asset_id)}. Take it off there first.`);
    }
  }
  if (kind === 'battery') {
    const on = all('SELECT serial_no FROM batteries WHERE current_asset_id = ? AND id <> ?', assetId, unit ? unit.id : 0);
    if (on.length >= MAX_BATTERIES) {
      fail(409, `${assetName(assetId)} already has ${on.length} batteries (${on.map((b) => b.serial_no).join(', ')}). Say which one is coming off.`);
    }
  } else {
    const there = all('SELECT serial_no FROM tyres WHERE current_asset_id = ? AND UPPER(position) = ? AND id <> ?', assetId, pos, unit ? unit.id : 0);
    if (there.length) fail(409, `Tyre ${there[0].serial_no} is at ${pos} on ${assetName(assetId)}. Say it is coming off.`);
  }
  if (unit) {
    run(`UPDATE ${TABLE[kind]} SET current_asset_id = ?, state = 'installed', store_id = COALESCE(?, store_id), spec_id = COALESCE(spec_id, ?)
           ${kind === 'tyre' ? ', position = ?' : ''} WHERE id = ?`,
    ...[assetId, storeId || null, specId || null], ...(kind === 'tyre' ? [pos] : []), unit.id);
  } else {
    unit = { id: kind === 'tyre'
      ? run(`INSERT INTO tyres (serial_no, spec_id, state, current_asset_id, position, store_id) VALUES (?, ?, 'installed', ?, ?, ?)`,
        s, specId || null, assetId, pos, storeId || null).lastInsertRowid
      : run(`INSERT INTO batteries (serial_no, spec_id, condition, state, current_asset_id, store_id, purchase_date) VALUES (?, ?, 'new', 'installed', ?, ?, ?)`,
        s, specId || null, assetId, storeId || null, date || today()).lastInsertRowid };
    event(kind, unit.id, { type: 'add', to: assetId, reason: 'Added when issued', issueId, userId, date });
  }
  event(kind, unit.id, { type: 'install', to: assetId, position: pos, km, reason: reason || 'Issued', issueId, userId, date });
  return unit.id;
}

/** What became of an old unit (ST-D8): it moves on in its register. */
function settle(kind, unitId, condition, { userId, date, reason, storeId } = {}) {
  const unit = byId(kind, unitId);
  if (!unit) return null;
  const state = AFTER_RETURN[kind][condition];
  if (!state) fail(400, 'Say what became of the old one.');
  if (unit.current_asset_id) takeOff(kind, unit, { assetId: unit.current_asset_id, userId, date });
  run(`UPDATE ${TABLE[kind]} SET state = ?, store_id = COALESCE(?, store_id) WHERE id = ?`, state, storeId || null, unit.id);
  event(kind, unit.id, { type: condition === 'not_returned' ? 'lost' : condition, reason: reason || null, userId, date });
  return state;
}

/** A vehicle's tyres and batteries: what it carries now, and what has been fitted and taken off. */
function vehicle(assetId) {
  const asset = get('SELECT id, code, registration, ec_code FROM assets WHERE id = ?', assetId);
  if (!asset) fail(404, 'No such vehicle');
  const spec = (id) => (id ? (get('SELECT label FROM tb_specs WHERE id = ?', id) || {}).label : null);
  const lastFit = (kind, id) => get(`SELECT event_date FROM ${kind === 'tyre' ? 'tyre_events WHERE tyre_id' : 'battery_events WHERE battery_id'} = ?
                                       AND event_type = 'install' ORDER BY id DESC LIMIT 1`, id);
  const tyres = onVehicle('tyre', assetId).map((t) => ({ ...t, spec: spec(t.spec_id), fitted_on: (lastFit('tyre', t.id) || {}).event_date || null }));
  const batteries = onVehicle('battery', assetId).map((b) => ({ ...b, spec: spec(b.spec_id), fitted_on: (lastFit('battery', b.id) || {}).event_date || null }));
  const issues = all(
    `SELECT i.id, i.kind, i.issue_date, i.qty, i.category AS spec_label, i.serial_no, i.position, i.min_number AS mrn_no, i.source,
            r.condition AS old_condition, r.serial_no AS old_serial, r.exception_reason, r.return_date,
            CASE WHEN i.source = 'request' AND i.kind IN ('tyre','battery') AND r.id IS NULL THEN 1 ELSE 0 END AS old_due
       FROM tyre_battery_issues i LEFT JOIN tb_returns r ON r.issue_id = i.id
      WHERE i.asset_id = ? ORDER BY i.issue_date DESC, i.id DESC LIMIT 200`, assetId);
  return { asset, tyres, batteries, issues, old_due: issues.filter((i) => i.old_due).length };
}

module.exports = { TABLE, LABEL, AFTER_RETURN, FINISHED, isUnitKind, cleanSerial, byId, bySerial, onVehicle, fit, takeOff, settle, vehicle, event };
