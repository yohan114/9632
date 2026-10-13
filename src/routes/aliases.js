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
    source: req.query.section || req.query.source,
    q: req.query.q,
    limit: toInt(req.query.limit, 500),
  }));
}));

router.get('/pending', asyncHandler((_req, res) => res.json(aliases.pendingAliases())));

router.get('/sections-audit', asyncHandler((_req, res) => res.json(aliases.getMissingAllocations())));

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

router.post('/allocate-job', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['job_id', 'asset_id']);
  const jobId = toInt(req.body.job_id);
  const assetId = toInt(req.body.asset_id);
  const job = get('SELECT * FROM job_cards WHERE id = ?', jobId);
  if (!job) return res.status(404).json({ error: 'Job card not found' });
  const asset = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  run('UPDATE job_cards SET asset_id = ?, updated_at = datetime("now") WHERE id = ?', asset.id, jobId);
  run('UPDATE issues SET asset_id = ? WHERE job_id = ? AND asset_id IS NULL', asset.id, jobId);
  run('UPDATE stock_moves SET asset_id = ? WHERE job_id = ? AND asset_id IS NULL', asset.id, jobId);

  audit.record({ userId: req.user.id, entity: 'job_card', entityId: jobId, action: 'allocate_vehicle', before: { asset_id: job.asset_id }, after: { asset_id: asset.id } });
  res.json({ ok: true, job_id: jobId, asset_id: asset.id });
}));

router.post('/allocate-service', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['service_id', 'asset_id']);
  const serviceId = toInt(req.body.service_id);
  const assetId = toInt(req.body.asset_id);
  const svc = get('SELECT * FROM service_jobs WHERE id = ?', serviceId);
  if (!svc) return res.status(404).json({ error: 'Service job not found' });
  const asset = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  run('UPDATE service_jobs SET asset_id = ? WHERE id = ?', asset.id, serviceId);
  audit.record({ userId: req.user.id, entity: 'service_job', entityId: serviceId, action: 'allocate_vehicle', before: { asset_id: svc.asset_id }, after: { asset_id: asset.id } });
  res.json({ ok: true, service_id: serviceId, asset_id: asset.id });
}));

router.post('/allocate-issue', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['issue_id', 'asset_id']);
  const issueId = toInt(req.body.issue_id);
  const assetId = toInt(req.body.asset_id);
  const issue = get('SELECT * FROM issues WHERE id = ?', issueId);
  if (!issue) return res.status(404).json({ error: 'Issue record not found' });
  const asset = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  run('UPDATE issues SET asset_id = ? WHERE id = ?', asset.id, issueId);
  run('UPDATE stock_moves SET asset_id = ? WHERE source_table = "issues" AND source_id = ?', asset.id, issueId);
  audit.record({ userId: req.user.id, entity: 'issue', entityId: issueId, action: 'allocate_vehicle', before: { asset_id: issue.asset_id }, after: { asset_id: asset.id } });
  res.json({ ok: true, issue_id: issueId, asset_id: asset.id });
}));

router.post('/allocate-mrn', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['mrn_id', 'asset_id']);
  const mrnId = toInt(req.body.mrn_id);
  const assetId = toInt(req.body.asset_id);
  const mrnRow = get('SELECT * FROM mrn WHERE id = ?', mrnId);
  if (!mrnRow) return res.status(404).json({ error: 'MRN not found' });
  const asset = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  run('UPDATE mrn SET asset_id = ? WHERE id = ?', asset.id, mrnId);
  audit.record({ userId: req.user.id, entity: 'mrn', entityId: mrnId, action: 'allocate_vehicle', before: { asset_id: mrnRow.asset_id }, after: { asset_id: asset.id } });
  res.json({ ok: true, mrn_id: mrnId, asset_id: asset.id });
}));

router.delete('/:id', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  run('DELETE FROM asset_aliases WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset_alias', entityId: id, action: 'delete' });
  res.json({ ok: true });
}));

module.exports = router;
