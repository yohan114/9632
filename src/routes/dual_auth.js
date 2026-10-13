'use strict';

const express = require('express');
const { get, all, run, tx } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { asyncHandler, toInt, require_ } = require('../lib/http');
const dualAuth = require('../lib/dual_auth');
const audit = require('../lib/audit');

const router = express.Router();

router.use(requireAuth);

// 1. List pending Dual-Authorization requests
router.get('/pending', asyncHandler((req, res) => {
  const list = dualAuth.listPendingDualAuth(req.user);
  res.json({
    total: list.length,
    requests: list
  });
}));

// 2. Cryptographic Audit Ledger Integrity Verification
router.get('/integrity', requireCap('system.status', 'access.manage'), asyncHandler((req, res) => {
  const result = dualAuth.verifyLedgerIntegrity();
  res.json(result);
}));

// 3. Approve a Dual-Authorization Request (Enforces 4-Eyes Principle)
router.post('/:id/approve', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const note = req.body.note ? String(req.body.note).trim() : '';

  const request = get('SELECT * FROM dual_auth_requests WHERE id = ?', id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'PENDING') return res.status(400).json({ error: `Request already ${request.status}` });

  // 4-Eyes Guard: Cannot self-approve!
  if (Number(request.requested_by) === Number(req.user.id)) {
    return res.status(403).json({
      error: '4-Eyes Violation: The person who requested this action cannot approve it. An independent second manager must authorize this operation.'
    });
  }

  // Execute underlying action upon dual-approval
  let executionResult = null;
  tx(() => {
    dualAuth.approveDualAuthRequest(id, req.user.id, note);

    // Apply operation based on type
    if (request.operation_type === 'job_reopen') {
      const jobId = request.entity_id;
      run("UPDATE job_cards SET status = 'IN_PROGRESS', closed_at = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?", jobId);
      executionResult = { reopened_job_id: jobId };
    } else if (request.operation_type === 'stock_scrap') {
      if (request.entity_type === 'tool') {
        run("UPDATE tools SET status = 'scrapped', updated_at = datetime('now') WHERE id = ?", request.entity_id);
      } else if (request.entity_type === 'battery') {
        run("UPDATE batteries SET state = 'scrapped', updated_at = datetime('now') WHERE id = ?", request.entity_id);
      }
      executionResult = { scrapped_entity: request.entity_type, id: request.entity_id };
    }
  });

  res.json({
    ok: true,
    message: 'Dual-authorization granted. Action executed.',
    request_id: id,
    executionResult
  });
}));

// 4. Reject a Dual-Authorization Request
router.post('/:id/reject', asyncHandler((req, res) => {
  const id = toInt(req.params.id);
  const note = req.body.note ? String(req.body.note).trim() : 'Rejected by second reviewer';

  const request = get('SELECT * FROM dual_auth_requests WHERE id = ?', id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'PENDING') return res.status(400).json({ error: `Request already ${request.status}` });

  if (Number(request.requested_by) === Number(req.user.id)) {
    return res.status(403).json({ error: 'Cannot reject your own request. Cancel it instead.' });
  }

  dualAuth.rejectDualAuthRequest(id, req.user.id, note);
  res.json({ ok: true, message: 'Request rejected', request_id: id });
}));

// 5. Multi-Workshop Cluster Assignment
router.get('/users/:userId/workshops', requireCap('users.manage', 'access.manage'), asyncHandler((req, res) => {
  const userId = toInt(req.params.userId);
  const workshops = dualAuth.workshopsForUser(userId);
  res.json({ user_id: userId, workshops });
}));

router.post('/users/:userId/workshops', requireCap('users.manage', 'access.manage'), asyncHandler((req, res) => {
  const userId = toInt(req.params.userId);
  const workshopIds = Array.isArray(req.body.workshop_ids) ? req.body.workshop_ids.map(Number).filter(Boolean) : [];
  const primaryId = toInt(req.body.primary_workshop_id) || (workshopIds[0] || null);

  tx(() => {
    run('DELETE FROM user_workshops WHERE user_id = ?', userId);
    for (const wsId of workshopIds) {
      run(
        `INSERT INTO user_workshops (user_id, workshop_id, is_primary) VALUES (?, ?, ?)`,
        userId, wsId, wsId === primaryId ? 1 : 0
      );
    }
    if (primaryId) {
      run('UPDATE users SET workshop_id = ? WHERE id = ?', primaryId, userId);
    }
  });

  audit.record({
    userId: req.user.id,
    entity: 'user_workshops',
    entityId: userId,
    action: 'cluster_assign',
    after: { workshopIds, primaryId }
  });

  res.json({ ok: true, user_id: userId, workshops: dualAuth.workshopsForUser(userId) });
}));

module.exports = router;
