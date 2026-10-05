'use strict';

/**
 * ===========================================================================
 * Step 4b: Universal Chain Number & Short Deliveries Pipeline
 * 
 * 1. Universal Chain Number (chain_no):
 *    Format: CHN-YYYY-XXXXX (e.g. CHN-2026-00001)
 *    Stamped across the full document lifecycle:
 *    Request (mrn) -> Transfer (mtn) -> Receipt (grn / grn_vouchers) -> Issue (min_notes / issues)
 * 
 * 2. Short Deliveries & Discrepancy Logging:
 *    When an MTN or direct delivery arrives, actual received vs sent is verified.
 *    If qty_received < qty_sent:
 *      - Record shortage deficit: qty_short = qty_sent - qty_received
 *      - Discrepancy reason logged (e.g. "2 broken in transit", "short supplied")
 *      - Deficit remains open in mrn_lines pipeline
 *      - Discrepancy logged in delivery_discrepancies table
 * 
 * 3. Idempotency Guard:
 *    Retries or double-clicks will never create duplicate documents across
 *    stores workflows (MRN create, MTN dispatch/accept, GRN receive, Issue create).
 * ===========================================================================
 */

const { get, all, run, tx } = require('../db');
const audit = require('./audit');
const emitter = require('./emitter');

/**
 * Generate the next sequential Chain Number for the specified year.
 * Format: CHN-YYYY-XXXXX (e.g. CHN-2026-00001)
 */
