'use strict';

const express = require('express');
const { get, all, run } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');

const router = express.Router();

router.get('/', asyncHandler((req, res) => {
  res.json(aliases.queryAliasQueue({
    table: 'asset_aliases',
    targetTable: 'assets',
    targetIdCol: 'asset_id',
    targetNameCol: 'code',
    targetAlias: 'asset_code',
    resolved: req.query.resolved,
    q: req.query.q,
    limit: toInt(req.query.limit, 500),
  }));
}));

router.get('/pending', asyncHandler((_req, res) => res.json(aliases.pendingAliases())));

router.post('/resolve', asyncHandler((req, res) => {
  require_(req.body, ['text']);
  const r = aliases.resolveAsset(req.body.text, { source: 'preview' });
  const asset = r.assetId ? get('SELECT * FROM assets WHERE id = ?', r.assetId) : null;
  res.json({ ...r, asset });
}));

router.post('/:id/link', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['asset_id']);
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM asset_aliases WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Alias not found' });
  const asset = get('SELECT id FROM assets WHERE id = ?', toInt(req.body.asset_id));
  if (!asset) return res.status(400).json({ error: 'Target asset does not exist' });
  const updated = aliases.linkAlias(id, asset.id);
  audit.record({ userId: req.user.id, entity: 'asset_alias', entityId: id, action: 'link', before, after: updated });
  res.json(updated);
}));

router.delete('/:id', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  run('DELETE FROM asset_aliases WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset_alias', entityId: id, action: 'delete' });
  res.json({ ok: true });
}));

module.exports = router;
