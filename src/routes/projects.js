'use strict';

const express = require('express');
const { get, all, run } = require('../db');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_, toInt } = require('../lib/http');
const audit = require('../lib/audit');
const { sendXlsx } = require('../lib/export');

const router = express.Router();

router.get('/', asyncHandler((_req, res) => {
  res.json(all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM assets a WHERE a.current_project_id = p.id) AS asset_count,
            (SELECT COALESCE(SUM(j.total_cost),0) FROM job_cards j
              WHERE j.project_id = p.id AND strftime('%Y-%m', j.requested_at) = strftime('%Y-%m','now')) AS month_cost
       FROM projects p ORDER BY p.name`
  ));
}));

router.post('/', requireRole('manager'), asyncHandler((req, res) => {
  require_(req.body, ['name']);
  const info = run('INSERT INTO projects (code, name, location) VALUES (?, ?, ?)', req.body.code || null, req.body.name, req.body.location || null);
  audit.record({ userId: req.user.id, entity: 'project', entityId: info.lastInsertRowid, action: 'create' });
  res.status(201).json(get('SELECT * FROM projects WHERE id = ?', info.lastInsertRowid));
}));

router.get('/:id', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const project = get('SELECT * FROM projects WHERE id = ?', id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sites = all('SELECT * FROM sites WHERE project_id = ? ORDER BY name', id);
  const assets = all('SELECT id, code, brand, type, status FROM assets WHERE current_project_id = ? ORDER BY code', id);
  const cost = get(
    `SELECT COALESCE(SUM(labour_cost),0) labour, COALESCE(SUM(material_cost),0) material,
            COALESCE(SUM(oil_cost),0) oil, COALESCE(SUM(general_cost),0) general,
            COALESCE(SUM(external_cost),0) external, COALESCE(SUM(total_cost),0) total
       FROM job_cards WHERE project_id = ?`, id
  );
  res.json({ project, sites, assets, cost });
}));

router.patch('/:id', requireRole('manager'), asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const before = get('SELECT * FROM projects WHERE id = ?', id);
  if (!before) return res.status(404).json({ error: 'Project not found' });
  const sets = [];
  const params = [];
  for (const c of ['code', 'name', 'location', 'active']) {
    if (req.body[c] !== undefined) { sets.push(`${c} = ?`); params.push(req.body[c]); }
  }
  if (sets.length) run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  const after = get('SELECT * FROM projects WHERE id = ?', id);
  audit.record({ userId: req.user.id, entity: 'project', entityId: id, action: 'update', before, after });
  res.json(after);
}));

router.get('/:id/cost', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const rows = all(
    `SELECT strftime('%Y-%m', requested_at) AS month,
            COALESCE(SUM(labour_cost),0) labour, COALESCE(SUM(material_cost),0) material,
            COALESCE(SUM(oil_cost),0) oil, COALESCE(SUM(general_cost),0) general,
            COALESCE(SUM(external_cost),0) external, COALESCE(SUM(total_cost),0) total
       FROM job_cards WHERE project_id = ?
      GROUP BY month ORDER BY month`, id
  );
  if (req.query.format === 'xlsx') {
    return sendXlsx(res, 'project-cost.xlsx', [{
      name: 'By Month',
      columns: [
        { header: 'Month', key: 'month' }, { header: 'Labour', key: 'labour' },
        { header: 'Material', key: 'material' }, { header: 'Oil', key: 'oil' },
        { header: 'General', key: 'general' }, { header: 'External', key: 'external' },
        { header: 'Total', key: 'total' },
      ], rows,
    }]);
  }
  res.json(rows);
}));

router.get('/:id/sites', asyncHandler((req, res) => res.json(all('SELECT * FROM sites WHERE project_id = ? ORDER BY name', toInt(req.params.id)))));

router.post('/:id/sites', requireRole('manager'), asyncHandler((req, res) => {
  require_(req.body, ['name']);
  const id = toInt(req.params.id);
  const info = run('INSERT INTO sites (project_id, name) VALUES (?, ?)', id, req.body.name);
  res.status(201).json(get('SELECT * FROM sites WHERE id = ?', info.lastInsertRowid));
}));

module.exports = router;
