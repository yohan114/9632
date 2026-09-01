'use strict';

// The Service Planner's answer, fetched rather than re-derived.
//
// The planner (the fuel system, :3300) is the only system that knows what a machine has
// actually RUN: recorded meter growth, and hours/km derived from the fuel issued to it. It
// calls a machine due on the higher of the two, against its interval — 500 hr for machinery,
// 5,000 km for road vehicles.
//
// WorkshopOne has neither meter nor fuel data. Judging "due" from service DATES alone reads a
// machine that has barely moved in five months as overdue, which is why the two screens
// disagreed: the planner had 33 overdue and 425 OK where a date rule found 46 and 118. So the
// states come from there, and WorkshopOne adds the one thing it knows better — which filters
// each machine actually takes.
//
// If the planner is unreachable the caller falls back to WorkshopOne's own date estimate and
// says so on screen; it never silently presents a guess as the planner's answer.

const config = require('../config');

const TIMEOUT_MS = 8000;
// Machine identity across the two systems is the E&C code ("DC-11", "HEX-21"), which both
// hold — WorkshopOne on assets.code / assets.ec_code, the planner on Asset.code.
const codeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * @param {object} opts
 * @param {string} [opts.asOf]   'YYYY-MM-DD' — the planner computes as at this date.
 * @param {string} [opts.state]  e.g. 'OVERDUE,DUE_SOON' to fetch only the working list.
 * @returns {Promise<{ok: boolean, reason?: string, asOf?: string, counts?: object, machines?: object[]}>}
 */
async function fetchServiceStatus({ asOf, state } = {}) {
  if (!config.servicePlannerToken) {
    return { ok: false, reason: 'no SERVICE_PLANNER_TOKEN configured — set it to read the planner' };
  }
  const url = new URL('/api/portal/service', config.servicePlannerUrl);
  if (asOf) url.searchParams.set('asOf', asOf);
  if (state) url.searchParams.set('state', state);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'x-portal-token': config.servicePlannerToken },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `service planner returned ${res.status}${res.status === 401 ? ' — the token does not match' : ''}` };
    }
    const body = await res.json();
    const machines = (body.machines || []).map((m) => ({ ...m, code_key: codeKey(m.code) }));
    return { ok: true, asOf: body.asOf, generated_at: body.generatedAt, counts: body.counts || {}, machines };
  } catch (e) {
    const why = e.name === 'AbortError' ? 'timed out' : e.message;
    return { ok: false, reason: `service planner not reachable at ${config.servicePlannerUrl} (${why})` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchServiceStatus, codeKey };
