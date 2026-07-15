'use strict';

const express = require('express');
const { get, all, run } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');

const router = express.Router();

router.get('/', asyncHandler((req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.resolved !== undefined) { clauses.push('al.resolved = ?'); params.push(toInt(req.query.resolved)); }
  if (req.query.q) { clauses.push('al.raw_text LIKE ?'); params.push('%' + req.query.q + '%'); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(all(
    `SELECT al.*, a.code AS asset_code FROM asset_aliases al
       LEFT JOIN assets a ON a.id = al.asset_id
       ${where}
      ORDER BY al.resolved ASC, al.hit_count DESC, al.updated_at DESC
      LIMIT ${toInt(req.query.limit, 500)}`,
    ...params
  ));
}));

router.get('/pending', asyncHandler((_req, res) => res.json(aliases.pendingAliases())));

router.post('/resolve', asyncHandler((req, res) => {
  require_(req.body, ['text']);
  const r = aliases.resolveAsset(req.body.text, { source: 'preview' });
  const asset = r.assetId ? get('SELECT * FROM assets WHERE id = ?', r.assetId) : null;
  res.json({ ...r, asset });
}));

router.post('/:id/link', requireRole('storekeeper'), asyncHandler((req, res) => {
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

router.delete('/:id', requireRole('storekeeper'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  run('DELETE FROM asset_aliases WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset_alias', entityId: id, action: 'delete' });
  res.json({ ok: true });
}));

module.exports = router;
