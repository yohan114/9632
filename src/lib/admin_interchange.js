'use strict';

/**
 * System-Admin-only job card reassignment and two-way interchange engine.
 *
 * Allows a System Admin (`isAdmin(user)`) to move or swap daily work done and
 * materials (parts, MRNs/MRN lines, store issues, oil issues, general item issues)
 * between job cards — including CLOSED and PARTIALLY_CLOSED cards — while keeping
 * job totals, closed snapshots, vehicle monthly rollups, mechanic labour, and the
 * audit trail completely consistent.
 */

const { get, all, run, tx } = require('../db');
const { isAdmin } = require('./access_rules');
const { toInt } = require('./http');
const costing = require('./costing');
const mechanics = require('./mechanics');
const workshops = require('./workshops');
const audit = require('./audit');
const emitter = require('./emitter');

const ITEM_KEYS = ['daily_work', 'parts', 'mrns', 'mrn_lines', 'issues', 'oil_issues', 'general_issues'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertAdmin(user) {
  if (!isAdmin(user)) {
    throw httpError(403, 'Only System Admin can reassign or interchange job card items.');
  }
}

function parseIds(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const n = toInt(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function normalizeItems(raw = {}) {
  const out = {};
  let total = 0;
  for (const k of ITEM_KEYS) {
    out[k] = parseIds(raw && raw[k]);
    total += out[k].length;
  }
  return { items: out, total };
}

function addBucket(map, assetId, dateStr) {
  if (!assetId || !dateStr) return;
  const ym = String(dateStr).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return;
  const [year, month] = ym.split('-').map(Number);
  if (!year || !month) return;
  map.set(`${assetId}:${ym}`, { assetId, year, month });
}

function addWorkMonth(set, dateStr) {
  if (!dateStr) return;
  const ym = String(dateStr).slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(ym)) set.add(ym);
}

function captureJobContext(jobId, ctx) {
  if (!jobId) return;
  ctx.affectedJobs.add(jobId);
  if (ctx.capturedJobs.has(jobId)) return;
  ctx.capturedJobs.add(jobId);
  const job = get('SELECT id, asset_id FROM job_cards WHERE id = ?', jobId);
  if (!job || !job.asset_id) return;
  for (const b of costing.vehicleMonthsForJob(job.id, job.asset_id)) {
    ctx.buckets.set(`${b.assetId}:${b.year}-${String(b.month).padStart(2, '0')}`, b);
  }
}

function maybeReassignMin(minId, targetJob) {
  if (!minId) return;
  const remaining = get(
    'SELECT COUNT(*) AS c FROM issues WHERE min_id = ? AND COALESCE(job_id, 0) <> ?',
    minId, targetJob.id
  );
  if (remaining && remaining.c === 0) {
    run(
      'UPDATE min_notes SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
      targetJob.id, targetJob.asset_id || null, minId
    );
  }
}

function syncIssueRecord(issueRow, targetJob, ctx) {
  if (!issueRow) return;
  if (issueRow.job_id) captureJobContext(issueRow.job_id, ctx);
  addBucket(ctx.buckets, issueRow.asset_id, issueRow.issue_date);
  addBucket(ctx.buckets, targetJob.asset_id, issueRow.issue_date);

  run(
    'UPDATE issues SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
    targetJob.id, targetJob.asset_id || null, issueRow.id
  );
  run(
    "UPDATE stock_moves SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE source_table = 'issues' AND source_id = ?",
    targetJob.id, targetJob.asset_id || null, issueRow.id
  );
  run(
    'UPDATE general_item_txns SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE source_issue_id = ?',
    targetJob.id, targetJob.asset_id || null, issueRow.id
  );
  run(
    'UPDATE stock_ledger SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE source_issue_id = ?',
    targetJob.id, targetJob.asset_id || null, issueRow.id
  );
  maybeReassignMin(issueRow.min_id, targetJob);
}

function maybeReassignMrn(mrnId, oldJobId, targetJob, ctx) {
  if (!mrnId) return;
  const m = get('SELECT * FROM mrn WHERE id = ?', mrnId);
  if (!m) return;
  if (m.job_id) captureJobContext(m.job_id, ctx);
  if (m.job_id !== oldJobId && m.job_id != null) return;
  const stillOnOld = get(
    `SELECT COUNT(*) AS c
       FROM mrn_lines ml
       JOIN job_parts jp ON jp.mrn_line_id = ml.id
      WHERE ml.mrn_id = ? AND jp.job_id = ?`,
    mrnId, oldJobId
  );
  if (stillOnOld && stillOnOld.c > 0) return;
  run(
    'UPDATE mrn SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
    targetJob.id, targetJob.asset_id || null, mrnId
  );
}

function moveGrnLinks(grnIds, oldJobId, targetJob, ctx) {
  if (!grnIds.length) return;
  const ph = grnIds.map(() => '?').join(',');
  if (oldJobId) {
    const linkedParts = all(
      `SELECT * FROM job_parts WHERE source_type = 'grn' AND source_id IN (${ph}) AND job_id = ?`,
      ...grnIds, oldJobId
    );
    for (const jp of linkedParts) {
      captureJobContext(jp.job_id, ctx);
      run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
    }
    const grnIssues = all(
      `SELECT * FROM issues WHERE grn_id IN (${ph}) AND job_id = ?`,
      ...grnIds, oldJobId
    );
    for (const iss of grnIssues) {
      syncIssueRecord(iss, targetJob, ctx);
      const issParts = all("SELECT * FROM job_parts WHERE source_type = 'issue' AND source_id = ?", iss.id);
      for (const ip of issParts) {
        captureJobContext(ip.job_id, ctx);
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, ip.id);
      }
    }
  }
}

function applyMoves(targetJob, items, ctx) {
  captureJobContext(targetJob.id, ctx);
  const counts = {
    daily_work: 0,
    parts: 0,
    mrns: 0,
    mrn_lines: 0,
    issues: 0,
    oil_issues: 0,
    general_issues: 0,
  };

  // 1. Daily work rows
  for (const id of items.daily_work) {
    const row = get('SELECT * FROM job_daily_work WHERE id = ?', id);
    if (!row) throw httpError(404, `Daily work entry #${id} not found`);
    captureJobContext(row.job_id, ctx);
    addBucket(ctx.buckets, row.asset_id, row.work_date);
    addBucket(ctx.buckets, targetJob.asset_id, row.work_date);
    addWorkMonth(ctx.workMonths, row.work_date);

    if (row.job_id !== targetJob.id) {
      run(
        'UPDATE job_daily_work SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
        targetJob.id, targetJob.asset_id || null, id
      );
      counts.daily_work++;
    }
  }

  // 2. Parts & External lines (job_parts) + underlying issue / MRN cascades
  for (const id of items.parts) {
    const part = get('SELECT * FROM job_parts WHERE id = ?', id);
    if (!part) throw httpError(404, `Part line #${id} not found`);
    const oldJobId = part.job_id;
    captureJobContext(oldJobId, ctx);

    if (oldJobId !== targetJob.id) {
      run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, id);
      counts.parts++;
    }

    if (part.source_type === 'issue' && part.source_id) {
      const iss = get('SELECT * FROM issues WHERE id = ?', part.source_id);
      if (iss) syncIssueRecord(iss, targetJob, ctx);
    } else if (part.source_type === 'grn' && part.source_id) {
      moveGrnLinks([part.source_id], oldJobId, targetJob, ctx);
    }

    if (part.mrn_line_id) {
      const ml = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', part.mrn_line_id);
      if (ml) maybeReassignMrn(ml.mrn_id, oldJobId, targetJob, ctx);
    }
  }

  // 3. Whole MRNs
  for (const mrnId of items.mrns) {
    const m = get('SELECT * FROM mrn WHERE id = ?', mrnId);
    if (!m) throw httpError(404, `MRN #${mrnId} not found`);
    const oldJobId = m.job_id;
    if (oldJobId) captureJobContext(oldJobId, ctx);
    addBucket(ctx.buckets, m.asset_id, m.req_date);
    addBucket(ctx.buckets, targetJob.asset_id, m.req_date);

    const lines = all('SELECT id FROM mrn_lines WHERE mrn_id = ?', mrnId);
    const lineIds = lines.map((l) => l.id);
    if (lineIds.length) {
      const lPh = lineIds.map(() => '?').join(',');
      const jpByLine = all(`SELECT * FROM job_parts WHERE mrn_line_id IN (${lPh})`, ...lineIds);
      for (const jp of jpByLine) {
        captureJobContext(jp.job_id, ctx);
        if (jp.job_id !== targetJob.id) {
          run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
        }
        if (jp.source_type === 'issue' && jp.source_id) {
          const iss = get('SELECT * FROM issues WHERE id = ?', jp.source_id);
          if (iss) syncIssueRecord(iss, targetJob, ctx);
        }
      }
      const grns = all(
        `SELECT id FROM grn WHERE mrn_id = ? OR mrn_line_id IN (${lPh})`,
        mrnId, ...lineIds
      );
      moveGrnLinks(grns.map((g) => g.id), oldJobId, targetJob, ctx);
    } else {
      const grns = all('SELECT id FROM grn WHERE mrn_id = ?', mrnId);
      moveGrnLinks(grns.map((g) => g.id), oldJobId, targetJob, ctx);
    }

    if (oldJobId !== targetJob.id || (targetJob.asset_id && m.asset_id !== targetJob.asset_id)) {
      run(
        'UPDATE mrn SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
        targetJob.id, targetJob.asset_id || null, mrnId
      );
      counts.mrns++;
    }
  }

  // 4. Individual MRN lines
  for (const mlId of items.mrn_lines) {
    const ml = get('SELECT * FROM mrn_lines WHERE id = ?', mlId);
    if (!ml) throw httpError(404, `MRN line #${mlId} not found`);
    const m = get('SELECT * FROM mrn WHERE id = ?', ml.mrn_id);
    const oldJobId = m ? m.job_id : null;
    if (oldJobId) captureJobContext(oldJobId, ctx);

    const jpByLine = all('SELECT * FROM job_parts WHERE mrn_line_id = ?', mlId);
    for (const jp of jpByLine) {
      captureJobContext(jp.job_id, ctx);
      if (jp.job_id !== targetJob.id) {
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
        counts.mrn_lines++;
      }
      if (jp.source_type === 'issue' && jp.source_id) {
        const iss = get('SELECT * FROM issues WHERE id = ?', jp.source_id);
        if (iss) syncIssueRecord(iss, targetJob, ctx);
      }
    }
    const grns = all('SELECT id FROM grn WHERE mrn_line_id = ?', mlId);
    moveGrnLinks(grns.map((g) => g.id), oldJobId, targetJob, ctx);

    if (m) {
      const totalLines = get('SELECT COUNT(*) AS c FROM mrn_lines WHERE mrn_id = ?', m.id).c;
      if (totalLines <= 1) {
        if (m.job_id !== targetJob.id) {
          run(
            'UPDATE mrn SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
            targetJob.id, targetJob.asset_id || null, m.id
          );
          if (!jpByLine.length) counts.mrn_lines++;
        }
      } else {
        maybeReassignMrn(m.id, oldJobId, targetJob, ctx);
      }
    }
  }

  // 5. Direct Store Issues (issues)
  const targetIsGeneral = workshops.isGeneralCard(targetJob);
  for (const issId of items.issues) {
    const iss = get('SELECT * FROM issues WHERE id = ?', issId);
    if (!iss) throw httpError(404, `Issue #${issId} not found`);
    const oldJobId = iss.job_id;
    syncIssueRecord(iss, targetJob, ctx);

    const issueParts = all("SELECT * FROM job_parts WHERE source_type = 'issue' AND source_id = ?", issId);
    if (issueParts.length) {
      for (const jp of issueParts) {
        captureJobContext(jp.job_id, ctx);
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
      }
    } else if (iss.grn_id && oldJobId) {
      const grnPart = get(
        "SELECT * FROM job_parts WHERE source_type = 'grn' AND source_id = ? AND job_id = ?",
        iss.grn_id, oldJobId
      );
      if (grnPart) {
        captureJobContext(grnPart.job_id, ctx);
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, grnPart.id);
      }
    } else if (!targetIsGeneral && !iss.service_id) {
      run(
        `INSERT INTO job_parts (job_id, source_type, source_id, mrn_line_id, description, qty, unit_price, is_external_repair)
         VALUES (?, 'issue', ?, ?, ?, ?, ?, 0)`,
        targetJob.id, iss.id, iss.mrn_line_id || null, iss.description, iss.qty || 1, iss.unit_price
      );
    }

    if (iss.mrn_line_id) {
      const ml = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', iss.mrn_line_id);
      if (ml) maybeReassignMrn(ml.mrn_id, oldJobId, targetJob, ctx);
    }
    if (oldJobId !== targetJob.id) counts.issues++;
  }

  // 6. Oil / Lubricant issues (stock_ledger)
  for (const slId of items.oil_issues) {
    const sl = get('SELECT * FROM stock_ledger WHERE id = ?', slId);
    if (!sl) throw httpError(404, `Oil ledger entry #${slId} not found`);
    captureJobContext(sl.job_id, ctx);
    addBucket(ctx.buckets, sl.asset_id, sl.txn_date);
    addBucket(ctx.buckets, targetJob.asset_id, sl.txn_date);

    if (sl.job_id !== targetJob.id) {
      run(
        'UPDATE stock_ledger SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
        targetJob.id, targetJob.asset_id || null, slId
      );
      counts.oil_issues++;
    }
    if (sl.source_issue_id) {
      const iss = get('SELECT * FROM issues WHERE id = ?', sl.source_issue_id);
      if (iss) syncIssueRecord(iss, targetJob, ctx);
      const issParts = all("SELECT * FROM job_parts WHERE source_type = 'issue' AND source_id = ?", sl.source_issue_id);
      for (const jp of issParts) {
        captureJobContext(jp.job_id, ctx);
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
      }
    }
  }

  // 7. General item issues (general_item_txns)
  for (const gitId of items.general_issues) {
    const git = get('SELECT * FROM general_item_txns WHERE id = ?', gitId);
    if (!git) throw httpError(404, `General item issue #${gitId} not found`);
    captureJobContext(git.job_id, ctx);
    addBucket(ctx.buckets, git.asset_id, git.txn_date);
    addBucket(ctx.buckets, targetJob.asset_id, git.txn_date);

    if (git.job_id !== targetJob.id) {
      run(
        'UPDATE general_item_txns SET job_id = ?, asset_id = COALESCE(?, asset_id) WHERE id = ?',
        targetJob.id, targetJob.asset_id || null, gitId
      );
      counts.general_issues++;
    }
    if (git.source_issue_id) {
      const iss = get('SELECT * FROM issues WHERE id = ?', git.source_issue_id);
      if (iss) syncIssueRecord(iss, targetJob, ctx);
      const issParts = all("SELECT * FROM job_parts WHERE source_type = 'issue' AND source_id = ?", git.source_issue_id);
      for (const jp of issParts) {
        captureJobContext(jp.job_id, ctx);
        run('UPDATE job_parts SET job_id = ? WHERE id = ?', targetJob.id, jp.id);
      }
    }
  }

  return counts;
}

