'use strict';

// Job Cards: the Monitor and the Requests list (job cards plan, Part 1). See src/lib/jobs_flow.js.
// Open to anyone who may see job cards or job requests; each part of the answer is kept to what the
// person may see, and every decision still goes through the route that makes it.

const express = require('express');
const { asyncHandler } = require('../lib/http');
const { sendXlsx } = require('../lib/export');
const flow = require('../lib/jobs_flow');

const router = express.Router();

router.use((req, res, next) => (flow.sees(req.user, 'jobs') || flow.sees(req.user, 'jobrequests')
  ? next() : res.status(403).json({ error: 'Your role has no view access to job cards or job requests' })));

router.get('/monitor', asyncHandler((req, res) => res.json(flow.monitor(req.user))));
router.get('/requests', asyncHandler((req, res) => res.json({ rows: flow.requests(req.user, req.query), counts: flow.counts(req.user) })));

const KIND = { jr: 'Job request', card: 'Job card', reopen: 'Reopen request' };
router.get('/requests/export.xlsx', asyncHandler(async (req, res) => {
  const rows = flow.requests(req.user, { ...req.query, limit: 5000 });
  await sendXlsx(res, `job-requests-${req.query.step || 'open'}.xlsx`, [{
    name: 'Requests',
    columns: [
      { header: 'Kind', key: 'kind', width: 14 }, { header: 'No', key: 'no', width: 16 }, { header: 'Date', key: 'date', width: 11 },
      { header: 'Vehicle', key: 'vehicle', width: 16 }, { header: 'Type', key: 'type', width: 9 }, { header: 'Work', key: 'description', width: 40 },
      { header: 'Asked by', key: 'requested_by', width: 16 }, { header: 'Waiting for', key: 'waiting_for', width: 30 },
      { header: 'Since', key: 'since', width: 11 }, { header: 'Days', key: 'days', width: 6 }, { header: 'Job card', key: 'job_no', width: 16 },
    ],
    rows: rows.map((r) => ({ ...r, kind: KIND[r.kind], vehicle: r.asset_reg || r.asset_code || '' })),
  }]);
}));

module.exports = router;
