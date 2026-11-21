'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireCap } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const aliases = require('../lib/aliases');

const router = express.Router();

function bigrams(str) {
  const s = String(str || '');
  if (s.length < 2) return [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  if (!bgA.length || !bgB.length) return 0;
  const counts = new Map();
  for (const g of bgA) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of bgB) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (bgA.length + bgB.length);
}

function digitsSuffix(str) {
  const m = String(str || '').match(/(\d{4,})$/);
  return m ? m[1] : '';
}

function scoreAliasCandidate(rawNorm, extractedNorm, rawDigits, asset) {
  const keys = [
    aliases.normalize(asset.code_norm || asset.code),
    aliases.normalize(asset.registration),
    aliases.normalize(asset.ec_code),
  ].filter(Boolean);
  if (!keys.length) return null;

  let bestScore = 0;
  let bestReason = '';

  for (const k of keys) {
    if (k === rawNorm || (extractedNorm && k === extractedNorm)) {
      return { score: 98, reason: 'exact_norm_or_token' };
    }
    const assetDigits = digitsSuffix(k);
    if (rawDigits && assetDigits && rawDigits === assetDigits) {
      if (85 > bestScore) { bestScore = 85; bestReason = 'numeric_suffix_match'; }
    }
    if (k.length >= 4 && rawNorm.length >= 4 && (rawNorm.includes(k) || k.includes(rawNorm))) {
      if (75 > bestScore) { bestScore = 75; bestReason = 'substring_match'; }
    }
    const sim = Math.round(diceSimilarity(rawNorm, k) * 70);
    if (sim > bestScore) { bestScore = sim; bestReason = 'fuzzy_similarity'; }
    if (extractedNorm && extractedNorm.length >= 4) {
      const simEx = Math.round(diceSimilarity(extractedNorm, k) * 70);
      if (simEx > bestScore) { bestScore = simEx; bestReason = 'extracted_fuzzy_similarity'; }
    }
  }

  return bestScore > 0 ? { score: bestScore, reason: bestReason } : null;
}

router.get('/', requireCap('aliases.view'), asyncHandler((req, res) => {
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

router.get('/pending', requireCap('aliases.view'), asyncHandler((_req, res) => res.json(aliases.pendingAliases())));

router.get('/suggestions', requireCap('aliases.view'), asyncHandler((req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit, 100), 1), 300);
  const minScore = Math.min(Math.max(toInt(req.query.min_score, 50), 1), 100);
  const pending = all(
    `SELECT * FROM asset_aliases
      WHERE resolved = 0
      ORDER BY hit_count DESC, updated_at DESC
      LIMIT ?`,
    limit
  );
  const assets = all(
    `SELECT id, code, code_norm, registration, ec_code, brand, type, status
       FROM assets
      ORDER BY (UPPER(COALESCE(status, 'ACTIVE')) = 'ACTIVE') DESC, id ASC`
  );

  const items = pending.map((al) => {
    const rawNorm = aliases.normalize(al.raw_norm || al.raw_text);
    const extracted = aliases.extractCode(al.raw_text);
    const extractedNorm = extracted ? aliases.normalize(extracted) : '';
    const rawDigits = digitsSuffix(rawNorm);

    const candidates = [];
    for (const asset of assets) {
      const scored = scoreAliasCandidate(rawNorm, extractedNorm, rawDigits, asset);
      if (scored && scored.score >= minScore) {
        candidates.push({
          asset_id: asset.id,
          code: asset.code,
          registration: asset.registration,
          ec_code: asset.ec_code,
          type: asset.type,
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.asset_id - b.asset_id);
    return {
      alias_id: al.id,
      raw_text: al.raw_text,
      raw_norm: al.raw_norm,
      hit_count: al.hit_count,
      source: al.source,
      suggestions: candidates.slice(0, 3),
    };
  });

  res.json({ count: items.length, items });
}));

router.get('/sections-audit', requireCap('aliases.view'), asyncHandler((req, res) => res.json(aliases.getMissingAllocations(req.user))));

router.post('/resolve', requireCap('aliases.vehicle.resolve', 'aliases.mechanic.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['text']);
  const r = aliases.resolveAsset(req.body.text, { source: 'preview' });
  const asset = r.assetId ? get('SELECT * FROM assets WHERE id = ?', r.assetId) : null;
  res.json({ ...r, asset });
}));

router.post('/bulk-link', requireCap('aliases.vehicle.resolve'), asyncHandler((req, res) => {
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : null;
  if (!links || !links.length) {
    return res.status(400).json({ error: 'links must be a non-empty array of { alias_id, asset_id }' });
  }
  if (links.length > 200) {
    return res.status(400).json({ error: 'Cannot bulk-link more than 200 aliases per request' });
  }

  const linked = [];
  const skipped = [];

  tx(() => {
    for (const entry of links) {
      const aliasId = toInt(entry && (entry.alias_id !== undefined ? entry.alias_id : entry.id));
      const assetId = toInt(entry && entry.asset_id);
      if (!aliasId || !assetId) {
        skipped.push({ alias_id: aliasId || null, asset_id: assetId || null, reason: 'missing_alias_or_asset_id' });
        continue;
      }
      const before = get('SELECT * FROM asset_aliases WHERE id = ?', aliasId);
      if (!before) {
        skipped.push({ alias_id: aliasId, asset_id: assetId, reason: 'alias_not_found' });
        continue;
      }
      const asset = get('SELECT id, code FROM assets WHERE id = ?', assetId);
      if (!asset) {
        skipped.push({ alias_id: aliasId, asset_id: assetId, reason: 'asset_not_found' });
        continue;
      }
      const after = aliases.linkAlias(aliasId, asset.id);
      audit.record({
        userId: req.user.id,
        entity: 'asset_alias',
        entityId: aliasId,
        action: 'bulk_link',
        before,
        after,
      });
      linked.push(after);
    }
  });

  res.json({
    ok: true,
    linked_count: linked.length,
    skipped_count: skipped.length,
    linked,
    skipped,
  });
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

router.post('/allocate-job', requireCap('aliases.allocate', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
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

router.post('/allocate-service', requireCap('aliases.allocate', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
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

router.post('/allocate-issue', requireCap('aliases.allocate', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
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

router.post('/allocate-mrn', requireCap('aliases.allocate', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
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

router.post('/allocate-job-request', requireCap('aliases.allocate', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
  require_(req.body, ['job_request_id', 'asset_id']);
  const jrId = toInt(req.body.job_request_id);
  const assetId = toInt(req.body.asset_id);
  const jr = get('SELECT * FROM job_requests WHERE id = ?', jrId);
  if (!jr) return res.status(404).json({ error: 'Job request not found' });
  const asset = get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  run('UPDATE job_requests SET asset_id = ? WHERE id = ?', asset.id, jrId);
  if (jr.job_id) {
    run('UPDATE job_cards SET asset_id = ? WHERE id = ? AND asset_id IS NULL', asset.id, jr.job_id);
  }
  audit.record({ userId: req.user.id, entity: 'job_request', entityId: jrId, action: 'allocate_vehicle', before: { asset_id: jr.asset_id }, after: { asset_id: asset.id } });
  res.json({ ok: true, job_request_id: jrId, asset_id: asset.id });
}));

router.delete('/:id', requireCap('aliases.ignore', 'aliases.vehicle.resolve'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  run('DELETE FROM asset_aliases WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'asset_alias', entityId: id, action: 'delete' });
  res.json({ ok: true });
}));

module.exports = router;