function nextChainNo(year) {
  const y = Number(year) || new Date().getFullYear();
  const prefix = `CHN-${y}-`;

  const r = get(`
    SELECT MAX(CAST(SUBSTR(chain_no, 10) AS INTEGER)) AS max_seq
      FROM (
        SELECT chain_no FROM mrn WHERE chain_no LIKE ?
        UNION
        SELECT chain_no FROM mtn WHERE chain_no LIKE ?
        UNION
        SELECT chain_no FROM grn WHERE chain_no LIKE ?
        UNION
        SELECT chain_no FROM grn_vouchers WHERE chain_no LIKE ?
        UNION
        SELECT chain_no FROM min_notes WHERE chain_no LIKE ?
        UNION
        SELECT chain_no FROM issues WHERE chain_no LIKE ?
      )
  `, `${prefix}%`, `${prefix}%`, `${prefix}%`, `${prefix}%`, `${prefix}%`, `${prefix}%`);

  const nextSeq = (r && r.max_seq ? Number(r.max_seq) : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
}

/**
 * Assign or retrieve chain_no for an MRN, and propagate down to all linked documents.
 */
function assignChainNo(mrnId, explicitChainNo) {
  const mid = Number(mrnId) || 0;
  if (!mid) return null;

  const mrn = get('SELECT id, chain_no, req_date FROM mrn WHERE id = ?', mid);
  if (!mrn) return null;

  let chainNo = mrn.chain_no;
  let force = false;
  if (!chainNo || (explicitChainNo && explicitChainNo !== chainNo)) {
    const yr = (mrn.req_date && String(mrn.req_date).slice(0, 4)) || new Date().getFullYear();
    chainNo = explicitChainNo || nextChainNo(yr);
    run('UPDATE mrn SET chain_no = ? WHERE id = ?', chainNo, mid);
    force = !!explicitChainNo;
  }

  // Propagate downstream
  propagateChainNo('mrn', mid, chainNo, force);
  return chainNo;
}

/**
 * Propagate chain_no across linked documents.
 */
function propagateChainNo(entityType, entityId, chainNo, force = false) {
  const id = Number(entityId) || 0;
  if (!id || !chainNo) return;

  const filter = force ? '' : " AND (chain_no IS NULL OR chain_no = '')";

  tx(() => {
    if (entityType === 'mrn') {
      // 1. Linked MTNs
      run(`UPDATE mtn SET chain_no = ? WHERE mrn_id = ?${filter}`, chainNo, id);
      // 2. Linked GRNs
      run(`UPDATE grn SET chain_no = ? WHERE mrn_id = ?${filter}`, chainNo, id);
      // 3. Linked GRN vouchers
      run(`
        UPDATE grn_vouchers
           SET chain_no = ?
         WHERE id IN (SELECT voucher_id FROM grn WHERE mrn_id = ? AND voucher_id IS NOT NULL)
           ${filter}
      `, chainNo, id);
      // 4. Linked issues
      run(`
        UPDATE issues
           SET chain_no = ?
         WHERE (mrn_line_id IN (SELECT id FROM mrn_lines WHERE mrn_id = ?)
            OR grn_id IN (SELECT id FROM grn WHERE mrn_id = ?))
           ${filter}
      `, chainNo, id, id);
      // 5. Linked MIN notes
      run(`
        UPDATE min_notes
           SET chain_no = ?
         WHERE id IN (
           SELECT min_id FROM issues
            WHERE (mrn_line_id IN (SELECT id FROM mrn_lines WHERE mrn_id = ?)
               OR grn_id IN (SELECT id FROM grn WHERE mrn_id = ?))
              AND min_id IS NOT NULL
         ) ${filter}
      `, chainNo, id, id);
    } else if (entityType === 'mtn') {
      run('UPDATE mtn SET chain_no = ? WHERE id = ?', chainNo, id);
      const m = get('SELECT mrn_id FROM mtn WHERE id = ?', id);
      if (m && m.mrn_id) {
        propagateChainNo('mrn', m.mrn_id, chainNo, force);
      }
    } else if (entityType === 'grn') {
      run('UPDATE grn SET chain_no = ? WHERE id = ?', chainNo, id);
      const g = get('SELECT mrn_id, voucher_id FROM grn WHERE id = ?', id);
      if (g) {
        if (g.voucher_id) {
          run(`UPDATE grn_vouchers SET chain_no = ? WHERE id = ?${filter}`, chainNo, g.voucher_id);
        }
        if (g.mrn_id) {
          propagateChainNo('mrn', g.mrn_id, chainNo, force);
        }
      }
    } else if (entityType === 'issue') {
      run('UPDATE issues SET chain_no = ? WHERE id = ?', chainNo, id);
      const iss = get('SELECT min_id, grn_id, mrn_line_id FROM issues WHERE id = ?', id);
      if (iss) {
        if (iss.min_id) {
          run(`UPDATE min_notes SET chain_no = ? WHERE id = ?${filter}`, chainNo, iss.min_id);
        }
        if (iss.mrn_line_id) {
          const ml = get('SELECT mrn_id FROM mrn_lines WHERE id = ?', iss.mrn_line_id);
          if (ml && ml.mrn_id) propagateChainNo('mrn', ml.mrn_id, chainNo, force);
        } else if (iss.grn_id) {
          const grn = get('SELECT mrn_id FROM grn WHERE id = ?', iss.grn_id);
          if (grn && grn.mrn_id) propagateChainNo('mrn', grn.mrn_id, chainNo, force);
        }
      }
    }
  });
}

/**
 * Record a delivery discrepancy / short delivery.
 * 
 * params:
 *   mrn_id, mrn_line_id, mtn_id, mtn_line_id, grn_id,
 *   qty_expected, qty_received, reason, item_description
 */
function recordDeliveryDiscrepancy(params, user) {
  const expected = Math.max(0, Number(params.qty_expected) || 0);
  const received = Math.max(0, Number(params.qty_received) || 0);
  const shortage = Math.max(0, expected - received);

  if (shortage <= 0) {
    return { ok: true, discrepancy: null, message: 'No shortage detected' };
  }

  const reason = String(params.reason || 'Short delivery on receipt').trim();
  const mrnId = Number(params.mrn_id) || null;
  const mrnLineId = Number(params.mrn_line_id) || null;
  const mtnId = Number(params.mtn_id) || null;
  const mtnLineId = Number(params.mtn_line_id) || null;
  const grnId = Number(params.grn_id) || null;

  // Resolve item description
  let desc = params.item_description || null;
  if (!desc && mrnLineId) {
    const ml = get('SELECT description FROM mrn_lines WHERE id = ?', mrnLineId);
    if (ml) desc = ml.description;
  }
  if (!desc && mtnLineId) {
    const tl = get('SELECT description FROM mtn_lines WHERE id = ?', mtnLineId);
    if (tl) desc = tl.description;
  }
  if (!desc && grnId) {
    const g = get('SELECT description FROM grn WHERE id = ?', grnId);
    if (g) desc = g.description;
  }
  desc = desc || 'Item';

  // Resolve chain number
  let chainNo = params.chain_no || null;
  if (!chainNo && mrnId) {
    const m = get('SELECT chain_no FROM mrn WHERE id = ?', mrnId);
    if (m && m.chain_no) chainNo = m.chain_no;
  }
  if (!chainNo && mtnId) {
    const t = get('SELECT chain_no FROM mtn WHERE id = ?', mtnId);
    if (t && t.chain_no) chainNo = t.chain_no;
  }
  if (!chainNo && grnId) {
    const g = get('SELECT chain_no FROM grn WHERE id = ?', grnId);
    if (g && g.chain_no) chainNo = g.chain_no;
  }

  const reportedBy = user ? (user.fullName || user.username) : 'Storekeeper';
  const reportedUserId = user ? user.id : null;
  const now = new Date().toISOString();

  let discId;
  tx(() => {
    const info = run(`
      INSERT INTO delivery_discrepancies (
        chain_no, mrn_id, mrn_line_id, mtn_id, mtn_line_id, grn_id,
        item_description, qty_expected, qty_received, qty_short,
        reason, status, reported_by, reported_by_user, reported_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, 'open', ?, ?, ?
      )
    `, chainNo, mrnId, mrnLineId, mtnId, mtnLineId, grnId,
       desc, expected, received, shortage,
       reason, reportedBy, reportedUserId, now);
    discId = info.lastInsertRowid;

    // Update mrn_lines shortage & reason
    if (mrnLineId) {
      run(`
        UPDATE mrn_lines
           SET qty_short = COALESCE(qty_short, 0) + ?,
               discrepancy_reason = ?
         WHERE id = ?
      `, shortage, reason, mrnLineId);
    }

    // Update mtn_lines received, shortage & reason
    if (mtnLineId) {
      run(`
        UPDATE mtn_lines
           SET qty_received = ?,
               qty_short = ?,
               discrepancy_reason = ?
         WHERE id = ?
      `, received, shortage, reason, mtnLineId);
    }
  });

  audit.record({
    userId: reportedUserId || 1,
    entity: 'delivery_discrepancy',
    entityId: discId,
    action: 'log_short_delivery',
    after: {
      chain_no: chainNo,
      mrn_id: mrnId,
      mrn_line_id: mrnLineId,
      qty_expected: expected,
      qty_received: received,
      qty_short: shortage,
      reason,
    },
  });

  emitter.emit('delivery_discrepancy_created', {
    id: discId,
    chain_no: chainNo,
    mrn_id: mrnId,
    qty_short: shortage,
    reason,
  });

  emitter.emit('data_changed', { what: 'stores', discrepancy_id: discId });

  return {
    ok: true,
    discrepancy: get('SELECT * FROM delivery_discrepancies WHERE id = ?', discId),
  };
}

/**
 * Update / resolve a delivery discrepancy.
 * status: 'investigating' | 'resolved' | 'written_off'
 */
function resolveDiscrepancy(id, { status, resolution_notes }, user) {
  const did = Number(id) || 0;
  if (!did) throw new Error('Invalid discrepancy ID');

  const existing = get('SELECT * FROM delivery_discrepancies WHERE id = ?', did);
  if (!existing) throw new Error('Delivery discrepancy not found');

  const validStatuses = ['open', 'investigating', 'resolved', 'written_off'];
  const newStatus = String(status || '').trim();
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
  }

  const resolver = user ? (user.fullName || user.username) : 'Store Manager';
  const now = new Date().toISOString();

  run(`
    UPDATE delivery_discrepancies
       SET status = ?,
           resolution_notes = ?,
           resolved_by = ?,
           resolved_at = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `, newStatus, resolution_notes || null, resolver, now, did);

  audit.record({
    userId: user ? user.id : 1,
    entity: 'delivery_discrepancy',
    entityId: did,
    action: 'resolve_discrepancy',
    before: { status: existing.status },
    after: { status: newStatus, resolution_notes, resolved_by: resolver },
  });

  emitter.emit('data_changed', { what: 'stores', discrepancy_id: did });
  const updated = get('SELECT * FROM delivery_discrepancies WHERE id = ?', did);
  return { ok: true, discrepancy: updated };
}

