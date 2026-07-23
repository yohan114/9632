'use strict';

// Access Control — read/update the role × module permission matrix (admin only).

const express = require('express');
const { requireRole } = require('../lib/auth');
const { asyncHandler, require_ } = require('../lib/http');
const permissions = require('../lib/permissions');
const audit = require('../lib/audit');

const router = express.Router();

// The full clearance board.
router.get('/matrix', requireRole('admin'), asyncHandler((_req, res) => res.json(permissions.getMatrix())));

// Set one cell (role × module → level). Admin row is locked (always full).
router.post('/matrix', requireRole('admin'), asyncHandler((req, res) => {
  require_(req.body, ['role', 'module', 'level']);
  const matrix = permissions.setPermission(req.body.role, req.body.module, req.body.level);
  audit.record({ userId: req.user.id, entity: 'role_permission', action: 'update', after: { role: req.body.role, module: req.body.module, level: req.body.level } });
  res.json(matrix);
}));

module.exports = router;
