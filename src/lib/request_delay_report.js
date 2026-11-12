'use strict';

const ExcelJS = require('exceljs');
const { get, all } = require('../db');

const d10 = (v) => (v ? String(v).trim().slice(0, 10) : '');

function parseUtcDate(s) {
  const clean = d10(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
  const [y, m, d] = clean.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function diffDays(fromStr, toStr) {
  const t1 = parseUtcDate(fromStr);
  const t2 = parseUtcDate(toStr);
  if (t1 == null || t2 == null) return null;
  return Math.max(0, Math.round((t2 - t1) / 86400000));
}

function normalizeSource(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'unassigned';
  if (s.includes('local')) return 'local_purchase';
  if (s.includes('head') || s.includes('direct') || s === 'ho') return 'head_office';
  return 'head_office';
}

function sourceLabel(norm) {
  if (norm === 'head_office') return 'Head Office';
  if (norm === 'local_purchase') return 'Local Purchase';
  return 'Unassigned';
}

function classifyDelayBand(days) {
  if (days == null) return { key: 'unknown', label: 'No Date', badge: '' };
  if (days <= 3) return { key: 'fast', label: '0–3d (Fast)', badge: 'green' };
  if (days <= 7) return { key: 'moderate', label: '4–7d (Normal)', badge: 'blue' };
  if (days <= 14) return { key: 'delayed', label: '8–14d (Delayed)', badge: 'amber' };
  return { key: 'critical', label: '15+d (Critical)', badge: 'red' };
}

function avgOf(nums) {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

function medianOf(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const val = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(val * 10) / 10;
}

/**
 * Build the Request Items Delay & Lead-Time Report dataset.
 * @param {object} query
 * @param {object} opts - { ws: number|null }
 */
function buildRequestDelayReport(query = {}, opts = {}) {
  const ws = opts.ws || null;
  const today = new Date().toISOString().slice(0, 10);

  // 1. Pre-index all positive GRN receipts by mrn_line_id and fallback (mrn_id + description)
  const grnRows = all(`
    SELECT g.id,
           g.grn_no,
           g.mrn_id,
           g.mrn_line_id,
           LOWER(TRIM(COALESCE(g.description, ''))) AS desc_key,
           COALESCE(g.qty, 0) AS qty,
           g.unit_price,
           TRIM(COALESCE(g.supplier, '')) AS supplier,
           TRIM(COALESCE(g.invoice_no, '')) AS invoice_no,
           date(COALESCE(NULLIF(TRIM(g.delivery_date), ''), NULLIF(TRIM(g.grn_date), ''))) AS recv_date
      FROM grn g
     WHERE COALESCE(g.qty, 0) > 0
       AND (g.mrn_line_id IS NOT NULL OR g.mrn_id IS NOT NULL)
  `);

  const grnByLineId = new Map();
  const grnByMrnDesc = new Map();

  for (const g of grnRows) {
    if (g.mrn_line_id) {
      let arr = grnByLineId.get(g.mrn_line_id);
      if (!arr) { arr = []; grnByLineId.set(g.mrn_line_id, arr); }
      arr.push(g);
    } else if (g.mrn_id && g.desc_key) {
      const k = `${g.mrn_id}|${g.desc_key}`;
      let arr = grnByMrnDesc.get(k);
      if (!arr) { arr = []; grnByMrnDesc.set(k, arr); }
      arr.push(g);
    }
  }

  // 2. Fetch MRN lines
  const where = [
    'COALESCE(ml.is_cancelled, 0) = 0',
    "COALESCE(m.status, '') <> 'cancelled'",
    "COALESCE(m.approval_status, '') <> 'rejected'",
  ];
  const params = [];

  if (ws) {
    where.push('COALESCE(m.workshop_id, 1) = ?');
    params.push(Number(ws));
  }

  const rawLines = all(`
    SELECT ml.id AS line_id,
           ml.mrn_id,
           m.mrn_no,
           m.chain_no,
           m.req_date,
           m.required_date,
           m.certified_at,
           m.approved_at,
           m.approval_status,
           m.status AS mrn_status,
           m.requested_by,
           m.workshop_id,
           w.code AS workshop_code,
           w.name AS workshop_name,
           ml.description,
           ml.category,
           ml.unit,
           COALESCE(ml.qty, 0) AS qty_requested,
           COALESCE(ml.qty_received, 0) AS qty_received_col,
           COALESCE(ml.qty_short, 0) AS qty_short,
           COALESCE(ml.purchase_source, m.purchase_source) AS raw_source,
           ml.buying_priority,
           ml.priority_note,
           ml.purchased_at,
           ml.supplier AS line_supplier,
           a.id AS asset_id,
           a.code AS asset_code,
           a.registration AS asset_reg,
           j.id AS job_id,
           j.job_no
      FROM mrn_lines ml
      JOIN mrn m ON m.id = ml.mrn_id
      LEFT JOIN assets a ON a.id = m.asset_id
      LEFT JOIN job_cards j ON j.id = m.job_id
      LEFT JOIN workshops w ON w.id = m.workshop_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.req_date DESC, m.id DESC, ml.id ASC
  `, ...params);

  // Filter parameters
  const dateField = query.date_field === 'received_date' ? 'received_date' : 'req_date';
  const fromDate = d10(query.from);
  const toDate = d10(query.to);
  const statusFilter = String(query.status || 'all').toLowerCase();
  const sourceFilter = String(query.source || 'all').toLowerCase();
  const priorityFilter = String(query.priority || '').trim().toUpperCase();
  const minDays = query.min_days != null && query.min_days !== '' ? Number(query.min_days) : null;
  const qRaw = String(query.q || '').trim().toLowerCase();

  const processed = [];

  for (const r of rawLines) {
    const lineGrns = grnByLineId.get(r.line_id)
      || grnByMrnDesc.get(`${r.mrn_id}|${String(r.description || '').trim().toLowerCase()}`)
      || [];

    const validDates = lineGrns.map((g) => g.recv_date).filter(Boolean).sort();
    const firstReceivedDate = validDates.length ? validDates[0] : '';
    const lastReceivedDate = validDates.length ? validDates[validDates.length - 1] : '';
    const distinctReceiptDays = new Set(validDates).size;

    const grnQtySum = Math.round(lineGrns.reduce((s, g) => s + (Number(g.qty) || 0), 0) * 100) / 100;
    const qtyRequested = Math.round((Number(r.qty_requested) || 0) * 100) / 100;
    const qtyReceived = Math.round(Math.max(Number(r.qty_received_col) || 0, grnQtySum) * 100) / 100;
    const qtyPending = Math.max(0, Math.round((qtyRequested - qtyReceived) * 100) / 100);

    const grnNos = [...new Set(lineGrns.map((g) => g.grn_no).filter(Boolean))].join(', ');
    const suppliersList = [...new Set([
      ...lineGrns.map((g) => g.supplier).filter(Boolean),
      r.line_supplier ? String(r.line_supplier).trim() : '',
    ].filter(Boolean))];
    const supplierStr = suppliersList.join(', ');
    const invoiceNos = [...new Set(lineGrns.map((g) => g.invoice_no).filter(Boolean))].join(', ');
    const totalValue = Math.round(lineGrns.reduce((s, g) => s + ((Number(g.qty) || 0) * (Number(g.unit_price) || 0)), 0) * 100) / 100;

    const reqDate = d10(r.req_date);
    const certifiedDate = d10(r.certified_at);
    const approvedDate = d10(r.approved_at) || certifiedDate;
    const purchasedDate = d10(r.purchased_at);

    const isReceived = qtyReceived > 0;
    const isCompleted = qtyRequested > 0 ? qtyReceived >= qtyRequested - 0.001 : isReceived;
    const isPartial = isReceived && !isCompleted;
    const isPending = !isCompleted;

    let fulfillmentStatus = 'pending';
    if (isCompleted) fulfillmentStatus = 'completed';
    else if (isPartial) fulfillmentStatus = 'partial';

    // Stage delays
    const approvalDays = (reqDate && approvedDate) ? diffDays(reqDate, approvedDate) : null;
    const firstDelayDays = (reqDate && firstReceivedDate) ? diffDays(reqDate, firstReceivedDate) : null;
    const delayDays = (reqDate && lastReceivedDate) ? diffDays(reqDate, lastReceivedDate) : null;
    const procurementDays = lastReceivedDate
      ? (approvedDate ? diffDays(approvedDate, lastReceivedDate) : (reqDate ? diffDays(reqDate, lastReceivedDate) : null))
      : null;
    const waitingDays = (isPending && reqDate) ? diffDays(reqDate, today) : null;

    // Effective delay used for sorting/filtering when looking at "All" or "Pending"
    const effectiveDelayDays = delayDays != null ? delayDays : waitingDays;
    const band = classifyDelayBand(effectiveDelayDays);

    const sourceNorm = normalizeSource(r.raw_source);
    const srcLabel = sourceLabel(sourceNorm);
    const vehicle = r.asset_reg || r.asset_code || (r.mrn_status === 'general' ? 'Store Stock' : '');

    // Apply Filters
    if (fromDate) {
      const cmpDate = dateField === 'received_date' ? lastReceivedDate : reqDate;
      if (!cmpDate || cmpDate < fromDate) continue;
    }
    if (toDate) {
      const cmpDate = dateField === 'received_date' ? lastReceivedDate : reqDate;
      if (!cmpDate || cmpDate > toDate) continue;
    }

    if (sourceFilter && sourceFilter !== 'all') {
      if ((sourceFilter === 'head_office' || sourceFilter === 'ho') && sourceNorm !== 'head_office') continue;
      if ((sourceFilter === 'local_purchase' || sourceFilter === 'local' || sourceFilter === 'lp') && sourceNorm !== 'local_purchase') continue;
      if (sourceFilter === 'unassigned' && sourceNorm !== 'unassigned') continue;
    }

    if (priorityFilter && (r.buying_priority || 'P3_ROUTINE') !== priorityFilter) continue;

    if (statusFilter === 'received' && !(isReceived && lastReceivedDate)) continue;
    if (statusFilter === 'completed' && !isCompleted) continue;
    if (statusFilter === 'partial' && !isPartial) continue;
    if (statusFilter === 'pending' && !isPending) continue;
    if (statusFilter === 'delayed' && !(effectiveDelayDays != null && effectiveDelayDays > 7)) continue;
    if (statusFilter === 'critical' && !(effectiveDelayDays != null && effectiveDelayDays >= 15)) continue;

    if (minDays != null && !Number.isNaN(minDays) && minDays > 0) {
      if (effectiveDelayDays == null || effectiveDelayDays < minDays) continue;
    }

    if (qRaw) {
      const hay = [
        r.mrn_no,
        r.chain_no,
        r.description,
        r.category,
        vehicle,
        r.asset_code,
        r.asset_reg,
        r.job_no,
        grnNos,
        supplierStr,
        invoiceNos,
        r.requested_by,
      ].join(' ').toLowerCase();
      if (!hay.includes(qRaw)) continue;
    }

    processed.push({
      line_id: r.line_id,
      mrn_id: r.mrn_id,
      mrn_no: r.mrn_no,
      chain_no: r.chain_no || null,
      workshop_id: r.workshop_id,
      workshop_code: r.workshop_code || '',
      workshop_name: r.workshop_name || '',
      vehicle,
      asset_id: r.asset_id,
      asset_code: r.asset_code || '',
      asset_reg: r.asset_reg || '',
      job_id: r.job_id,
      job_no: r.job_no || '',
      description: r.description || '',
      category: r.category || 'General',
      unit: r.unit || 'nos',
      source: sourceNorm,
      source_label: srcLabel,
      buying_priority: r.buying_priority || 'P3_ROUTINE',
      priority_note: r.priority_note || '',
      qty_requested: qtyRequested,
      qty_received: qtyReceived,
      qty_pending: qtyPending,
      fulfillment_status: fulfillmentStatus,
      req_date: reqDate,
      required_date: d10(r.required_date),
      certified_date: certifiedDate,
      approved_date: approvedDate,
      purchased_date: purchasedDate,
      first_received_date: firstReceivedDate,
      received_date: lastReceivedDate,
      receipt_days: distinctReceiptDays,
      grn_nos: grnNos,
      supplier: supplierStr,
      invoice_nos: invoiceNos,
      total_value: totalValue,
      approval_days: approvalDays,
      procurement_days: procurementDays,
      first_delay_days: firstDelayDays,
      delay_days: delayDays,
      waiting_days: waitingDays,
      effective_delay_days: effectiveDelayDays,
      delay_band: band.key,
      delay_band_label: band.label,
      delay_badge: band.badge,
    });
  }

  // 3. Compute Summary KPIs & Analytics over ALL matching rows (before pagination limit)
  const receivedWithDates = processed.filter((x) => x.delay_days != null);
  const allDelayNums = receivedWithDates.map((x) => x.delay_days);
  const approvalNums = processed.filter((x) => x.approval_days != null).map((x) => x.approval_days);
  const procurementNums = receivedWithDates.filter((x) => x.procurement_days != null).map((x) => x.procurement_days);

  const hoDelays = receivedWithDates.filter((x) => x.source === 'head_office').map((x) => x.delay_days);
  const lpDelays = receivedWithDates.filter((x) => x.source === 'local_purchase').map((x) => x.delay_days);

  const pendingItems = processed.filter((x) => x.fulfillment_status !== 'completed');
  const pendingWaitNums = pendingItems.filter((x) => x.waiting_days != null).map((x) => x.waiting_days);

  const buckets = {
    fast_0_3: 0,
    moderate_4_7: 0,
    delayed_8_14: 0,
    critical_15_30: 0,
    critical_30_plus: 0,
  };

  for (const x of receivedWithDates) {
    const d = x.delay_days;
    if (d <= 3) buckets.fast_0_3++;
    else if (d <= 7) buckets.moderate_4_7++;
    else if (d <= 14) buckets.delayed_8_14++;
    else if (d <= 30) buckets.critical_15_30++;
    else buckets.critical_30_plus++;
  }

  const onTimeCount = buckets.fast_0_3 + buckets.moderate_4_7;
  const onTimeRatePct = receivedWithDates.length
    ? Math.round((onTimeCount / receivedWithDates.length) * 1000) / 10
    : 0;

  const summary = {
    as_of: today,
    total_lines: processed.length,
    received_lines: receivedWithDates.length,
    completed_lines: processed.filter((x) => x.fulfillment_status === 'completed').length,
    partial_lines: processed.filter((x) => x.fulfillment_status === 'partial').length,
    pending_lines: pendingItems.length,
    avg_delay_days: avgOf(allDelayNums),
    median_delay_days: medianOf(allDelayNums),
    max_delay_days: allDelayNums.length ? Math.max(...allDelayNums) : 0,
    min_delay_days: allDelayNums.length ? Math.min(...allDelayNums) : 0,
    avg_approval_days: avgOf(approvalNums),
    avg_procurement_days: avgOf(procurementNums),
    on_time_count: onTimeCount,
    on_time_rate_pct: onTimeRatePct,
    fast_count: buckets.fast_0_3,
    moderate_count: buckets.moderate_4_7,
    delayed_count: buckets.delayed_8_14,
    critical_count: buckets.critical_15_30 + buckets.critical_30_plus,
    head_office_count: hoDelays.length,
    head_office_avg_days: avgOf(hoDelays),
    local_purchase_count: lpDelays.length,
    local_purchase_avg_days: avgOf(lpDelays),
    oldest_pending_days: pendingWaitNums.length ? Math.max(...pendingWaitNums) : 0,
    avg_pending_waiting_days: avgOf(pendingWaitNums),
    buckets,
  };

  // 4. Breakdown by Purchase Source
  const bySourceMap = new Map([
    ['head_office', { source: 'head_office', label: 'Head Office', total_items: 0, received_items: 0, pending_items: 0, delays: [], on_time: 0, critical: 0, total_value: 0 }],
    ['local_purchase', { source: 'local_purchase', label: 'Local Purchase', total_items: 0, received_items: 0, pending_items: 0, delays: [], on_time: 0, critical: 0, total_value: 0 }],
    ['unassigned', { source: 'unassigned', label: 'Unassigned', total_items: 0, received_items: 0, pending_items: 0, delays: [], on_time: 0, critical: 0, total_value: 0 }],
  ]);

  for (const x of processed) {
    const b = bySourceMap.get(x.source) || bySourceMap.get('unassigned');
    b.total_items++;
    b.total_value = Math.round((b.total_value + (x.total_value || 0)) * 100) / 100;
    if (x.delay_days != null) {
      b.received_items++;
      b.delays.push(x.delay_days);
      if (x.delay_days <= 7) b.on_time++;
      if (x.delay_days >= 15) b.critical++;
    }
    if (x.fulfillment_status !== 'completed') {
      b.pending_items++;
    }
  }

  const by_source = [...bySourceMap.values()]
    .filter((b) => b.total_items > 0)
    .map((b) => ({
      source: b.source,
      label: b.label,
      total_items: b.total_items,
      received_items: b.received_items,
      pending_items: b.pending_items,
      avg_delay_days: avgOf(b.delays),
      median_delay_days: medianOf(b.delays),
      max_delay_days: b.delays.length ? Math.max(...b.delays) : 0,
      on_time_rate_pct: b.received_items ? Math.round((b.on_time / b.received_items) * 1000) / 10 : 0,
      critical_count: b.critical,
      total_value: b.total_value,
    }));

  // 5. Breakdown by Supplier (for received items)
  const supplierMap = new Map();
  for (const x of receivedWithDates) {
    const supName = x.supplier || '(Unspecified Supplier)';
    let s = supplierMap.get(supName);
    if (!s) {
      s = { supplier: supName, items_count: 0, delays: [], delayed_over_7d: 0, critical_15d: 0, total_value: 0 };
      supplierMap.set(supName, s);
    }
    s.items_count++;
    s.delays.push(x.delay_days);
    if (x.delay_days > 7) s.delayed_over_7d++;
    if (x.delay_days >= 15) s.critical_15d++;
    s.total_value = Math.round((s.total_value + (x.total_value || 0)) * 100) / 100;
  }

  const by_supplier = [...supplierMap.values()]
    .map((s) => ({
      supplier: s.supplier,
      items_count: s.items_count,
      avg_delay_days: avgOf(s.delays),
      min_delay_days: Math.min(...s.delays),
      max_delay_days: Math.max(...s.delays),
      delayed_over_7d: s.delayed_over_7d,
      critical_15d: s.critical_15d,
      on_time_rate_pct: s.items_count ? Math.round(((s.items_count - s.delayed_over_7d) / s.items_count) * 1000) / 10 : 0,
      total_value: s.total_value,
    }))
    .sort((a, b) => b.items_count - a.items_count || b.avg_delay_days - a.avg_delay_days)
    .slice(0, 30);

  // 6. Sorting
  const sortKey = String(query.sort || 'delay_desc').toLowerCase();
  processed.sort((a, b) => {
    if (sortKey === 'delay_asc') {
      const da = a.effective_delay_days != null ? a.effective_delay_days : 999999;
      const db = b.effective_delay_days != null ? b.effective_delay_days : 999999;
      return da - db || String(b.req_date).localeCompare(String(a.req_date));
    }
    if (sortKey === 'req_desc') return String(b.req_date).localeCompare(String(a.req_date)) || b.mrn_id - a.mrn_id;
    if (sortKey === 'req_asc') return String(a.req_date).localeCompare(String(b.req_date)) || a.mrn_id - b.mrn_id;
    if (sortKey === 'recv_desc') return String(b.received_date || '').localeCompare(String(a.received_date || '')) || b.mrn_id - a.mrn_id;
    if (sortKey === 'recv_asc') return String(a.received_date || '9999').localeCompare(String(b.received_date || '9999')) || a.mrn_id - b.mrn_id;
    // Default: delay_desc (longest delay first)
    const da = a.effective_delay_days != null ? a.effective_delay_days : -1;
    const db = b.effective_delay_days != null ? b.effective_delay_days : -1;
    return db - da || String(b.req_date).localeCompare(String(a.req_date));
  });

  const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 10000);
  const rows = processed.slice(0, limit);

  return {
    summary,
    by_source,
    by_supplier,
    total_matching: processed.length,
    rows,
    all_rows: opts.includeAllRows ? processed : undefined,
  };
}

/**
 * Build a multi-sheet ExcelJS Workbook for the Request Items Delay Report.
 */
function buildRequestDelayWorkbook(data, workshopTitle = '') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  wb.created = new Date();

  const s = data.summary || {};
  const allRows = data.all_rows || data.rows || [];
  const receivedRows = allRows.filter((r) => r.delay_days != null);
  const pendingRows = allRows.filter((r) => r.fulfillment_status !== 'completed');

  const headerStyle = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    r.alignment = { vertical: 'middle' };
    r.height = 22;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  // Sheet 1: Summary & KPIs
  const wsSum = wb.addWorksheet('Summary & KPIs');
  wsSum.columns = [
    { header: 'Metric / Category', key: 'metric', width: 38 },
    { header: 'Value', key: 'value', width: 22 },
    { header: 'Notes / Breakdown', key: 'notes', width: 46 },
  ];
  headerStyle(wsSum);
  const sumRows = [
    { metric: 'Report Title', value: `Request & Delivery Delay Report${workshopTitle}`, notes: `Generated as of ${s.as_of || ''}` },
    { metric: 'Total Requested Items Analyzed', value: s.total_lines || 0, notes: `${s.received_lines || 0} received · ${s.pending_lines || 0} still pending` },
    { metric: 'Average Delivery Delay (Req → Recv)', value: `${s.avg_delay_days || 0} days`, notes: `Median: ${s.median_delay_days || 0} days · Max: ${s.max_delay_days || 0} days` },
    { metric: 'Average Approval Time (Req → Approved)', value: `${s.avg_approval_days || 0} days`, notes: 'Internal workshop certification & approval time' },
    { metric: 'Average Procurement Time (Approved → Recv)', value: `${s.avg_procurement_days || 0} days`, notes: 'Purchasing & supplier delivery lead time' },
    { metric: 'On-Time Delivery Rate (≤ 7 Days)', value: `${s.on_time_rate_pct || 0}%`, notes: `${s.on_time_count || 0} of ${s.received_lines || 0} received items delivered within 7 days` },
    { metric: 'Head Office Avg Lead-Time', value: `${s.head_office_avg_days || 0} days`, notes: `${s.head_office_count || 0} received items` },
    { metric: 'Local Purchase Avg Lead-Time', value: `${s.local_purchase_avg_days || 0} days`, notes: `${s.local_purchase_count || 0} received items` },
    { metric: 'Fast Deliveries (0–3 Days)', value: s.fast_count || 0, notes: 'Delivered within 3 days of request' },
    { metric: 'Normal Deliveries (4–7 Days)', value: s.moderate_count || 0, notes: 'Delivered within 4 to 7 days of request' },
    { metric: 'Delayed Deliveries (8–14 Days)', value: s.delayed_count || 0, notes: 'Took 1 to 2 weeks from request date' },
    { metric: 'Critically Delayed Deliveries (15+ Days)', value: s.critical_count || 0, notes: 'Took more than 14 days from request date' },
    { metric: 'Still Pending Items (Waiting Delivery)', value: s.pending_lines || 0, notes: `Avg wait: ${s.avg_pending_waiting_days || 0} days · Oldest waiting: ${s.oldest_pending_days || 0} days` },
  ];
  for (const r of sumRows) wsSum.addRow(r);

  // Sheet 2: Received Items Delay (Request Date vs Received Date)
  const wsRec = wb.addWorksheet('Received Items Delay');
  wsRec.columns = [
    { header: 'MRN No', key: 'mrn_no', width: 13 },
    { header: 'Vehicle / Asset', key: 'vehicle', width: 16 },
    { header: 'Job No', key: 'job_no', width: 14 },
    { header: 'Item Description', key: 'description', width: 38 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Source', key: 'source_label', width: 16 },
    { header: 'Qty Req', key: 'qty_requested', width: 10 },
    { header: 'Qty Recv', key: 'qty_received', width: 10 },
    { header: 'Request Date', key: 'req_date', width: 14 },
    { header: 'Approved Date', key: 'approved_date', width: 14 },
    { header: 'First Recv Date', key: 'first_received_date', width: 14 },
    { header: 'Received Date (GRN)', key: 'received_date', width: 16 },
    { header: 'Approval Days', key: 'approval_days', width: 14 },
    { header: 'Buying/Supplier Days', key: 'procurement_days', width: 18 },
    { header: 'Total Delay (Days)', key: 'delay_days', width: 18 },
    { header: 'Delay Band', key: 'delay_band_label', width: 18 },
    { header: 'GRN No(s)', key: 'grn_nos', width: 16 },
    { header: 'Supplier', key: 'supplier', width: 24 },
    { header: 'GRN Value (Rs)', key: 'total_value', width: 16 },
  ];
  headerStyle(wsRec);
  for (const r of receivedRows) {
    wsRec.addRow(r);
  }

  // Sheet 3: Pending & Overdue Items
  const wsPend = wb.addWorksheet('Pending & Overdue Items');
  wsPend.columns = [
    { header: 'MRN No', key: 'mrn_no', width: 13 },
    { header: 'Vehicle / Asset', key: 'vehicle', width: 16 },
    { header: 'Job No', key: 'job_no', width: 14 },
    { header: 'Item Description', key: 'description', width: 38 },
    { header: 'Source', key: 'source_label', width: 16 },
    { header: 'Priority', key: 'buying_priority', width: 15 },
    { header: 'Qty Req', key: 'qty_requested', width: 10 },
    { header: 'Qty Recv', key: 'qty_received', width: 10 },
    { header: 'Qty Pending', key: 'qty_pending', width: 12 },
    { header: 'Request Date', key: 'req_date', width: 14 },
    { header: 'Approved Date', key: 'approved_date', width: 14 },
    { header: 'Ordered Date', key: 'purchased_date', width: 14 },
    { header: 'Waiting Days (To Today)', key: 'waiting_days', width: 20 },
    { header: 'Delay Severity', key: 'delay_band_label', width: 18 },
    { header: 'Supplier / Note', key: 'supplier', width: 24 },
  ];
  headerStyle(wsPend);
  for (const r of pendingRows) {
    wsPend.addRow(r);
  }

  // Sheet 4: Supplier & Source Performance
  const wsSup = wb.addWorksheet('Supplier Performance');
  wsSup.columns = [
    { header: 'Supplier / Channel', key: 'supplier', width: 32 },
    { header: 'Received Items', key: 'items_count', width: 16 },
    { header: 'Avg Delay (Days)', key: 'avg_delay_days', width: 18 },
    { header: 'Min Days', key: 'min_delay_days', width: 12 },
    { header: 'Max Days', key: 'max_delay_days', width: 12 },
    { header: 'Delayed (> 7 Days)', key: 'delayed_over_7d', width: 18 },
    { header: 'Critical (15+ Days)', key: 'critical_15d', width: 18 },
    { header: 'On-Time Rate (≤ 7d %)', key: 'on_time_rate_pct', width: 20 },
    { header: 'Total GRN Value (Rs)', key: 'total_value', width: 20 },
  ];
  headerStyle(wsSup);
  for (const r of data.by_supplier || []) {
    wsSup.addRow(r);
  }

  return wb;
}

/**
 * Render an official A4 Landscape printable HTML report for Request Items Delay.
 */
function renderRequestDelayPrintHtml(data, workshopTitle = '', query = {}) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const s = data.summary || {};
  const rows = data.rows || [];
  const bySource = data.by_source || [];

  const badgeStyle = (band) => {
    if (band === 'fast') return 'background:#dcfce7;color:#166534;border:1px solid #86efac';
    if (band === 'moderate') return 'background:#dbeafe;color:#1e40af;border:1px solid #93c5fd';
    if (band === 'delayed') return 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d';
    if (band === 'critical') return 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5';
    return 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db';
  };

  const filterDesc = [
    query.from || query.to ? `Date Range: ${query.from || 'Start'} to ${query.to || 'Today'}` : 'All Dates',
    query.source && query.source !== 'all' ? `Source: ${query.source}` : 'All Sources',
    query.status && query.status !== 'all' ? `Status: ${query.status}` : 'All Statuses',
    query.min_days ? `Min Delay: ≥ ${query.min_days} days` : '',
    query.q ? `Search: "${query.q}"` : '',
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Request Items Delay &amp; Lead-Time Report${esc(workshopTitle)}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #111827; margin: 16px; font-size: 11.5px; }
    .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 12px; }
    .hdr h1 { margin: 0; font-size: 18px; color: #1e3a8a; }
    .hdr .sub { color: #4b5563; font-size: 12px; margin-top: 2px; }
    .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 12px; }
    .kpi { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; background: #f8fafc; }
    .kpi .lbl { font-size: 10.5px; color: #6b7280; text-transform: uppercase; font-weight: 600; }
    .kpi .val { font-size: 16px; font-weight: 700; color: #111827; margin-top: 2px; }
    .kpi .note { font-size: 10px; color: #4b5563; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 11px; }
    th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 700; color: #1e293b; }
    td.num, th.num { text-align: right; }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 99px; font-weight: 700; font-size: 10.5px; white-space: nowrap; }
    .noprint { margin-bottom: 12px; }
    .btn { background: #1e3a8a; color: #fff; border: none; padding: 7px 14px; border-radius: 5px; cursor: pointer; font-weight: 600; font-size: 12px; }
    @media print { .noprint { display: none !important; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="noprint">
    <button class="btn" data-print>🖨 Print / Save as PDF</button><script src="/js/dom-actions.js"></script>
  </div>
  <div class="hdr">
    <div>
      <h1>EDWARD &amp; CHRISTIE (PVT) LTD — REQUEST ITEMS DELAY &amp; LEAD-TIME REPORT${esc(workshopTitle)}</h1>
      <div class="sub">${esc(filterDesc)} · Generated on ${esc(s.as_of)}</div>
    </div>
    <div style="text-align:right;font-size:11px;color:#374151">
      <b>Total Rows:</b> ${rows.length} (of ${data.total_matching || rows.length})<br>
      <b>On-Time Target:</b> ≤ 7 Days
    </div>
  </div>

  <div class="kpis">
    <div class="kpi">
      <div class="lbl">Avg Delivery Delay</div>
      <div class="val">${s.avg_delay_days || 0} Days</div>
      <div class="note">Median: ${s.median_delay_days || 0}d · Max: ${s.max_delay_days || 0}d</div>
    </div>
    <div class="kpi">
      <div class="lbl">Stage Split (Avg)</div>
      <div class="val">${s.avg_approval_days || 0}d + ${s.avg_procurement_days || 0}d</div>
      <div class="note">Approval: ${s.avg_approval_days || 0}d · Buying: ${s.avg_procurement_days || 0}d</div>
    </div>
    <div class="kpi">
      <div class="lbl">Head Office vs Local</div>
      <div class="val">HO: ${s.head_office_avg_days || 0}d / LP: ${s.local_purchase_avg_days || 0}d</div>
      <div class="note">HO (${s.head_office_count || 0}) · Local (${s.local_purchase_count || 0})</div>
    </div>
    <div class="kpi">
      <div class="lbl">On-Time Rate (≤ 7d)</div>
      <div class="val" style="color:#166534">${s.on_time_rate_pct || 0}%</div>
      <div class="note">${s.on_time_count || 0} of ${s.received_lines || 0} received items</div>
    </div>
    <div class="kpi">
      <div class="lbl">Critically Delayed (15+d)</div>
      <div class="val" style="color:#991b1b">${s.critical_count || 0} Items</div>
      <div class="note">8–14d Delayed: ${s.delayed_count || 0} items</div>
    </div>
    <div class="kpi">
      <div class="lbl">Still Pending (Unreceived)</div>
      <div class="val" style="color:#b45309">${s.pending_lines || 0} Items</div>
      <div class="note">Avg Wait: ${s.avg_pending_waiting_days || 0}d · Max: ${s.oldest_pending_days || 0}d</div>
    </div>
  </div>

  ${bySource.length ? `
  <table>
    <thead>
      <tr>
        <th>Purchase Channel</th>
        <th class="num">Total Items</th>
        <th class="num">Received Items</th>
        <th class="num">Still Pending</th>
        <th class="num">Avg Delay (Days)</th>
        <th class="num">Median Delay</th>
        <th class="num">Max Delay</th>
        <th class="num">On-Time Rate (≤ 7d)</th>
        <th class="num">Critical (15+d)</th>
      </tr>
    </thead>
    <tbody>
      ${bySource.map((b) => `<tr>
        <td><b>${esc(b.label)}</b></td>
        <td class="num">${b.total_items}</td>
        <td class="num">${b.received_items}</td>
        <td class="num">${b.pending_items}</td>
        <td class="num"><b>${b.avg_delay_days} d</b></td>
        <td class="num">${b.median_delay_days} d</td>
        <td class="num">${b.max_delay_days} d</td>
        <td class="num">${b.on_time_rate_pct}%</td>
        <td class="num">${b.critical_count}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : ''}

  <table>
    <thead>
      <tr>
        <th style="width:34px">#</th>
        <th style="width:68px">MRN No</th>
        <th style="width:90px">Vehicle / Job</th>
        <th>Item Description</th>
        <th style="width:86px">Source</th>
        <th class="num" style="width:68px">Req / Recv</th>
        <th style="width:76px">Req Date</th>
        <th style="width:76px">Appr Date</th>
        <th style="width:76px">Recv Date</th>
        <th style="width:130px">GRN &amp; Supplier</th>
        <th class="num" style="width:52px">Appr d</th>
        <th class="num" style="width:52px">Buy d</th>
        <th style="width:110px">Delay / Wait Time</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td><b>${esc(r.mrn_no)}</b></td>
        <td>${esc(r.vehicle)}${r.job_no ? `<br><span style="color:#6b7280;font-size:10px">${esc(r.job_no)}</span>` : ''}</td>
        <td><b>${esc(r.description)}</b> <span style="color:#6b7280;font-size:10px">(${esc(r.unit)})</span></td>
        <td>${esc(r.source_label)}</td>
        <td class="num">${r.qty_requested} / <b>${r.qty_received}</b></td>
        <td>${esc(r.req_date || '—')}</td>
        <td>${esc(r.approved_date || '—')}</td>
        <td><b>${esc(r.received_date || (r.fulfillment_status === 'pending' ? 'Pending' : '—'))}</b>${r.receipt_days > 1 ? `<br><span style="font-size:9.5px;color:#6b7280">1st: ${esc(r.first_received_date)} (${r.receipt_days} drops)</span>` : ''}</td>
        <td>${r.grn_nos ? `<b>GRN ${esc(r.grn_nos)}</b>` : '—'}${r.supplier ? `<br><span style="font-size:10px;color:#4b5563">${esc(r.supplier)}</span>` : ''}</td>
        <td class="num">${r.approval_days != null ? r.approval_days + 'd' : '—'}</td>
        <td class="num">${r.procurement_days != null ? r.procurement_days + 'd' : '—'}</td>
        <td>
          ${r.delay_days != null
            ? `<span class="pill" style="${badgeStyle(r.delay_band)}">⏱ ${r.delay_days} day${r.delay_days === 1 ? '' : 's'}</span>`
            : (r.waiting_days != null
              ? `<span class="pill" style="${badgeStyle(r.delay_band)}">⏳ Waiting ${r.waiting_days}d</span>`
              : '—')}
        </td>
      </tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`;
}

module.exports = {
  buildRequestDelayReport,
  buildRequestDelayWorkbook,
  renderRequestDelayPrintHtml,
  diffDays,
  classifyDelayBand,
};
