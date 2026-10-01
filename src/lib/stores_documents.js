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
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; color: #000; margin: 0; padding: 0; font-size: 11px; background: #fff; }
    .sheet { border: 1.5px solid #000; width: 100%; margin: 0 auto; background: #fff; }
    .hd { display: flex; align-items: stretch; border-bottom: 1.5px solid #000; min-height: 38px; }
    .hd .co { flex: 1.3; padding: 8px 12px; font-weight: bold; font-size: 16px; border-right: 1.5px solid #000; display:flex; align-items:center; }
    .hd .ti { flex: 1.2; padding: 8px 12px; font-weight: bold; font-size: 16px; display:flex; align-items:center; justify-content:center; text-align: center; }
    .addr-sub { border-bottom: 1.5px solid #000; padding: 3px 12px; font-size: 10px; text-align: center; font-weight: 500; }
    .meta-grid { display: grid; border-bottom: 1.5px solid #000; font-size: 11.5px; }
    .meta-grid.two-col { grid-template-columns: 1.4fr 1fr; }
    .meta-grid.three-col { grid-template-columns: 1.2fr 1fr 1fr; }
    .meta-cell { padding: 5px 10px; border-bottom: 1px solid #ccc; display: flex; align-items: center; }
    .meta-cell:last-child { border-bottom: none; }
    .meta-cell .k { font-weight: bold; min-width: 90px; }
    .meta-cell .v { flex: 1; border-bottom: 1px dotted #888; min-height: 16px; padding-left: 4px; }
    .meta-cell .stamp-no { font-family: "Courier New", Courier, monospace; font-size: 16px; font-weight: 900; color: #b30000; }
    table.data-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    table.data-table th, table.data-table td { border: 1px solid #000; padding: 4px 6px; vertical-align: middle; }
    table.data-table th { background: #f2f2f2; font-size: 11px; text-align: center; font-weight: bold; }
    table.data-table td.c { text-align: center; }
    table.data-table td.num { text-align: right; }
    table.data-table tbody td { height: 26px; }
    .sig-table { width: 100%; border-collapse: collapse; border-top: 1.5px solid #000; table-layout: fixed; }
    .sig-table th, .sig-table td { border: 1px solid #000; padding: 4px 8px; font-size: 11px; }
    .sig-table th { background: #fafafa; font-weight: bold; text-align: center; padding: 6px; }
    .sig-table td.lbl { font-weight: bold; width: 85px; background: #fafafa; }
    .sig-img { max-height: 34px; max-width: 140px; display: block; margin: 0 auto; }
    .foot { display: flex; justify-content: space-between; padding: 4px 10px; border-top: 1.5px solid #000; font-size: 9.5px; color: #333; font-weight: bold; }
    .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 10px; }
    .toolbar button, .toolbar a { padding: 6px 14px; font-size: 13px; font-weight: bold; cursor: pointer; text-decoration: none; border: 1px solid #000; background: #f0f0f0; color: #000; border-radius: 4px; }
    .toolbar button.primary, .toolbar a.primary { background: #0056b3; color: #fff; border-color: #004085; }
    @media print {
      .noprint { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;
}

function renderControls(docType, id, forPdf) {
  if (forPdf) return '';
  return `
    <div class="toolbar noprint">
      <button onclick="window.print()">🖨 Print / Save as PDF</button>
      <a class="primary" href="/api/stores/${docType}/${id}/download.pdf" download>⬇ Download PDF</a>
    </div>`;
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
        <td class="c">${i + 1}</td>
        <td>${esc(it ? it.description : '')}</td>
        <td class="c">${esc(it ? it.unit_label : '')}</td>
        <td class="num">${it ? num(it.qty) : ''}</td>
        <td class="num">${val != null ? money(val) : ''}</td>
        <td>${esc(it ? (it.purpose || note.purpose || (note.job_no ? 'Job ' + note.job_no : '')) : '')}</td>
      </tr>`);
  }

  const projectDesc = note.project_name || note.asset_code || (note.job_no ? `Job Card: ${note.job_no}` : (note.purpose || 'Central Workshop'));
  const reqSig = sigSrc(note.requested_sig);
  const appSig = sigSrc(note.approved_sig);
  const recSig = sigSrc(note.received_sig);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Material Issue Note ${esc(note.min_no)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('min', note.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Material Issue Note</div>
  </div>
  <div class="meta-grid two-col">
    <div class="meta-cell"><span class="k">Project:</span><span class="v"><b>${esc(projectDesc)}</b></span></div>
    <div class="meta-cell" style="justify-content: flex-end"><span class="k" style="min-width:auto;margin-right:8px">MIN No.:</span><span class="stamp-no">${esc(note.min_no)}</span></div>
    <div class="meta-cell"><span class="k">Date:</span><span class="v">${esc(d(note.issue_date))}</span></div>
    <div class="meta-cell"><span class="k">Vehicle / Job:</span><span class="v">${esc([note.asset_code, note.asset_reg, note.job_no].filter(Boolean).join(' · '))}</span></div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:40px">Item No.</th>
        <th>Description</th>
        <th style="width:55px">Unit</th>
        <th style="width:65px">Qty.</th>
        <th style="width:90px">Value Rs.</th>
        <th style="width:170px">Purpose / Location</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:85px"></th>
        <th>Requested By</th>
        <th>Approved By</th>
        <th>Received By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${esc(note.requested_by || '')}</td>
        <td>${esc(note.approved_by || '')}</td>
        <td>${esc(note.received_by || '')}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${esc(note.requested_designation || 'Store Clerk / Mechanic')}</td>
        <td>${esc(note.approved_designation || 'Store Supervisor')}</td>
        <td>${esc(note.received_designation || 'Fitter / Technician')}</td>
      </tr>
      <tr style="height:38px">
        <td class="lbl">Signature</td>
        <td>${reqSig ? `<img class="sig-img" src="${reqSig}">` : (note.requested_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${appSig ? `<img class="sig-img" src="${appSig}">` : (note.approved_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${recSig ? `<img class="sig-img" src="${recSig}">` : (note.received_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${esc(d(note.requested_at || note.issue_date))}</td>
        <td>${esc(d(note.approved_at || note.issue_date))}</td>
        <td>${esc(d(note.received_at || note.issue_date))}</td>
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
        <td class="c">${i + 1}</td>
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

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>GRN ${esc(voucher.grn_no)}</title>
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

  <div class="meta-grid two-col">
    <div>
      <div class="meta-cell"><span class="k">Date of Received:</span><span class="v">${esc(d(voucher.received_date))}</span></div>
      <div class="meta-cell"><span class="k">Supplier:</span><span class="v"><b>${esc(voucher.supplier || '')}</b></span></div>
      <div class="meta-cell"><span class="k">Project & Site:</span><span class="v">${esc(voucher.project_site || 'Central Workshop')}</span></div>
    </div>
    <div style="border-left: 1.5px solid #000">
      <div class="meta-cell" style="justify-content: flex-end"><span class="k" style="min-width:auto;margin-right:8px">GRN No.:</span><span class="stamp-no">${esc(voucher.grn_no)}</span></div>
      <div class="meta-cell"><span class="k">PO No.:</span><span class="v">${esc(voucher.po_no || '')}</span></div>
      <div class="meta-cell"><span class="k">Invoice No.:</span><span class="v">${esc(voucher.invoice_no || '')}</span></div>
      <div class="meta-cell"><span class="k">Delivery Note / Transfer Note No.:</span><span class="v">${esc(voucher.delivery_note_no || '')}</span></div>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:40px">Item No.</th>
        <th>Description</th>
        <th style="width:50px">Unit</th>
        <th style="width:85px">Unit Price</th>
        <th style="width:75px">Received Qty.</th>
        <th style="width:95px">Amount Rs.</th>
        <th style="width:75px">Bin Card Page No.</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:85px"></th>
        <th>Prepared By</th>
        <th>Approved By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${esc(voucher.prepared_by || '')}</td>
        <td>${esc(voucher.approved_by || '')}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${esc(voucher.prepared_designation || 'Receiving Storekeeper')}</td>
        <td>${esc(voucher.approved_designation || 'Store Manager / In-Charge')}</td>
      </tr>
      <tr style="height:38px">
        <td class="lbl">Signature</td>
        <td>${prepSig ? `<img class="sig-img" src="${prepSig}">` : (voucher.prepared_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${appSig ? `<img class="sig-img" src="${appSig}">` : (voucher.approved_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${esc(d(voucher.prepared_at || voucher.received_date))}</td>
        <td>${esc(d(voucher.approved_at || voucher.received_date))}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <span>Doc. No.: EC1.ST.FO.2:5:21.12</span>
    <span>Edward & Christie Central Stores System</span>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 3. Materials / Goods Transfer Note (MTN) — Doc. No. EC1.ST.FO.05
// ---------------------------------------------------------------------------
function renderMtnDocumentHtml(mtnId, { forPdf = false } = {}) {
  const mtn = get('SELECT m.*, fa.code AS from_asset_code, ta.code AS to_asset_code FROM mtn m ' +
    'LEFT JOIN assets fa ON fa.id = m.from_asset_id LEFT JOIN assets ta ON ta.id = m.to_asset_id WHERE m.id = ? OR m.mtn_no = ?', mtnId, mtnId);
  if (!mtn) return null;

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

  const fromPlace = mtn.from_place || mtn.from_location || (mtn.from_asset_code ? `Vehicle ${mtn.from_asset_code}` : 'Central Workshop');
  const toPlace = mtn.to_place || mtn.to_location || (mtn.to_asset_code ? `Vehicle ${mtn.to_asset_code}` : 'Site Workshop');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MTN ${esc(mtn.mtn_no)}</title>
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

  <div class="meta-grid two-col">
    <div>
      <div class="meta-cell"><span class="k">Transferred From:</span><span class="v"><b>${esc(fromPlace)}</b></span></div>
      <div class="meta-cell"><span class="k">Transferred To:</span><span class="v"><b>${esc(toPlace)}</b></span></div>
    </div>
    <div style="border-left: 1.5px solid #000">
      <div class="meta-cell" style="justify-content: flex-end"><span class="k" style="min-width:auto;margin-right:8px">MTN No.:</span><span class="stamp-no">${esc(mtn.mtn_no)}</span></div>
      <div class="meta-cell"><span class="k">Date:</span><span class="v">${esc(d(mtn.txn_date))}</span></div>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:75px">MR No.</th>
        <th>Description</th>
        <th style="width:50px">Unit</th>
        <th style="width:70px">Qty.</th>
        <th style="width:90px">Value (If any)</th>
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
        <th style="width:75px"></th>
        <th>Prepared By</th>
        <th>Approved By</th>
        <th>Received By</th>
        <th>Accepted By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${esc(mtn.prepared_by || mtn.transferred_by || '')}</td>
        <td>${esc(mtn.approved_by || '')}</td>
        <td>${esc(mtn.received_by || '')}</td>
        <td>${esc(mtn.accepted_by || '')}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${esc(mtn.prepared_designation || 'Store Clerk')}</td>
        <td>${esc(mtn.approved_designation || 'Store In-Charge')}</td>
        <td>${esc(mtn.received_designation || 'Transport / Driver')}</td>
        <td>${esc(mtn.accepted_designation || 'Receiving Storekeeper')}</td>
      </tr>
      <tr style="height:36px">
        <td class="lbl">Signature</td>
        <td>${prepSig ? `<img class="sig-img" src="${prepSig}">` : (mtn.prepared_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${appSig ? `<img class="sig-img" src="${appSig}">` : (mtn.approved_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${recSig ? `<img class="sig-img" src="${recSig}">` : (mtn.received_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${accSig ? `<img class="sig-img" src="${accSig}">` : (mtn.accepted_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${esc(d(mtn.prepared_at || mtn.txn_date))}</td>
        <td>${esc(d(mtn.approved_at || mtn.txn_date))}</td>
        <td>${esc(d(mtn.received_at || mtn.txn_date))}</td>
        <td>${esc(d(mtn.accepted_at || mtn.txn_date))}</td>
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
      ? ` <span style="font-size:9px;border:1px solid #333;padding:0 2px">ADDED AFTER APPROVAL</span>` : '';

    rows.push(`
      <tr>
        <td class="c">${i + 1}</td>
        <td>${esc(l ? l.description : '')}${addedMark}</td>
        <td class="c">${esc(l ? (l.unit || 'nos') : '')}</td>
        <td class="num">${l && l.qty_received ? num(l.qty_received) : ''}</td>
        <td class="num"></td>
        <td class="num">${l && l.qty ? num(l.qty) : ''}</td>
        <td class="c">${esc(l && l.required_date ? d(l.required_date) : (mrn.required_date ? d(mrn.required_date) : ''))}</td>
      </tr>`);
  }

  const reqSig = sigSrc(mrn.requested_sig);
  const certSig = sigSrc(mrn.certified_sig);
  const appSig = sigSrc(mrn.approved_sig);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Material Requisition ${esc(mrn.mrn_no)}</title>
  <style>${getDocumentCss()}</style>
</head>
<body>
${renderControls('mrn', mrn.id, forPdf)}
<div class="sheet">
  <div class="hd">
    <div class="co">Edward and Christie (Pvt) Ltd</div>
    <div class="ti">Material Requisition</div>
  </div>

  <div class="meta-grid two-col">
    <div>
      <div class="meta-cell"><span class="k">Project:</span><span class="v"><b>${esc(mrn.project_name || mrn.purpose || (mrn.asset_code ? `Vehicle ${mrn.asset_code}` : 'Central Workshop'))}</b></span></div>
      <div class="meta-cell"><span class="k">Vehicle / Asset:</span><span class="v">${esc([mrn.asset_code, mrn.asset_reg].filter(Boolean).join(' · '))}</span></div>
    </div>
    <div style="border-left: 1.5px solid #000">
      <div class="meta-cell" style="justify-content: flex-end"><span class="k" style="min-width:auto;margin-right:8px">MR No.:</span><span class="stamp-no">${esc(mrn.mrn_no)}</span></div>
      <div class="meta-cell"><span class="k">Date:</span><span class="v">${esc(d(mrn.req_date))}</span></div>
    </div>
  </div>

  <table class="data-table">
    <thead>
      <tr>
        <th style="width:40px">Item No.</th>
        <th>Description</th>
        <th style="width:45px">Unit</th>
        <th style="width:75px">Received Qty. (Cumulative)</th>
        <th style="width:70px">Available Qty.</th>
        <th style="width:65px">Required Qty.</th>
        <th style="width:75px">Required Date</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>

  <table class="sig-table">
    <thead>
      <tr>
        <th style="width:85px"></th>
        <th>Requested By</th>
        <th>Certified By</th>
        <th>Approved By</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl">Name</td>
        <td>${esc(mrn.requested_by || '')}</td>
        <td>${esc(mrn.certified_by || '')}</td>
        <td>${esc(mrn.approved_by || '')}</td>
      </tr>
      <tr>
        <td class="lbl">Designation</td>
        <td>${esc(mrn.requested_designation || 'Storekeeper')}</td>
        <td>${esc(mrn.certified_designation || 'Workshop Engineer')}</td>
        <td>${esc(mrn.approved_designation || 'Operational Manager')}</td>
      </tr>
      <tr style="height:36px">
        <td class="lbl">Signature</td>
        <td>${reqSig ? `<img class="sig-img" src="${reqSig}">` : (mrn.requested_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${certSig ? `<img class="sig-img" src="${certSig}">` : (mrn.certified_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
        <td>${appSig ? `<img class="sig-img" src="${appSig}">` : (mrn.approved_by ? '<span style="color:#0a7a0a;font-size:9.5px">✓ e-signed</span>' : '')}</td>
      </tr>
      <tr>
        <td class="lbl">Date</td>
        <td>${esc(d(mrn.req_date))}</td>
        <td>${esc(d(mrn.certified_at))}</td>
        <td>${esc(d(mrn.approved_at))}</td>
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
