'use strict';

const { get, all } = require('../db');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const d = (v) => (v ? String(v).slice(0, 10) : '');
const num = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
const money = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Safe base64 image data-URL validator for signature embedding
const sigSrc = (v) => (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(v || '')) ? String(v) : '');

/** Shared CSS matching Edward & Christie printed form books */
function getDocumentCss() {
  return `
    @page {
      size: A4 landscape;
      margin: 8mm 12mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #f4f6f8;
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      color: #000;
      font-size: 11px;
      line-height: 1.25;
    }
    .sheet {
      border: 1.5px solid #000;
      width: 100%;
      max-width: 1060px;
      margin: 12px auto;
      background: #fff;
      padding: 0;
      box-shadow: 0 4px 14px rgba(0,0,0,0.12);
    }
    
    /* Document Header Box (50% / 50% split) */
    .hd {
      display: flex;
      align-items: stretch;
      border-bottom: 1.5px solid #000;
      min-height: 38px;
    }
    .hd .co {
      flex: 1;
      padding: 6px 12px;
      font-family: "Times New Roman", Times, Georgia, serif;
      font-weight: bold;
      font-size: 17px;
      border-right: 1.5px solid #000;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      letter-spacing: 0.3px;
    }
    .hd .ti {
      flex: 1;
      padding: 6px 12px;
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      font-weight: bold;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    
    /* Address Subheader for GRN & MTN */
    .addr-sub {
      border-bottom: 1.5px solid #000;
      padding: 3px 12px;
      font-size: 10px;
      text-align: center;
      font-weight: 500;
      background: #fff;
      letter-spacing: 0.2px;
    }

    /* Metadata strip with pre-printed dotted lines */
    .meta-strip {
      display: flex;
      align-items: baseline;
      padding: 4px 8px;
      font-size: 11.5px;
      gap: 12px;
    }
    .meta-field {
      display: flex;
      align-items: baseline;
    }
    .meta-label {
      font-weight: bold;
      white-space: nowrap;
      margin-right: 6px;
      font-size: 11.5px;
    }
    .meta-dots {
      flex: 1;
      border-bottom: 1px dotted #555;
      min-height: 16px;
      padding: 0 4px;
      font-size: 11px;
      color: #111;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta-dots.stamp-dots {
      border-bottom: 1px dotted #888;
      display: flex;
      align-items: baseline;
      justify-content: center;
      padding: 0 6px;
    }

    /* Mechanical Stamped Number */
    .stamp-no {
      font-family: "Courier New", Courier, monospace;
      font-size: 17px;
      font-weight: 900;
      color: #a80000;
      letter-spacing: 1.5px;
    }

    /* GRN Boxed Metadata Grid (matches authentic voucher) */
    .grn-meta-table {
      width: 100%;
      border-collapse: collapse;
      border-bottom: 1.5px solid #000;
      font-size: 11px;
    }
    .grn-meta-table td {
      border-bottom: 1px solid #000;
      border-right: 1px solid #000;
      padding: 4px 8px;
      vertical-align: middle;
      height: 24px;
    }
    .grn-meta-table td:last-child {
      border-right: none;
    }
    .grn-meta-table tr:last-child td {
      border-bottom: none;
    }
    .grn-meta-table b {
      margin-right: 4px;
    }

    /* Data Table */
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      border-top: 1.5px solid #000;
      border-bottom: 1.5px solid #000;
    }
    table.data-table th {
      border-left: 1px solid #000;
      border-right: 1px solid #000;
      border-top: 1.5px solid #000;
      border-bottom: 1.5px solid #000;
      background: #f7f7f7;
      font-size: 10.5px;
      font-weight: bold;
      text-align: center;
      padding: 3px 4px;
      line-height: 1.2;
    }
    table.data-table th:first-child {
      border-left: none;
    }
    table.data-table th:last-child {
      border-right: none;
    }
    table.data-table td {
      border-left: 1px solid #000;
      border-right: 1px solid #000;
      border-bottom: 1px dotted #888;
      padding: 2px 5px;
      height: 22px;
      font-size: 10.5px;
      vertical-align: middle;
    }
    table.data-table td:first-child {
      border-left: none;
    }
    table.data-table td:last-child {
      border-right: none;
    }
    table.data-table tr:last-child td {
      border-bottom: none;
    }
    table.data-table td.c {
      text-align: center;
    }
    table.data-table td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      padding-right: 6px;
    }

    /* Signature Table */
    table.sig-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      border-top: 1.5px solid #000;
      border-bottom: 1.5px solid #000;
    }
    table.sig-table th, table.sig-table td {
      border: 1px solid #000;
      padding: 2px 6px;
      font-size: 10.5px;
      vertical-align: middle;
    }
    table.sig-table th:first-child, table.sig-table td:first-child {
      border-left: none;
    }
    table.sig-table th:last-child, table.sig-table td:last-child {
      border-right: none;
    }
    table.sig-table th {
      background: #f7f7f7;
      font-weight: bold;
      text-align: center;
      height: 22px;
    }
    table.sig-table td.lbl {
      font-weight: bold;
      width: 82px;
      background: #fdfdfd;
      text-align: left;
    }
    table.sig-table tr.sig-row td {
      height: 34px;
      text-align: center;
    }
    .sig-img {
      max-height: 30px;
      max-width: 130px;
      display: block;
      margin: 0 auto;
    }
    .auth-seal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid #1a7f37;
      background: #f0fff4;
      color: #1a7f37;
      font-size: 8.5px;
      font-weight: bold;
      padding: 2px 6px;
      border-radius: 3px;
      letter-spacing: 0.5px;
    }
    .auth-seal .auth-tick {
      font-weight: 900;
      font-size: 10px;
    }
    .dotted-pen-line {
      color: #aaa;
      letter-spacing: 1.5px;
      font-size: 10px;
      display: block;
      text-align: center;
    }

    /* Document ISO Footer */
    .foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px;
      font-size: 9px;
      font-weight: bold;
      color: #333;
      background: #fff;
    }

    /* Interactive Toolbar */
    .toolbar {
      max-width: 1060px;
      margin: 12px auto 6px auto;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .toolbar button, .toolbar a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 15px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      text-decoration: none;
      border: 1px solid #ccc;
      background: #fff;
      color: #24292f;
      box-shadow: 0 1px 2px rgba(0,0,0,0.06);
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .toolbar button:hover, .toolbar a:hover {
      background: #f3f4f6;
      border-color: #bbb;
    }
    .toolbar a.primary {
      background: #0969da;
      color: #fff;
      border-color: #0969da;
      box-shadow: 0 1px 2px rgba(9,105,218,0.2);
    }
    .toolbar a.primary:hover {
      background: #0856b3;
      border-color: #0856b3;
    }

    /* Print media overrides */
    @media print {
      .noprint { display: none !important; }
      html, body { background: #fff !important; padding: 0 !important; margin: 0 !important; }
      .sheet {
        border: 1.5px solid #000 !important;
        margin: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        box-shadow: none !important;
      }
    }
  `;
}