/**
 * List delivery discrepancies with filters.
 */
function listDiscrepancies(filter = {}) {
  const clauses = [];
  const params = [];

  if (filter.status) {
    clauses.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.chain_no) {
    clauses.push('d.chain_no = ?');
    params.push(filter.chain_no);
  }
  if (filter.mrn_id) {
    clauses.push('d.mrn_id = ?');
    params.push(Number(filter.mrn_id));
  }
  if (filter.mtn_id) {
    clauses.push('d.mtn_id = ?');
    params.push(Number(filter.mtn_id));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`
    SELECT d.*,
           m.mrn_no, m.req_date,
           t.mtn_no
      FROM delivery_discrepancies d
      LEFT JOIN mrn m ON m.id = d.mrn_id
      LEFT JOIN mtn t ON t.id = d.mtn_id
      ${where}
     ORDER BY d.id DESC
  `, ...params);
}

/**
 * Express middleware to prevent duplicate operations via idempotency key.
 * Checks header 'idempotency-key', 'x-idempotency-key', or body 'idempotency_key'.
 * 
 * If identical request already processed, replays saved response.
 * If request currently pending, returns 409 Conflict.
 */
function idempotencyGuard(actionName = 'stores_op') {
  return (req, res, next) => {
    // Only guard state-mutating requests (POST, PUT, PATCH, DELETE)
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const key = String(
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      (req.body && req.body.idempotency_key) ||
      ''
    ).trim();

    // If client provided no idempotency key, proceed normally
    if (!key) {
      return next();
    }

    const userId = req.user ? req.user.id : null;
    const existing = get('SELECT * FROM idempotency_keys WHERE key = ?', key);

    if (existing) {
      if (existing.status === 'completed' && existing.response_code) {
        let body;
        try {
          body = JSON.parse(existing.response_body);
        } catch {
          body = existing.response_body;
        }
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(existing.response_code).json(body);
      }

      // If in progress within last 60 seconds, prevent duplicate in-flight execution
      const rawCreated = String(existing.created_at || '');
      const createdUtc = rawCreated.includes('T') ? rawCreated : rawCreated.replace(' ', 'T') + 'Z';
      const createdAt = new Date(createdUtc).getTime();
      const elapsed = Math.abs(Date.now() - createdAt);
      if ((existing.status === 'pending' || existing.status === 'in_flight') && elapsed < 60000) {
        return res.status(409).json({
          error: 'A request with this idempotency key is currently processing',
          idempotency_key: key,
        });
      }
    }

    // Insert or replace pending idempotency record
    try {
      run(`
        INSERT INTO idempotency_keys (key, user_id, action, status)
        VALUES (?, ?, ?, 'pending')
        ON CONFLICT(key) DO UPDATE SET
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      `, key, userId, actionName);
    } catch (e) {
      // In case of conflict race
      const recheck = get('SELECT * FROM idempotency_keys WHERE key = ?', key);
      if (recheck && recheck.status === 'completed') {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(recheck.response_code).json(JSON.parse(recheck.response_body));
      }
    }

    // Intercept response to store result
    let capturedStatus = res.statusCode || 200;
    const origStatus = res.status ? res.status.bind(res) : null;
    res.status = (code) => {
      capturedStatus = code;
      res.statusCode = code;
      return origStatus ? origStatus(code) : res;
    };

    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const serialized = JSON.stringify(body);
        run(`
          UPDATE idempotency_keys
             SET status = 'completed',
                 response_code = ?,
                 response_body = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE key = ?
        `, capturedStatus, serialized, key);
      } catch (e) {
        // Logging error should not break response
      }
      return origJson(body);
    };

    next();
  };
}