function settleAfterAdminChanges(ctx) {
  const affectedJobs = [];
  for (const jid of ctx.affectedJobs) {
    const job = get('SELECT id, job_no, status, asset_id FROM job_cards WHERE id = ?', jid);
    if (!job) continue;
    if (job.status === 'CLOSED') {
      costing.snapshotJobCost(jid);
    } else {
      costing.refreshJobTotals(jid);
    }
    if (job.asset_id) {
      for (const b of costing.vehicleMonthsForJob(jid, job.asset_id)) {
        ctx.buckets.set(`${b.assetId}:${b.year}-${String(b.month).padStart(2, '0')}`, b);
      }
    }
    affectedJobs.push(jid);
  }

  for (const b of ctx.buckets.values()) {
    costing.recalcVehicleMonth(b.assetId, b.year, b.month);
  }
  for (const ym of ctx.workMonths) {
    mechanics.syncJobLabourForMonth(ym);
  }

  return affectedJobs;
}

function recordAndBroadcastAdminChange(user, auditAction, auditEntityId, auditMeta, reason, affectedJobs) {
  audit.record({
    userId: user.id,
    entity: 'job_card',
    entityId: auditEntityId,
    action: auditAction,
    before: auditMeta.before || null,
    after: auditMeta.after || null,
    reason: reason || null,
  });

  for (const jid of affectedJobs) {
    emitter.emit('job_updated', { job_id: jid, action: 'admin_interchange' });
  }
  emitter.emit('dashboard_refresh', { reason: 'admin_interchange' });
}

