'use strict';

// ===========================================================================
// Real-Time Privilege/Permission-Scoped Notification Center API
// ===========================================================================

const express = require('express');
const { requireAuth } = require('../lib/auth');
const { asyncHandler } = require('../lib/http');
const notifications = require('../lib/notifications');

const router = express.Router();

router.use(requireAuth);

// GET /api/notifications — returns privilege-scoped notifications for the signed-in user
router.get('/', asyncHandler((req, res) => {
  const data = notifications.getNotificationsForUser(req.user);
  res.json(data);
}));

// GET /api/notifications/nav-badges — lightweight RBAC-scoped operational badge counts for sidebar
router.get('/nav-badges', asyncHandler((req, res) => {
  res.json(notifications.getNavBadgesForUser(req.user));
}));

// POST /api/notifications/read — mark one or more notification keys as read
router.post('/read', asyncHandler((req, res) => {
  const keys = Array.isArray(req.body.keys)
    ? req.body.keys
    : (req.body.key ? [req.body.key] : []);
  const marked = notifications.markRead(req.user.id, keys);
  res.json({ ok: true, marked });
}));

// POST /api/notifications/read-all — mark all current notifications for user as read
router.post('/read-all', asyncHandler((req, res) => {
  const marked = notifications.markAllRead(req.user);
  res.json({ ok: true, marked });
}));

module.exports = router;