/**
 * Retrieve consolidated lifecycle trace and integrity for a chain number.
 */
function getChainPipeline(chainNo) {
  const cNo = String(chainNo || '').trim();
  if (!cNo) return null;

  const mrns = all('SELECT * FROM mrn WHERE chain_no = ? ORDER BY id DESC', cNo);
  const mrnIds = mrns.map((m) => m.id);

  const lines = mrnIds.length
    ? all(`SELECT * FROM mrn_lines WHERE mrn_id IN (${mrnIds.map(() => '?').join(',')}) ORDER BY id`, ...mrnIds)
    : [];

  const mtns = all('SELECT * FROM mtn WHERE chain_no = ? ORDER BY id DESC', cNo);
  const grns = all('SELECT * FROM grn WHERE chain_no = ? ORDER BY id DESC', cNo);
  const issues = all('SELECT * FROM issues WHERE chain_no = ? ORDER BY id DESC', cNo);
  const discrepancies = all('SELECT * FROM delivery_discrepancies WHERE chain_no = ? ORDER BY id DESC', cNo);

  const totalReq = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalRec = grns.reduce((s, g) => s + (Number(g.qty) || 0), 0);
  const totalShort = lines.reduce((s, l) => s + (Number(l.qty_short) || 0), 0);
  const totalIss = issues.reduce((s, i) => s + (Number(i.qty) || 0), 0);

  const openDisc = discrepancies.filter((d) => d.status === 'open' || d.status === 'investigating');

  const summary = {
    total_lines: lines.length,
    total_qty_requested: totalReq,
    total_qty_received: totalRec,
    total_qty_short: totalShort,
    total_qty_issued: totalIss,
  };

  const integrity = {
    is_safe_to_close: openDisc.length === 0 && (totalReq <= totalRec || (totalShort > 0 && totalReq <= totalRec + totalShort)),
    open_discrepancies_count: openDisc.length,
    has_shortage: totalShort > 0,
  };

  return {
    chain_no: cNo,
    mrns,
    lines,
    mtns,
    grns,
    issues,
    discrepancies,
    summary,
    integrity,
  };
}

module.exports = {
  nextChainNo,
  assignChainNo,
  propagateChainNo,
  recordDeliveryDiscrepancy,
  resolveDiscrepancy,
  listDiscrepancies,
  idempotencyGuard,
  getChainPipeline,
};