function moveItemsToJob(user, { targetJobId, items: rawItems, reason = null } = {}) {
  assertAdmin(user);
  const targetId = toInt(targetJobId);
  if (!targetId) throw httpError(400, 'Select a target job card');
  const { items, total } = normalizeItems(rawItems);
  if (!total) throw httpError(400, 'Select at least one item to move');

  const targetJob = get('SELECT * FROM job_cards WHERE id = ?', targetId);
  if (!targetJob) throw httpError(404, 'Target job card not found');

  const ctx = { affectedJobs: new Set(), capturedJobs: new Set(), buckets: new Map(), workMonths: new Set() };
  let moved;
  let affectedJobs;

  tx(() => {
    moved = applyMoves(targetJob, items, ctx);
    affectedJobs = settleAfterAdminChanges(ctx);
  });

  recordAndBroadcastAdminChange(
    user,
    'admin_reassign_items',
    targetJob.id,
    {
      before: { source_jobs: [...ctx.affectedJobs].filter((id) => id !== targetJob.id) },
      after: { target_job_id: targetJob.id, job_id: targetJob.id, asset_id: targetJob.asset_id, moved, items },
    },
    reason || 'Admin reassigned items to job card',
    affectedJobs
  );

  return { ok: true, target_job_id: targetJob.id, moved, affected_jobs: affectedJobs };
}

