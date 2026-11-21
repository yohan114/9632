'use strict';

/**
 * Printable A4 HTML & PDF/Excel Document Renderer for SITE SUMMARY BILL
 * Matches E&C Heavy Equipment & Fleet Division (Doc No: EC40.WS.IV.8.12.25.3).
 */

const COMPANY = {
  name: 'Edward and Christie Group',
  division: 'Heavy Equipment & Fleet Division',
  docNumber: 'EC40.WS.IV.8.12.25.3',
  vatReg: 'VAT Reg No: 174042756-7000',
  address: '64/09 Nawala Road, Nugegoda, Sri Lanka',
  contact: 'edchrist@sltnet.lk · 0112812990, 0112812991, 0112812441',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtRs(cents) {
  if (cents == null) return '—';
  const num = Number(cents) / 100;
  return 'Rs. ' + num.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtN1(val) {
  if (val == null || isNaN(Number(val))) return '—';
  return Number(val).toLocaleString('en-LK', { maximumFractionDigits: 1 });
}

function fmtPct(r) {
  return (Number(r || 0) * 100).toLocaleString('en-LK', { maximumFractionDigits: 1 });
}

function ecLogoSvg(size = 30) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path d="M79.49 70.65 A36 36 0 1 1 79.49 29.35" stroke="#111111" stroke-width="12" fill="none" stroke-linecap="round"/>
      <line x1="49" y1="50" x2="82" y2="50" stroke="#111111" stroke-width="12" stroke-linecap="round"/>
      <path d="M66.09 63.50 A21 21 0 1 1 66.09 36.50" stroke="#f5a01e" stroke-width="11" fill="none" stroke-linecap="round"/>
    </svg>
  `;
}

function generatedDateStr() {
  return new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Colombo',
  });
}

function renderOneSiteSection(summary, generatedAt, isLast) {
  const rowsHtml = (summary.lines || []).map((l) => {
    const consStr = l.consRefUnits != null ? `${fmtN1(l.consRefUnits)} ${esc(l.unit)}` : '—';
    const consSub = l.consTypRate != null ? `<div class="sub">@ ${esc(l.consTypRate)} L/${esc(l.unit)}</div>` : '';
    const meterStr = l.actualUnits != null ? `${fmtN1(l.actualUnits)} ${esc(l.unit)}` : '—';
    const billStr = `${fmtN1(l.billableUnits)} ${esc(l.unit)}`;
    const billSub = l.breakdownDeductCents > 0 && l.breakdownDeductUnits > 0
      ? `<div class="sub">${esc(l.billedOn)} (after -${fmtN1(l.breakdownDeductUnits)} ${esc(l.unit)} BD)</div>`
      : `<div class="sub">${l.billedOn === 'days on site' ? 'days on site' : `on ${esc(l.billedOn)}`}</div>`;
    const bdBadge = l.breakdownDays > 0
      ? `<div class="bd-tag">-${fmtN1(l.breakdownDays)}d BD excl.${l.breakdownDeductCents > 0 ? ` (-${fmtRs(l.breakdownDeductCents)})` : ''}</div>`
      : '';
    const daysDisplay = (l.workingDaysHere != null && l.workingDaysInMonth && l.billingMode !== 'perday')
      ? `${fmtN1(l.workingDaysHere)} / ${l.workingDaysInMonth}`
      : `${l.daysHere} / ${l.daysInMonth}`;

    return `
      <tr>
        <td class="c-mach">
          <div class="mach-code">${esc(l.code)}</div>
          <div class="sub">${esc(l.regNo || '—')}</div>
        </td>
        <td class="num c-days">${daysDisplay}${bdBadge}</td>
        <td class="num c-cons"><div>${consStr}</div>${consSub}</td>
        <td class="num c-meter">${meterStr}</td>
        <td class="num c-bill"><div>${billStr}</div>${billSub}</td>
        <td class="num c-rate">${l.rateCents != null ? fmtRs(l.rateCents) : '<span class="muted">no rate</span>'}</td>
        <td class="num c-rent">${fmtRs(l.rentalCents)}</td>
        <td class="num c-fuel">${fmtN1(l.fuelLitres)} L</td>
        <td class="num c-tot"><strong>${fmtRs(l.lineTotalCents)}</strong></td>
      </tr>
    `;
  }).join('');

  const callouts = [];
  if (summary.breakdownAdjustments && summary.breakdownAdjustments.length) {
    const bdDesc = summary.breakdownAdjustments
      .map((b) => {
        const dedPart = b.breakdownDeductCents > 0 ? `, -${fmtRs(b.breakdownDeductCents)} rental deducted` : '';
        const wdPart = b.workingDaysHere != null ? `${fmtN1(b.workingDaysHere)}/${summary.workingDaysInMonth || 25} working d` : `${b.activeDays}d working`;
        return `${b.code} (${b.spans}: -${fmtN1(b.breakdownDays)}d BD${dedPart}; ${wdPart} billed)`;
      })
      .join('; ');
    callouts.push(`<p><strong>Breakdown period deductions (${summary.workingDaysInMonth || 25} working days/month base; breakdown dates deducted from rental cost):</strong> ${esc(bdDesc)}.</p>`);
  }
  if (summary.noFuelHere && summary.noFuelHere.length) {
    const plural = summary.noFuelHere.length > 1;
    callouts.push(`<p>${esc(summary.noFuelHere.join(', '))} ${plural ? 'were' : 'was'} posted here this month but drew no fuel from this site&rsquo;s pumps, so nothing is charged for ${plural ? 'them' : 'it'} &mdash; the same rule the monthly invoice uses.</p>`);
  }
  if (summary.billedDirect && summary.billedDirect.length) {
    const plural = summary.billedDirect.length > 1;
    callouts.push(`<p>${esc(summary.billedDirect.join(', '))} ${plural ? 'were' : 'was'} on site this month but ${plural ? 'are' : 'is'} settled direct with the owner &mdash; neither rental nor fuel is charged here.</p>`);
  }
  if (summary.unrated && summary.unrated.length) {
    const plural = summary.unrated.length > 1;
    callouts.push(`<p>${esc(summary.unrated.join(', '))} ${plural ? 'have' : 'has'} no rate card, so no rental is charged for ${plural ? 'them' : 'it'} above.</p>`);
  }

  const calloutHtml = callouts.length
    ? `<div class="warn-box">${callouts.join('')}</div>`
    : '';

  const transfers = summary.transfersExcluded || [];
  const transfersHtml = transfers.length
    ? `
      <div class="xfer-box">
        <div class="xfer-head">
          <div class="xfer-title">TRANSFERS &amp; CORRECTIONS EXCLUDED (BILLED OUTSIDE)</div>
          <div class="xfer-badge">EXCLUDED FROM SITE BILL</div>
        </div>
        <p class="xfer-note">The following ${transfers.length} transaction${transfers.length === 1 ? '' : 's'} were drawn from this site&rsquo;s pumps but are NOT billed to ${esc(summary.siteCode)} because they represent inter-project transfers, outside work, or meter/pump adjustments billed separately:</p>
        <table class="xfer-table">
          <tbody>
            ${transfers.map((t) => `
              <tr>
                <td class="xfer-ref">${esc(t.ref)}</td>
                <td class="xfer-desc">${esc(t.description)}</td>
                <td class="num xfer-l">${fmtN1(t.litres)} L</td>
                <td class="num xfer-amt">${fmtRs(t.amountCents)}</td>
              </tr>
            `).join('')}
            <tr class="xfer-total-row">
              <td colspan="2"><strong>Total Transfers &amp; Corrections Excluded from Bill</strong></td>
              <td class="num"><strong>${fmtN1(summary.transfersExcludedLitres)} L</strong></td>
              <td class="num"><strong>${fmtRs(summary.transfersExcludedCents)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `
    : '';

  const fuelRateNote = summary.fuelRateCents != null
    ? ` @ ${fmtRs(summary.fuelRateCents)}/L${summary.fuelRateBlended ? ' avg' : ''}`
    : '';
  const statusBannerText = summary.status === 'FINAL'
    ? 'FINAL SITE SUMMARY — matched to issued monthly rental invoices.'
    : 'DRAFT — for site agreement. Not a tax invoice until issued.';

  return `
    <div class="site-sheet${isLast ? '' : ' page-break'}">
      <div class="header-band">
        <div class="logo-box">
          <div class="logo-mark">${ecLogoSvg(32)}</div>
          <div>
            <div class="co-name">${esc(COMPANY.name)}</div>
            <div class="co-div">${esc(COMPANY.division)}</div>
            <div class="co-doc">Doc No: ${esc(COMPANY.docNumber)}</div>
          </div>
        </div>
        <div class="title-box">
          <div class="doc-title">SITE SUMMARY BILL</div>
          <div class="doc-sub">${esc(summary.siteName)}</div>
          <div class="doc-badge">${esc(summary.status || 'DRAFT')} &middot; ${esc(String(summary.monthLabel || summary.periodKey).toUpperCase())}</div>
        </div>
      </div>
      <div class="accent-strip"></div>

      <div class="info-bar">
        <div><div class="info-lbl">SITE</div><div class="info-val">${esc(summary.siteCode)}</div></div>
        <div><div class="info-lbl">PERIOD</div><div class="info-val">${esc(summary.monthLabel || summary.periodKey)}</div></div>
        <div><div class="info-lbl">MACHINES</div><div class="info-val">${summary.lines.length}</div></div>
        <div><div class="info-lbl">FUEL ISSUED HERE</div><div class="info-val">${fmtN1(summary.fuelLitres)} L</div></div>
        <div><div class="info-lbl">GENERATED</div><div class="info-val">${esc(generatedAt)}</div></div>
      </div>

      <div class="body-pad">
        <div class="sec-label">MACHINES POSTED TO THIS SITE</div>
        <table class="bill-table">
          <thead>
            <tr>
              <th class="c-mach">MACHINE</th>
              <th class="num c-days">DAYS</th>
              <th class="num c-cons">ACTUAL<br>(CONS TYP)</th>
              <th class="num c-meter">ACTUAL<br>(METER)</th>
              <th class="num c-bill">BILLABLE</th>
              <th class="num c-rate">RATE</th>
              <th class="num c-rent">RENTAL</th>
              <th class="num c-fuel">FUEL</th>
              <th class="num c-tot">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="9" class="empty-row">No billable machines with site fuel activity found for this period.</td></tr>'}
          </tbody>
        </table>

        <div class="totals-wrap">
          <div class="totals-box">
            ${summary.breakdownDeductCents > 0 ? `
              <div class="tot-row"><span class="tot-lbl">Gross machine rental (${summary.workingDaysInMonth || 25} working d base)</span><span class="tot-val">${fmtRs(summary.grossRentalCents)}</span></div>
              <div class="tot-row"><span class="tot-lbl" style="color:#b91c1c">Less: Breakdown rental deduction</span><span class="tot-val" style="color:#b91c1c">-${fmtRs(summary.breakdownDeductCents)}</span></div>
            ` : ''}
            <div class="tot-row"><span class="tot-lbl">${summary.breakdownDeductCents > 0 ? 'Net machine rental' : 'Machine rental'}</span><span class="tot-val">${fmtRs(summary.rentalCents)}</span></div>
            <div class="tot-row"><span class="tot-lbl">Fuel issued at this site (${fmtN1(summary.fuelLitres)} L${esc(fuelRateNote)})</span><span class="tot-val">${fmtRs(summary.fuelCostCents)}</span></div>
            <div class="tot-row"><span class="tot-lbl">Subtotal</span><span class="tot-val">${fmtRs(summary.subtotalCents)}</span></div>
            <div class="tot-row"><span class="tot-lbl">SSCL (${fmtPct(summary.ssclRate)}%)</span><span class="tot-val">${fmtRs(summary.ssclCents)}</span></div>
            <div class="tot-row"><span class="tot-lbl">Value liable to VAT</span><span class="tot-val">${fmtRs(summary.vatLiableCents)}</span></div>
            <div class="tot-row"><span class="tot-lbl">VAT (${fmtPct(summary.vatRate)}%)</span><span class="tot-val">${fmtRs(summary.vatCents)}</span></div>
            <div class="grand-row">
              <span class="grand-lbl">SITE TOTAL (FINAL BILL)</span>
              <span class="grand-val">${fmtRs(summary.grandTotalCents)}</span>
            </div>
            <div class="vat-reg">${esc(COMPANY.vatReg)}</div>
          </div>
        </div>

        ${calloutHtml}
        ${transfersHtml}

        <div class="draft-banner">${esc(statusBannerText)}</div>
      </div>

      <div class="site-footer">
        <span class="foot-addr">${esc(COMPANY.address)}</span>
        <span class="foot-contact">${esc(COMPANY.contact)}</span>
      </div>
    </div>
  `;
}

function renderSiteSummaryHtml(input, { forPdf = false, downloadUrl = '' } = {}) {
  const summaries = Array.isArray(input) ? input : [input];
  const generatedAt = generatedDateStr();
  const titleText = summaries.length === 1
    ? `Site Summary Bill — ${summaries[0].siteCode} (${summaries[0].periodKey})`
    : `Site Summary Bills — All Sites (${summaries[0] ? summaries[0].periodKey : ''})`;

  const toolbarHtml = forPdf
    ? ''
    : `
      <div class="toolbar noprint">
        <button type="button" data-back>&larr; Back</button>
        <button type="button" data-print>&#128424; Print / Save as PDF</button>
        ${downloadUrl ? `<a class="primary" href="${esc(downloadUrl)}">&#11015; Download PDF</a>` : ''}
        <script src="/js/dom-actions.js"></script>
      </div>
    `;

  const bodyHtml = summaries.map((s, idx) => renderOneSiteSection(s, generatedAt, idx === summaries.length - 1)).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(titleText)}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm 8mm 10mm 8mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: ${forPdf ? '0' : '16px'};
      background: ${forPdf ? '#ffffff' : '#e2e8f0'};
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9px;
      color: #1e293b;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .toolbar {
      max-width: 820px;
      margin: 0 auto 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      background: #0f172a;
      padding: 10px 14px;
      border-radius: 8px;
      color: #fff;
    }
    .toolbar button, .toolbar a {
      font-size: 12px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #1e293b;
      color: #fff;
      cursor: pointer;
      text-decoration: none;
    }
    .toolbar a.primary {
      background: #f59e0b;
      border-color: #f59e0b;
      color: #0f172a;
      margin-left: auto;
    }
    .site-sheet {
      max-width: ${forPdf ? '100%' : '820px'};
      margin: 0 auto ${forPdf ? '0' : '22px'};
      background: #ffffff;
      box-shadow: ${forPdf ? 'none' : '0 6px 24px rgba(15, 23, 42, 0.14)'};
    }
    .page-break { page-break-after: always; break-after: page; }
    .header-band {
      background: #0f172a;
      color: #ffffff;
      padding: 16px 24px 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo-box { display: flex; align-items: center; gap: 10px; }
    .logo-mark {
      background: #ffffff;
      border-radius: 6px;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .co-name { font-size: 15px; font-weight: 700; letter-spacing: 0.3px; }
    .co-div { font-size: 8.5px; color: #93c5fd; margin-top: 2px; }
    .co-doc { font-size: 7.5px; color: #cbd5e1; margin-top: 2px; }
    .title-box { text-align: right; }
    .doc-title { font-size: 18px; font-weight: 800; color: #f59e0b; letter-spacing: 0.8px; }
    .doc-sub { font-size: 9.5px; font-weight: 700; color: #ffffff; margin-top: 3px; }
    .doc-badge { font-size: 7.5px; color: #93c5fd; margin-top: 2px; letter-spacing: 0.4px; }
    .accent-strip { height: 3px; background: #f59e0b; }
    .info-bar {
      background: #f1f5f9;
      padding: 9px 24px;
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #e2e8f0;
    }
    .info-lbl { font-size: 7px; font-weight: 700; color: #64748b; letter-spacing: 0.5px; margin-bottom: 2px; }
    .info-val { font-size: 9px; font-weight: 700; color: #0f172a; }
    .body-pad { padding: 14px 24px 18px; }
    .sec-label { font-size: 8px; font-weight: 700; color: #64748b; letter-spacing: 0.9px; margin-bottom: 6px; }
    .bill-table { width: 100%; border-collapse: collapse; }
    .bill-table thead { display: table-header-group; }
    .bill-table thead th {
      background: #0f172a;
      color: #ffffff;
      font-size: 7px;
      font-weight: 700;
      letter-spacing: 0.4px;
      padding: 6px 5px;
      text-align: left;
      vertical-align: middle;
    }
    .bill-table thead th.num, .bill-table tbody td.num { text-align: right; }
    .bill-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
    .bill-table tbody td {
      padding: 5.5px 5px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 8px;
      vertical-align: top;
      color: #1e293b;
    }
    .mach-code { font-weight: 700; color: #0f172a; }
    .sub { font-size: 6.8px; color: #64748b; margin-top: 1px; }
    .bd-tag { font-size: 6.5px; font-weight: 700; color: #b91c1c; margin-top: 1px; }
    .muted { color: #94a3b8; }
    .c-mach { width: 15%; }
    .c-days { width: 7%; white-space: nowrap; }
    .c-cons { width: 13%; }
    .c-meter { width: 11%; }
    .c-bill { width: 12%; }
    .c-rate { width: 10%; white-space: nowrap; }
    .c-rent { width: 13%; white-space: nowrap; }
    .c-fuel { width: 7%; white-space: nowrap; }
    .c-tot { width: 12%; white-space: nowrap; }
    .empty-row { text-align: center; padding: 18px; color: #64748b; }
    .totals-wrap { display: flex; justify-content: flex-end; margin-top: 14px; break-inside: avoid; }
    .totals-box { width: 58%; }
    .tot-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px solid #e2e8f0;
      font-size: 8.5px;
    }
    .tot-lbl { color: #64748b; }
    .tot-val { font-weight: 700; color: #0f172a; }
    .grand-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0f172a;
      color: #ffffff;
      padding: 8px 10px;
      margin-top: 6px;
      border-radius: 4px;
    }
    .grand-lbl { font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
    .grand-val { font-size: 12px; font-weight: 800; color: #f59e0b; }
    .vat-reg { font-size: 7.5px; color: #64748b; text-align: right; margin-top: 4px; }
    .warn-box {
      margin-top: 12px;
      padding: 8px 10px;
      background: #fef3c7;
      border-left: 3px solid #f59e0b;
      break-inside: avoid;
    }
    .warn-box p { margin: 0 0 4px 0; font-size: 7.5px; color: #92400e; line-height: 1.45; }
    .warn-box p:last-child { margin-bottom: 0; }
    .xfer-box {
      margin-top: 12px;
      padding: 9px 11px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-left: 3px solid #f59e0b;
      border-radius: 4px;
      break-inside: avoid;
    }
    .xfer-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .xfer-title { font-size: 8px; font-weight: 800; color: #92400e; letter-spacing: 0.4px; }
    .xfer-badge { font-size: 6.8px; font-weight: 700; color: #92400e; background: #fef3c7; padding: 2px 6px; border-radius: 3px; }
    .xfer-note { margin: 0 0 6px 0; font-size: 7.2px; color: #92400e; }
    .xfer-table { width: 100%; border-collapse: collapse; font-size: 7.5px; color: #78350f; }
    .xfer-table td { padding: 3px 4px; border-bottom: 1px solid #fde68a; }
    .xfer-ref { font-weight: 700; width: 28%; }
    .xfer-desc { width: 44%; }
    .xfer-l { width: 12%; }
    .xfer-amt { width: 16%; }
    .xfer-total-row td { border-top: 1.5px solid #f59e0b; border-bottom: none; padding-top: 5px; font-size: 7.8px; }
    .draft-banner {
      margin-top: 14px;
      padding: 8px;
      background: #f1f5f9;
      text-align: center;
      font-size: 8px;
      font-weight: 700;
      color: #64748b;
      letter-spacing: 0.4px;
      break-inside: avoid;
    }
    .site-footer {
      background: #0f172a;
      color: #ffffff;
      padding: 9px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 7.5px;
      break-inside: avoid;
    }
    .foot-addr { font-weight: 700; }
    .foot-contact { color: #93c5fd; }
    @media print {
      body { background: #ffffff; padding: 0; }
      .noprint { display: none !important; }
      .site-sheet { box-shadow: none; margin: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
${toolbarHtml}
${bodyHtml}
</body>
</html>`;
}

module.exports = {
  COMPANY,
  renderSiteSummaryHtml,
};
