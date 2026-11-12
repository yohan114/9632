'use strict';

// Opening a job card now takes four steps, because a card may only be opened against a job request
// that has been through all three signatures:
//
//   raise (Transport Assistant Manager) → certify (Transport Manager) → approve (Operational
//   Manager) → the WORKSHOP opens the card
//
// Most tests only want "a card exists for this vehicle" and do not care how it got there, so this
// walks the four steps for them. The tests that are ABOUT the gate (test/jobcard_from_request.js,
// test/one_open_job.js) call the routes themselves instead — a helper that hid a step would hide
// what they are checking.
//
// `post(path, body)` is the caller's own request function, narrowed to a POST that returns
// `{ status, body }`. It must be signed in as somebody holding every capability (the tests' admin),
// since one person here plays all four parts; where segregation of duties is the point, the test
// signs each step itself.

/** Raise a job request and take it to `approved`. Returns the request row. */
async function approvedRequest(post, fields = {}) {
  const made = await post('/api/job-requests', { description: 'new fault', ...fields });
  if (made.status !== 201) throw new Error(`job request not raised (${made.status}): ${JSON.stringify(made.body)}`);
  const id = made.body.request.id;
  const cert = await post(`/api/job-requests/${id}/certify`, {});
  if (cert.status !== 200) throw new Error(`job request not certified (${cert.status}): ${JSON.stringify(cert.body)}`);
  const app = await post(`/api/job-requests/${id}/approve`, {});
  if (app.status !== 200) throw new Error(`job request not approved (${app.status}): ${JSON.stringify(app.body)}`);
  return app.body.request;
}

/**
 * The whole way: an approved request, then the card opened against it. `card` carries what is the
 * WORKSHOP's to choose (workshop_id, site, ref, note, take_in); everything else — the vehicle, the
 * work, the type, the severity, the project — belongs to the request and is passed in `fields`.
 * Returns the raw `{ status, body }` of the card creation, so a caller can assert on it.
 *
 * `openWith` opens the card as somebody else — which is the real division of labour, since the
 * workshop may READ job requests but not raise them. Where the test does not care who did what,
 * one admin plays both parts.
 */
async function openJobCard(post, fields = {}, card = {}, openWith = null) {
  const jr = await approvedRequest(post, fields);
  return (openWith || post)('/api/jobs', { job_request_id: jr.id, ...card });
}

/** The same, but throws unless the card was opened, and returns the card itself. */
async function jobCard(post, fields = {}, card = {}, openWith = null) {
  const r = await openJobCard(post, fields, card, openWith);
  if (r.status !== 201) throw new Error(`job card not opened (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.job;
}

module.exports = { approvedRequest, openJobCard, jobCard };
