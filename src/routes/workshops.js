'use strict';

// Workshops (multi-site Stage 2, src/lib/workshops.js).
//
//   GET   /                        the list, whether there is more than one, and your home workshop
//   POST  /                        add a workshop                       (workshops.manage)
//   PATCH /:id                     rename, change code/place, retire, reinstate (workshops.manage)
//   GET   /mechanics               every mechanic with their workshop today
//   GET   /mechanics/:id/history   a mechanic's workshops over time
//   POST  /mechanics/:id/move      move a mechanic from a date           (mechanics.move)
//   PUT   /separate                "Separate workshops" on or off (Stage 3) (workshops.manage)
//   PUT   /:id/store               own store, or whose store it uses (Stage 4) (workshops.manage)
//
// A person's home workshop is set on Users & Roles (routes/users.js).

const express = require('express');
const { all } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const workshops = require('../lib/workshops');
const stores = require('../lib/stores');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler((req, res) => {
  const scope = require('../lib/scope');
  res.json({ workshops: workshops.list(), multi: workshops.isMulti(), default_id: workshops.defaultId(),
    mine: workshops.homeOf(req.user),
    // Stage 3: the switch, whether it is in force (on AND 2+ workshops), and whether you see them all.
    separate: scope.switchedOn(), separate_in_force: scope.enabled(), sees_all: scope.seesAllJobs(req.user),
    // Stage 4: the stores (a workshop with its own), and the one each workshop uses today.
    stores: stores.list(), stores_multi: stores.isMulti(),
    store_of: Object.fromEntries(workshops.list().map((w) => [w.id, stores.storeOf(w.id)])) });
}));

// Stage 4: open a workshop's own store (from a date), close it, or choose whose store it uses.
router.put('/:id/store', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const b = req.body || {};
  res.json(stores.setStore(req.user, toInt(req.params.id), { own: b.own, uses: b.uses, opened: b.opened }));
}));

router.put('/separate', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const scope = require('../lib/scope');
  scope.setSwitch(req.user, !!(req.body && req.body.on));
  res.json({ separate: scope.switchedOn(), separate_in_force: scope.enabled() });
}));

router.post('/', requireCap('workshops.manage'), asyncHandler((req, res) => {
  res.status(201).json(workshops.create(req.user, req.body || {}));
}));

router.patch('/:id', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const b = req.body || {};
  let w = workshops.byId(id);
  if (!w) return res.status(404).json({ error: 'No such workshop' });
  if (b.code !== undefined || b.name !== undefined || b.place !== undefined) w = workshops.update(req.user, id, b);
  if (b.active !== undefined) w = workshops.setActive(req.user, id, !!b.active);
  res.json(w);
}));

router.get('/mechanics', asyncHandler((_req, res) => {
  res.json(all(`SELECT m.id, m.name, COALESCE(m.active, 1) AS active, ${workshops.mechanicWorkshopSql('m')} AS workshop_id,
      (SELECT MAX(from_date) FROM mechanic_workshops mw WHERE mw.mechanic_id = m.id AND mw.from_date > '2000-01-01') AS last_move
    FROM mechanics m ORDER BY COALESCE(m.active, 1) DESC, m.name`));
}));

router.get('/mechanics/:id/history', asyncHandler((req, res) => res.json(workshops.mechanicHistory(toInt(req.params.id)))));

router.post('/mechanics/:id/move', requireCap('mechanics.move'), asyncHandler((req, res) => {
  require_(req.body, ['workshop_id']);
  res.json(workshops.moveMechanic(req.user, toInt(req.params.id), req.body.workshop_id, req.body.from_date, req.body.note));
}));

module.exports = router;