function renderControls(docType, id, forPdf) {
  if (forPdf) return '';
  return `
    <div class="toolbar noprint">
      <button type="button" onclick="history.back()">← Back</button>
      <button type="button" onclick="window.print()">🖨 Print / Save as PDF</button>
      <a class="primary" href="/api/stores/${docType}/${id}/download.pdf" download>⬇ Download Official PDF</a>
    </div>`;
}

function renderSignatureCell(name, sigDataUrl) {
  if (sigDataUrl && sigSrc(sigDataUrl) && sigDataUrl.length > 200) {
    return `<img class="sig-img" src="${sigSrc(sigDataUrl)}" alt="Signature">`;
  }
  if (name) {
    return `<div class="auth-seal"><span class="auth-tick">✓</span><span>DIGITALLY AUTHENTICATED</span></div>`;
  }
  return '<span class="dotted-pen-line">................................................</span>';
}

function renderValueCell(val) {
  return val ? esc(val) : '<span class="dotted-pen-line">................................................</span>';
}

function renderDateCell(date) {
  return date ? esc(d(date)) : '<span class="dotted-pen-line">....................</span>';
}

// ---------------------------------------------------------------------------
// 1. Material Issue Note (MIN) — Doc. No. EC1.ST.FO.04
// ---------------------------------------------------------------------------
function renderMinDocumentHtml(minIdOrNo, { forPdf = false } = {}) {
  let note = get('SELECT n.*, a.code AS asset_code, a.registration AS asset_reg, p.name AS project_name, j.job_no ' +
    'FROM min_notes n LEFT JOIN assets a ON a.id = n.asset_id LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN job_cards j ON j.id = n.job_id WHERE n.id = ? OR n.min_no = ?', minIdOrNo, minIdOrNo);

  let items = [];
  if (note) {
    items = all("SELECT i.*, COALESCE(i.unit, 'nos') as unit_label FROM issues i WHERE i.min_id = ? OR i.min_no = ? ORDER BY i.id", note.id, note.min_no);
  } else {
    // Fallback: If querying an individual issue that does not have a min_notes record yet
    const single = get('SELECT i.*, a.code AS asset_code, a.registration AS asset_reg, j.job_no FROM issues i LEFT JOIN assets a ON a.id = i.asset_id LEFT JOIN job_cards j ON j.id = i.job_id WHERE i.id = ?', minIdOrNo);
    if (!single) return null;
    note = {
      id: single.id,
      min_no: single.min_no || ('MIN-' + String(single.id).padStart(4, '0')),
      issue_date: single.issue_date,
      asset_code: single.asset_code,
      asset_reg: single.asset_reg,
      job_no: single.job_no,
      purpose: single.purpose || ('Job Card ' + (single.job_no || '')),
      requested_by: single.issued_by || 'Storekeeper',
      approved_by: 'Workshop Foreman',
      received_by: 'Mechanic / Fitter',
    };
    items = [{ ...single, unit_label: single.unit || 'nos' }];
  }

  const MIN_ROWS = 12;
  const rows = [];
  let totalValue = 0;

  for (let i = 0; i < Math.max(MIN_ROWS, items.length); i++) {
    const it = items[i];
    const val = it && it.unit_price != null ? Number(it.qty || 0) * Number(it.unit_price) : null;
    if (val != null) totalValue += val;

    rows.push(`
      <tr>
        <td class="c">${it ? (i + 1) : ''}</td>
        <td>${esc(it ? it.description : '')}</td>
        <td class="c">${esc(it ? it.unit_label : '')}</td>
        <td class="num">${it && it.qty != null ? num(it.qty) : ''}</td>
        <td class="num">${val != null ? money(val) : ''}</td>
        <td>${esc(it ? (it.purpose || note.purpose || (note.job_no ? 'Job ' + note.job_no : '')) : '')}</td>
      </tr>`);
  }

  const projectDesc = [
    note.project_name,
    [note.asset_code, note.asset_reg].filter(Boolean).join(' - '),
    note.job_no ? `Job Card: ${note.job_no}` : '',
    note.purpose
  ].filter(Boolean).join(' · ') || 'Central Workshop';

  const reqSig = sigSrc(note.requested_sig);
  const appSig = sigSrc(note.approved_sig);
  const recSig = sigSrc(note.received_sig);
  const minDisplayNo = note.min_no || ('MIN-' + String(note.id).padStart(4, '0'));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Material Issue Note ${esc(minDisplayNo)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('min', note.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Material Issue Note</div>
  </div>

  <div class="meta-strip">
    <div class="meta-field" style="flex: 2.2">
      <span class="meta-label">Project:</span>
      <span class="meta-dots"><b>${esc(projectDesc)}</b></span>
    </div>
    <div class="meta-field" style="flex: 1.1">
      <span class="meta-label">Date:</span>
      <span class="meta-dots">${esc(d(note.issue_date))}</span>
    </div>
    <div class="meta-field" style="flex: 1.1; justify-content: flex-end;">
      <span class="meta-label">MIN No.:</span>
      <span class="meta-dots stamp-dots"><span class="stamp-no">${esc(minDisplayNo)}</span></span>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:45px">Item<br>No.</th>
        <th>Description</th>
        <th style="width:55px">Unit</th>
        <th style="width:65px">Qty.</th>
        <th style="width:90px">Value<br>Rs.</th>
        <th style="width:170px">Purpose/<br>Location</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:82px"></th>
        <th>Requested By</th>
        <th>Approved By</th>
        <th>Received By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${renderValueCell(note.requested_by)}</td>
        <td>${renderValueCell(note.approved_by)}</td>
        <td>${renderValueCell(note.received_by)}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${renderValueCell(note.requested_designation || (note.requested_by ? 'Store Clerk / Mechanic' : ''))}</td>
        <td>${renderValueCell(note.approved_designation || (note.approved_by ? 'Store Supervisor' : ''))}</td>
        <td>${renderValueCell(note.received_designation || (note.received_by ? 'Fitter / Technician' : ''))}</td>
      </tr>
      <tr class="sig-row">
        <td class="lbl">Signature</td>
        <td>${renderSignatureCell(note.requested_by, reqSig)}</td>
        <td>${renderSignatureCell(note.approved_by, appSig)}</td>
        <td>${renderSignatureCell(note.received_by, recSig)}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${renderDateCell(note.requested_at || (note.requested_by ? note.issue_date : null))}</td>
        <td>${renderDateCell(note.approved_at || (note.approved_by ? note.issue_date : null))}</td>
        <td>${renderDateCell(note.received_at || (note.received_by ? note.issue_date : null))}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <span>Doc. No.: EC1.ST.FO.04</span>
    <span>Issue No.: 03</span>
    <span>Date of Issue: 2018.01.26</span>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 2. Goods Received Note (GRN) — Doc. No. EC1.ST.FO.2:5:21.12
// ---------------------------------------------------------------------------
function renderGrnDocumentHtml(grnIdentifier, { forPdf = false } = {}) {
  // Query by voucher or by GRN No or ID
  let voucher = get('SELECT v.* FROM grn_vouchers v WHERE v.id = ? OR v.grn_no = ?', grnIdentifier, grnIdentifier);
  let lines = [];

  if (voucher) {
    lines = all('SELECT g.*, m.mrn_no FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id WHERE g.voucher_id = ? OR g.grn_no = ? ORDER BY g.id', voucher.id, voucher.grn_no);
  } else {
    // Find matching grn lines by grn_no or id
    const target = get('SELECT g.*, m.mrn_no FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id WHERE g.id = ? OR g.grn_no = ?', grnIdentifier, grnIdentifier);
    if (!target) return null;
    const grnNo = target.grn_no || ('GRN-' + target.id);
    lines = all('SELECT g.*, m.mrn_no FROM grn g LEFT JOIN mrn m ON m.id = g.mrn_id WHERE g.grn_no = ? ORDER BY g.id', grnNo);
    if (!lines.length) lines = [target];

    voucher = {
      id: target.id,
      grn_no: grnNo,
      received_date: target.delivery_date || target.grn_date || target.created_at,
      supplier: target.supplier || '',
      project_site: target.project_site || 'Central Workshop — Badalgama',
      po_no: target.po_no || (target.purchase_source ? `Source: ${target.purchase_source}` : ''),
      invoice_no: target.invoice_no || '',
      delivery_note_no: target.delivery_note_no || '',
      prepared_by: target.prepared_by || 'Storekeeper',
      approved_by: target.approved_by || 'Store Manager',
      prepared_sig: target.prepared_sig,
      approved_sig: target.approved_sig,
    };
  }

  const MIN_ROWS = 12;
  const rows = [];
  let totalAmount = 0;

  for (let i = 0; i < Math.max(MIN_ROWS, lines.length); i++) {
    const l = lines[i];
    const qty = l ? Number(l.qty || 0) : null;
    const price = l && l.unit_price != null ? Number(l.unit_price) : null;
    const amount = qty != null && price != null ? qty * price : null;
    if (amount != null) totalAmount += amount;

    rows.push(`
      <tr>
        <td class="c">${l ? (i + 1) : ''}</td>
        <td>${esc(l ? l.description : '')}${l && l.mrn_no ? ` <span style="font-size:9.5px;color:#555">(MRN ${esc(l.mrn_no)})</span>` : ''}</td>
        <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
        <td class="num">${price != null ? money(price) : ''}</td>
        <td class="num">${qty != null ? num(qty) : ''}</td>
        <td class="num">${amount != null ? money(amount) : ''}</td>
        <td class="c">${esc(l ? (l.bin_card_page || '') : '')}</td>
      </tr>`);
  }

  const prepSig = sigSrc(voucher.prepared_sig);
  const appSig = sigSrc(voucher.approved_sig);
  const grnDisplayNo = voucher.grn_no || ('GRN-' + String(voucher.id).padStart(4, '0'));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>GRN ${esc(grnDisplayNo)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('grn', voucher.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Goods Received Note (GRN)</div>
  </div>
  <div class="addr-sub">No.: 64/9, Nawala Road, Nugegoda. Tel.: 0112812990-1</div>

  <table class="grn-meta-table">
    <tr>
      <td style="width: 50%;"><b>Date of Received:</b> <span>${esc(d(voucher.received_date))}</span></td>
      <td style="width: 28%; border-right: 1px solid #000;"><b>PO No.:</b> <span>${esc(voucher.po_no || '')}</span></td>
      <td style="width: 22%; text-align: right;"><b style="margin-right: 6px;">GRN No.:</b> <span class="stamp-no">${esc(grnDisplayNo)}</span></td>
    </tr>
    <tr>
      <td><b>Supplier:</b> <span><b>${esc(voucher.supplier || '')}</b></span></td>
      <td colspan="2"><b>Invoice No.:</b> <span>${esc(voucher.invoice_no || '')}</span></td>
    </tr>
    <tr>
      <td><b>Project &amp; Site:</b> <span>${esc(voucher.project_site || 'Central Workshop')}</span></td>
      <td colspan="2"><b>Delivery Note/ Transfer Note No.:</b> <span>${esc(voucher.delivery_note_no || '')}</span></td>
    </tr>
  </table>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:40px">Item<br>No.</th>
        <th>Description</th>
        <th style="width:45px">Unit</th>
        <th style="width:80px">Unit<br>Price</th>
        <th style="width:75px">Received<br>Qty.</th>
        <th style="width:90px">Amount Rs.</th>
        <th style="width:75px">Bin Card<br>Page No.</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:82px"></th>
        <th>Prepared By</th>
        <th>Approved By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${renderValueCell(voucher.prepared_by)}</td>
        <td>${renderValueCell(voucher.approved_by)}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${renderValueCell(voucher.prepared_designation || (voucher.prepared_by ? 'Receiving Storekeeper' : ''))}</td>
        <td>${renderValueCell(voucher.approved_designation || (voucher.approved_by ? 'Store Manager / In-Charge' : ''))}</td>
      </tr>
      <tr class="sig-row">
        <td class="lbl">Signature</td>
        <td>${renderSignatureCell(voucher.prepared_by, prepSig)}</td>
        <td>${renderSignatureCell(voucher.approved_by, appSig)}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${renderDateCell(voucher.prepared_at || (voucher.prepared_by ? voucher.received_date : null))}</td>
        <td>${renderDateCell(voucher.approved_at || (voucher.approved_by ? voucher.received_date : null))}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <span>Doc. No.: EC1.ST.FO.2:5:21.12</span>
    <span></span>
    <span></span>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 3. Materials / Goods Transfer Note (MTN) — Doc. No. EC1.ST.FO.05
// ---------------------------------------------------------------------------
function renderMtnDocumentHtml(mtnId, { forPdf = false } = {}) {
  const mtn = get('SELECT m.*, fa.code AS from_asset_code, ta.code AS to_asset_code ' +
    'FROM mtn m ' +
    'LEFT JOIN assets fa ON fa.id = m.from_asset_id LEFT JOIN assets ta ON ta.id = m.to_asset_id ' +
    'WHERE m.id = ? OR m.mtn_no = ?', mtnId, mtnId);
  if (!mtn) return null;

  let fromLoc = null;
  let toLoc = null;
  try {
    const storeLocs = require('./store_locations');
    if (mtn.from_store_location_id) fromLoc = storeLocs.getStoreLocationById(mtn.from_store_location_id);
    if (mtn.to_store_location_id) toLoc = storeLocs.getStoreLocationById(mtn.to_store_location_id);
  } catch (e) {
    // Graceful fallback
  }

  const lines = all('SELECT l.*, fa.code AS line_from_asset, ta.code AS line_to_asset FROM mtn_lines l ' +
    'LEFT JOIN assets fa ON fa.id = l.from_asset_id LEFT JOIN assets ta ON ta.id = l.to_asset_id WHERE l.mtn_id = ? ORDER BY l.line_no, l.id', mtn.id);

  const MIN_ROWS = 12;
  const rows = [];

  for (let i = 0; i < Math.max(MIN_ROWS, lines.length); i++) {
    const l = lines[i];
    const mrNo = l ? (l.mr_no || mtn.mr_no || '') : '';
    const val = l && l.value != null && Number(l.value) > 0 ? Number(l.value) : null;
    const remark = l ? (l.remarks || l.reason || mtn.reason || '') : '';

    rows.push(`
      <tr>
        <td class="c">${esc(mrNo)}</td>
        <td>${esc(l ? l.description : '')}</td>
        <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
        <td class="num">${l && l.qty ? num(l.qty) : ''}</td>
        <td class="num">${val != null ? money(val) : ''}</td>
        <td>${esc(remark)}</td>
      </tr>`);
  }

  const prepSig = sigSrc(mtn.prepared_sig);
  const appSig = sigSrc(mtn.approved_sig);
  const recSig = sigSrc(mtn.received_sig);
  const accSig = sigSrc(mtn.accepted_sig);

  const fromPlace = fromLoc
    ? `${fromLoc.name} [${fromLoc.code}]`
    : (mtn.from_place || mtn.from_location || (mtn.from_asset_code ? `Vehicle ${mtn.from_asset_code}` : 'Central Workshop'));
  const toPlace = toLoc
    ? `${toLoc.name} [${toLoc.code}]`
    : (mtn.to_place || mtn.to_location || (mtn.to_asset_code ? `Vehicle ${mtn.to_asset_code}` : 'Site Workshop'));
  const mtnDisplayNo = mtn.mtn_no || ('MTN-' + String(mtn.id).padStart(4, '0'));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MTN ${esc(mtnDisplayNo)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('mtn', mtn.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Materials/ Goods Transfer Note</div>
  </div>
  <div class="addr-sub">No.: 64/09, Nawala Road, Nugegoda. Tel: 0112812990-1, Fax: 0112812441</div>

  <div class="meta-strip">
    <div class="meta-field" style="flex: 2.5">
      <span class="meta-label">Transferred From :</span>
      <span class="meta-dots"><b>${esc(fromPlace)}</b></span>
    </div>
    <div class="meta-field" style="flex: 1.2; justify-content: flex-end;">
      <span class="meta-label">MTN No. :</span>
      <span class="meta-dots stamp-dots"><span class="stamp-no">${esc(mtnDisplayNo)}</span></span>
    </div>
  </div>

  <div class="meta-strip">
    <div class="meta-field" style="flex: 2.5">
      <span class="meta-label">Transferred To :</span>
      <span class="meta-dots"><b>${esc(toPlace)}</b></span>
    </div>
    <div class="meta-field" style="flex: 1.2; justify-content: flex-end;">
      <span class="meta-label">Date :</span>
      <span class="meta-dots">${esc(d(mtn.txn_date))}</span>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:75px">MR No.</th>
        <th>Description</th>
        <th style="width:50px">Unit</th>
        <th style="width:70px">Qty.</th>
        <th style="width:90px">Value<br>(If any)</th>
        <th style="width:160px">Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:82px"></th>
        <th>Prepared By</th>
        <th>Approved By</th>
        <th>Received By</th>
        <th>Accepted By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${renderValueCell(mtn.prepared_by || mtn.transferred_by)}</td>
        <td>${renderValueCell(mtn.approved_by)}</td>
        <td>${renderValueCell(mtn.received_by)}</td>
        <td>${renderValueCell(mtn.accepted_by)}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${renderValueCell(mtn.prepared_designation || (mtn.prepared_by ? 'Store Clerk' : ''))}</td>
        <td>${renderValueCell(mtn.approved_designation || (mtn.approved_by ? 'Store In-Charge' : ''))}</td>
        <td>${renderValueCell(mtn.received_designation || (mtn.received_by ? 'Transport / Driver' : ''))}</td>
        <td>${renderValueCell(mtn.accepted_designation || (mtn.accepted_by ? 'Receiving Storekeeper' : ''))}</td>
      </tr>
      <tr class="sig-row">
        <td class="lbl">Signature</td>
        <td>${renderSignatureCell(mtn.prepared_by || mtn.transferred_by, prepSig)}</td>
        <td>${renderSignatureCell(mtn.approved_by, appSig)}</td>
        <td>${renderSignatureCell(mtn.received_by, recSig)}</td>
        <td>${renderSignatureCell(mtn.accepted_by, accSig)}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${renderDateCell(mtn.prepared_at || (mtn.prepared_by ? mtn.txn_date : null))}</td>
        <td>${renderDateCell(mtn.approved_at || (mtn.approved_by ? mtn.txn_date : null))}</td>
        <td>${renderDateCell(mtn.received_at || (mtn.received_by ? mtn.txn_date : null))}</td>
        <td>${renderDateCell(mtn.accepted_at || (mtn.accepted_by ? mtn.txn_date : null))}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <span>Doc. No.: EC1.ST.FO.05</span>
    <span>Issue No.: 04</span>
    <span>Date of Issue: 2018.07.25</span>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 4. Material Requisition (MRN) — Doc. No. EC1.ST.FO.01
// ---------------------------------------------------------------------------
function renderMrnDocumentHtml(mrnId, { forPdf = false } = {}) {
  const mrn = get('SELECT m.*, a.code AS asset_code, a.registration AS asset_reg, p.name AS project_name, j.job_no ' +
    'FROM mrn m LEFT JOIN assets a ON a.id = m.asset_id LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN job_cards j ON j.id = m.job_id WHERE m.id = ? OR m.mrn_no = ?', mrnId, mrnId);
  if (!mrn) return null;

  const lines = all('SELECT * FROM mrn_lines WHERE mrn_id = ? ORDER BY id', mrn.id);
  const MIN_ROWS = 12;
  const rows = [];

  for (let i = 0; i < Math.max(MIN_ROWS, lines.length); i++) {
    const l = lines[i];
    const addedMark = (l && l.added_after_approval)
      ? ` <span style="font-size:9px;border:1px solid #333;padding:0 3px">ADDED AFTER APPROVAL${
        l.added_by ? ' — ' + esc(l.added_by) : ''}${l.added_at ? ', ' + esc(String(l.added_at).slice(0, 10)) : ''}</span>` : '';

    rows.push(`
      <tr>
        <td class="c">${l ? (i + 1) : ''}</td>
        <td>${esc(l ? l.description : '')}${addedMark}</td>
        <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
        <td class="num">${l && l.qty_received != null ? num(l.qty_received) : ''}</td>
        <td class="num">${l && l.available_qty != null ? num(l.available_qty) : ''}</td>
        <td class="num">${l && l.qty != null ? num(l.qty) : ''}</td>
        <td class="c">${esc(l && l.required_date ? d(l.required_date) : (mrn.required_date ? d(mrn.required_date) : ''))}</td>
      </tr>`);
  }

  const projectDesc = [
    mrn.project_name,
    [mrn.asset_code, mrn.asset_reg].filter(Boolean).join(' - '),
    mrn.purpose
  ].filter(Boolean).join(' · ') || 'Central Workshop';

  const reqSig = sigSrc(mrn.requested_sig);
  const certSig = sigSrc(mrn.certified_sig);
  const appSig = sigSrc(mrn.approved_sig);
  const mrnDisplayNo = mrn.mrn_no || ('MRN-' + String(mrn.id).padStart(4, '0'));

  // If certified_by was provided, display 3 signature columns; otherwise display 2 columns matching paper book
  const hasCertifier = Boolean(mrn.certified_by || mrn.certified_sig || mrn.certified_at);

  const sigHeaders = hasCertifier
    ? `<th>Requested By</th><th>Certified By</th><th>Approved By</th>`
    : `<th>Requested By</th><th>Approved By</th>`;

  const sigNames = hasCertifier
    ? `<td>${renderValueCell(mrn.requested_by)}</td><td>${renderValueCell(mrn.certified_by)}</td><td>${renderValueCell(mrn.approved_by)}</td>`
    : `<td>${renderValueCell(mrn.requested_by)}</td><td>${renderValueCell(mrn.approved_by)}</td>`;

  const sigDesigs = hasCertifier
    ? `<td>${renderValueCell(mrn.requested_designation || (mrn.requested_by ? 'Storekeeper' : ''))}</td><td>${renderValueCell(mrn.certified_designation || (mrn.certified_by ? 'Workshop Engineer' : ''))}</td><td>${renderValueCell(mrn.approved_designation || (mrn.approved_by ? 'Operational Manager' : ''))}</td>`
    : `<td>${renderValueCell(mrn.requested_designation || (mrn.requested_by ? 'Storekeeper' : ''))}</td><td>${renderValueCell(mrn.approved_designation || (mrn.approved_by ? 'Operational Manager' : ''))}</td>`;

  const sigCells = hasCertifier
    ? `<td>${renderSignatureCell(mrn.requested_by, reqSig)}</td><td>${renderSignatureCell(mrn.certified_by, certSig)}</td><td>${renderSignatureCell(mrn.approved_by, appSig)}</td>`
    : `<td>${renderSignatureCell(mrn.requested_by, reqSig)}</td><td>${renderSignatureCell(mrn.approved_by, appSig)}</td>`;

  const sigDates = hasCertifier
    ? `<td>${renderDateCell(mrn.req_date)}</td><td>${renderDateCell(mrn.certified_at)}</td><td>${renderDateCell(mrn.approved_at || (mrn.approved_by ? mrn.req_date : null))}</td>`
    : `<td>${renderDateCell(mrn.req_date)}</td><td>${renderDateCell(mrn.approved_at || (mrn.approved_by ? mrn.req_date : null))}</td>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Material Requisition ${esc(mrnDisplayNo)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('mrn', mrn.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Material Requisition</div>
  </div>

  <div class="meta-strip">
    <div class="meta-field" style="flex: 2.2">
      <span class="meta-label">Project:</span>
      <span class="meta-dots"><b>${esc(projectDesc)}</b></span>
    </div>
    <div class="meta-field" style="flex: 1.1">
      <span class="meta-label">Date:</span>
      <span class="meta-dots">${esc(d(mrn.req_date))}</span>
    </div>
    <div class="meta-field" style="flex: 1.1; justify-content: flex-end;">
      <span class="meta-label">MR No.:</span>
      <span class="meta-dots stamp-dots"><span class="stamp-no">${esc(mrnDisplayNo)}</span></span>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:40px">Item<br>No.</th>
        <th>Description</th>
        <th style="width:45px">Unit</th>
        <th style="width:85px">Received Qty.<br>(Cumulative)</th>
        <th style="width:70px">Available<br>Qty.</th>
        <th style="width:70px">Required<br>Qty.</th>
        <th style="width:80px">Required<br>Date</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:82px"></th>
        ${sigHeaders}
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        ${sigNames}
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        ${sigDesigs}
      </tr>
      <tr class="sig-row">
        <td class="lbl">Signature</td>
        ${sigCells}
      </tr>
      <tr>
        <td class="lbl">Date</td>
        ${sigDates}
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <span>Doc. No.: EC1.ST.FO.01</span>
    <span>Issue No.: 04</span>
    <span>Date of Issue: 2018.11.14</span>
  </div>
</div>
</body>
</html>`;
}

module.exports = {
  renderMinDocumentHtml,
  renderGrnDocumentHtml,
  renderMtnDocumentHtml,
  renderMrnDocumentHtml,
};
