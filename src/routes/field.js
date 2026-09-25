'use strict';

// Field work (multi-site Stage 6, src/lib/field.js).
//
//   GET   /board                 open field jobs, the machines still down first     (Job Cards view)
//   GET   /month?month=          a month of field work, per job and per site         (Job Cards view)
//   GET   /places                the projects and sites a field job can be at        (Job Cards view)
//   GET   /settings              the rate per km for the field vehicle               (Job Cards view)
//   PUT   /settings              change it                                           jobs.settings
//   POST  /breakdown             report a breakdown: opens a field job card now      jobs.breakdown
//   GET   /jobs/:id              one card's field side                               (Job Cards view)
//   PATCH /jobs/:id              in the field or not, site, times, km                jobs.field
//   POST  /jobs/:id/arrived      the mechanic arrived — now                          jobs.field
//   POST  /jobs/:id/working      the machine is working again — now                  jobs.field
//
// Mounted outside the Job Cards section gate, like attendance: reading needs Job Cards view; each
// write is decided by its capability — so an assistant transport manager, who only views job cards,
// can still report a breakdown. With the workshops kept apart, a card of another workshop is out of
// reach (Stage 3).

const express = require('express');
const { get } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const permissions = require('../lib/permissions');
const scope = require('../lib/scope');
const field = require('../lib/field');
const emitter = require('../lib/emitter');

const router = express.Router();

// The Field Work page (its board, month and settings) needs Field Work. A card's field details, the
// place list and reporting a breakdown are also reached from the job card, so Job Cards will do.
const FIELD_PAGE = new Set(['/board', '/month', '/settings']);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const keys = FIELD_PAGE.has(req.path) ? ['field'] : ['field', 'jobs'];
  if (permissions.reaches(req.user, keys)) return next();
  return res.status(403).json({ error: `Your role has no view access to ${keys.join(' or ')}` });
});
router.param('id', scope.jobParam);

router.get('/board', asyncHandler((req, res) => res.json(field.board(req.user))));

router.get('/month', asyncHandler((req, res) => {
  const ym = String(req.query.month || field.nowStamp().slice(0, 7)).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'A valid ?month=YYYY-MM is required' });
  res.json(field.month(ym, scope.reportWorkshop(req.user, req.query.workshop_id).ws));
}));

// The projects and sites a field job can be at (the Stage 2 places list, without the workshops).
router.get('/places', asyncHandler((_req, res) => res.json(require('../lib/places').list().filter((p) => p.kind !== 'workshop'))));

router.get('/settings', asyncHandler((_req, res) => res.json(field.settings())));
router.put('/settings', requireCap('jobs.settings'), asyncHandler((req, res) => res.json(field.saveSettings(req.user, req.body || {}))));

router.post('/breakdown', requireCap('jobs.breakdown'), asyncHandler((req, res) => {
  const job = field.reportBreakdown(req.user, req.body || {});
  emitter.emit('job_updated', { job_id: job.id, action: 'create' });
  emitter.emit('dashboard_refresh', { reason: 'breakdown' });
  res.status(201).json({ job, field: field.view(job) });
}));

router.get('/jobs/:id', asyncHandler((req, res) => {
  const job = get('SELECT * FROM job_cards WHERE id = ?', toInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(field.view(job));
}));

router.patch('/jobs/:id', requireCap('jobs.field'), asyncHandler((req, res) => {
  const out = field.update(req.user, toInt(req.params.id), req.body || {});
  emitter.emit('job_updated', { job_id: toInt(req.params.id), action: 'field' });
  res.json(out);
}));

router.post('/jobs/:id/:step(arrived|working)', requireCap('jobs.field'), asyncHandler((req, res) => {
  const out = field.stamp(req.user, toInt(req.params.id), req.params.step);
  emitter.emit('job_updated', { job_id: toInt(req.params.id), action: 'field' });
  emitter.emit('dashboard_refresh', { reason: 'field' });
  res.json(out);
}));

module.exports = router;
