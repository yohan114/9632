'use strict';

// Operations (multi-site Stage 7, src/lib/operations.js).
//
//   GET  /fleet?month=               the site fleet board and the month's availability   (Assets view)
//   GET  /places                     the projects and sites a machine can move to        (Assets view)
//   GET  /machines/:id/moves         one machine's moves                                 (Assets view)
//   POST /machines/:id/move          move a machine to another project or site           assets.move
//   GET  /glance                     workshops at a glance                               head office
//   GET  /glance/:ws/:what           the list behind one number                          head office
//   GET  /handovers?days=            job cards sent between workshops, yours             (Job Cards view)
//
// Mounted outside the section gates, like field work: each route checks what it needs itself — so
// head office reads the glance board whatever sections their role opens, and a transport manager
// may move a machine without edit rights on the whole register.

const express = require('express');
const { requireCap } = require('../lib/auth');
const { asyncHandler, toInt } = require('../lib/http');
const permissions = require('../lib/permissions');
const scope = require('../lib/scope');
const ops = require('../lib/operations');
const emitter = require('../lib/emitter');

const router = express.Router();

router.use((req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Authentication required' })));

const sees = (section) => (req, res, next) => {
  if (permissions.meets(permissions.levelForRoles(req.user.roles || [], section), 'view')) return next();
  return res.status(403).json({ error: `Your role has no view access to ${section}` });
};
const headOffice = (req, res, next) => (scope.headOffice(req.user) ? next()
  : res.status(403).json({ error: 'Only head office sees every workshop at a glance.' }));

router.get('/fleet', sees('assets'), asyncHandler((req, res) => {
  const ym = String(req.query.month || ops.today().slice(0, 7)).slice(0, 7);
  res.json(ops.fleet(req.user, ym));
}));

router.get('/places', sees('assets'), asyncHandler((_req, res) => res.json(require('../lib/places').list().filter((p) => p.kind !== 'workshop'))));

router.get('/machines/:id/moves', sees('assets'), asyncHandler((req, res) => res.json(ops.history(toInt(req.params.id)))));

router.post('/machines/:id/move', requireCap('assets.move'), asyncHandler((req, res) => {
  const out = ops.moveMachine(req.user, toInt(req.params.id), req.body || {});
  emitter.emit('dashboard_refresh', { reason: 'machine_move' });
  res.status(201).json(out);
}));

router.get('/glance', headOffice, asyncHandler(async (_req, res) => res.json(await ops.glance())));

router.get('/glance/:ws/:what', headOffice, asyncHandler((req, res) => {
  const ws = toInt(req.params.ws);
  if (!require('../lib/workshops').byId(ws)) return res.status(404).json({ error: 'Workshop not found' });
  res.json(ops.glanceList(ws, req.params.what));
}));

router.get('/handovers', sees('jobs'), asyncHandler((req, res) => res.json(ops.handovers(req.user, req.query.days))));

module.exports = router;
