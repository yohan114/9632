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
const audit = require('../lib/audit');

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
  const id = toInt(req.params.id);
  const b = req.body || {};
  const out = stores.setStore(req.user, id, { own: b.own, uses: b.uses, opened: b.opened });
  audit.record({ userId: req.user.id, entity: 'workshop_store', entityId: id, action: 'update', after: { own: b.own, uses: b.uses, opened: b.opened } });
  res.json(out);
}));

router.put('/separate', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const scope = require('../lib/scope');
  const on = !!(req.body && req.body.on);
  scope.setSwitch(req.user, on);
  audit.record({ userId: req.user.id, entity: 'workshops_separate', action: 'update', after: { on } });
  res.json({ separate: scope.switchedOn(), separate_in_force: scope.enabled() });
}));

router.post('/', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const created = workshops.create(req.user, req.body || {});
  audit.record({ userId: req.user.id, entity: 'workshop', entityId: created.id, action: 'create', after: created });
  res.status(201).json(created);
}));

router.patch('/:id', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const b = req.body || {};
  let w = workshops.byId(id);
  if (!w) return res.status(404).json({ error: 'No such workshop' });
  const before = { ...w };
  if (b.code !== undefined || b.name !== undefined || b.place !== undefined) w = workshops.update(req.user, id, b);
  if (b.active !== undefined) w = workshops.setActive(req.user, id, !!b.active);
  audit.record({ userId: req.user.id, entity: 'workshop', entityId: id, action: 'update', before, after: w });
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
  const mid = toInt(req.params.id);
  const out = workshops.moveMechanic(req.user, mid, req.body.workshop_id, req.body.from_date, req.body.note);
  audit.record({ userId: req.user.id, entity: 'mechanic_workshop', entityId: mid, action: 'move', after: { workshop_id: req.body.workshop_id, from_date: req.body.from_date } });
  res.json(out);
}));

// Multi-database management and Main Store Access (§5, §6, §8)
router.get('/databases', requireCap('workshops.manage'), asyncHandler((_req, res) => {
  const { multidb } = require('../db');
  res.json({
    multidb_enabled: multidb && typeof multidb.isMultiDb === 'function' ? multidb.isMultiDb() : false,
    databases: (multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()) ? multidb.listWorkshopDatabases() : []
  });
}));

router.post('/verify', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  if (!multidb || typeof multidb.isMultiDb !== 'function' || !multidb.isMultiDb()) return res.json({ ok: true, message: 'Single database mode' });
  const results = multidb.runIntegrityVerification();
  audit.record({ userId: req.user && req.user.id, entity: 'multidb_integrity', action: 'verify', after: { results } });
  res.json({ ok: true, results });
}));

router.get('/grants', requireCap('workshops.manage', 'workshops.all'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  res.json((multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()) ? multidb.listStoreGrants() : []);
}));

router.get('/:id/grants', requireCap('workshops.manage', 'workshops.all'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  res.json((multidb && typeof multidb.isMultiDb === 'function' && multidb.isMultiDb()) ? multidb.listStoreGrants(toInt(req.params.id)) : []);
}));

router.post('/:id/grants', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  if (!multidb || typeof multidb.isMultiDb !== 'function' || !multidb.isMultiDb()) return res.status(400).json({ error: 'Multi-database not enabled' });
  const grant = multidb.createStoreGrant(req.user, { ...req.body, workshop_id: toInt(req.params.id) });
  audit.record({ userId: req.user.id, entity: 'store_grant', entityId: grant && grant.id, action: 'create', after: grant });
  res.status(201).json(grant);
}));

router.put('/grants/:gid/approve', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  if (!multidb || typeof multidb.isMultiDb !== 'function' || !multidb.isMultiDb()) return res.status(400).json({ error: 'Multi-database not enabled' });
  try {
    const gid = toInt(req.params.gid);
    const approved = multidb.approveStoreGrant(req.user, gid);
    audit.record({ userId: req.user.id, entity: 'store_grant', entityId: gid, action: 'approve', after: approved });
    res.json(approved);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
}));

router.put('/grants/:gid/suspend', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  if (!multidb || typeof multidb.isMultiDb !== 'function' || !multidb.isMultiDb()) return res.status(400).json({ error: 'Multi-database not enabled' });
  const gid = toInt(req.params.gid);
  const suspended = multidb.updateStoreGrantState(req.user, gid, 'suspended', req.body && req.body.reason);
  audit.record({ userId: req.user.id, entity: 'store_grant', entityId: gid, action: 'suspend', reason: req.body && req.body.reason });
  res.json(suspended);
}));

router.put('/grants/:gid/revoke', requireCap('workshops.manage'), asyncHandler((req, res) => {
  const { multidb } = require('../db');
  if (!multidb || typeof multidb.isMultiDb !== 'function' || !multidb.isMultiDb()) return res.status(400).json({ error: 'Multi-database not enabled' });
  const gid = toInt(req.params.gid);
  const revoked = multidb.updateStoreGrantState(req.user, gid, 'revoked', req.body && req.body.reason);
  audit.record({ userId: req.user.id, entity: 'store_grant', entityId: gid, action: 'revoke', reason: req.body && req.body.reason });
  res.json(revoked);
}));

module.exports = router;