function interchangeBetweenJobs(user, { jobAId, jobBId, moveAToB, moveBToA, reason = null } = {}) {
  assertAdmin(user);
  const idA = toInt(jobAId);
  const idB = toInt(jobBId);
  if (!idA || !idB) throw httpError(400, 'Both job cards must be selected');
  if (idA === idB) throw httpError(400, 'Select two different job cards to interchange items');

  const jobA = get('SELECT * FROM job_cards WHERE id = ?', idA);
  const jobB = get('SELECT * FROM job_cards WHERE id = ?', idB);
  if (!jobA) throw httpError(404, 'Source job card not found');
  if (!jobB) throw httpError(404, 'Partner job card not found');

  const normA = normalizeItems(moveAToB);
  const normB = normalizeItems(moveBToA);
  if (!normA.total && !normB.total) {
    throw httpError(400, 'Select at least one item to move or swap between the two job cards');
  }

  const ctx = { affectedJobs: new Set(), capturedJobs: new Set(), buckets: new Map(), workMonths: new Set() };
  let movedAToB;
  let movedBToA;
  let affectedJobs;

  tx(() => {
    captureJobContext(jobA.id, ctx);
    captureJobContext(jobB.id, ctx);
    movedAToB = normA.total ? applyMoves(jobB, normA.items, ctx) : { daily_work: 0, parts: 0, mrns: 0, mrn_lines: 0, issues: 0, oil_issues: 0, general_issues: 0 };
    movedBToA = normB.total ? applyMoves(jobA, normB.items, ctx) : { daily_work: 0, parts: 0, mrns: 0, mrn_lines: 0, issues: 0, oil_issues: 0, general_issues: 0 };
    affectedJobs = settleAfterAdminChanges(ctx);
  });

  recordAndBroadcastAdminChange(
    user,
    'admin_interchange_items',
    jobA.id,
    {
      before: { job_a_id: jobA.id, job_b_id: jobB.id },
      after: { job_a_id: jobA.id, job_b_id: jobB.id, job_id: jobA.id, asset_id: jobA.asset_id, moved_a_to_b: movedAToB, moved_b_to_a: movedBToA },
    },
    reason || `Admin interchanged items between ${jobA.job_no} and ${jobB.job_no}`,
    affectedJobs
  );

  return {
    ok: true,
    job_a_id: jobA.id,
    job_b_id: jobB.id,
    moved_a_to_b: movedAToB,
    moved_b_to_a: movedBToA,
    affected_jobs: affectedJobs,
  };
}

function syncAttachedIssuePart(part, targetJob, oldJobId, ctx) {
  if (!part || !targetJob) return;
  if (oldJobId) captureJobContext(oldJobId, ctx);
  captureJobContext(targetJob.id, ctx);

  let iss = null;
  if (part.source_type === 'issue' && part.source_id) {
    iss = get('SELECT * FROM issues WHERE id = ?', part.source_id);
    if (iss && (iss.job_id === oldJobId || iss.job_id == null)) {
      syncIssueRecord(iss, targetJob, ctx);
    }
  }

  const mlId = part.mrn_line_id || (iss && iss.mrn_line_id);
  if (mlId) {
    const ml = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', mlId);
    if (ml) maybeReassignMrn(ml.mrn_id, oldJobId, targetJob, ctx);
  }
}

module.exports = {
  assertAdmin,
  moveItemsToJob,
  interchangeBetweenJobs,
  syncAttachedIssuePart,
};
