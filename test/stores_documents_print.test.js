'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Its own database. This file used to render MIN 1234, GRN 7206, MTN 328 and MRN 3222 out of
// whatever DB_PATH pointed at - the live register on the PC it was written on, nothing at all on a
// clean checkout (CI), where every render came back null. The same numbers are now made here.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-docs-print-'));
process.env.DB_PATH = path.join(TMP, 'docs.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_INTERVAL_MINUTES = '0';
const { migrate, run } = require('../src/db');
migrate();
run("INSERT INTO issues (id, issue_date, description, qty, unit) VALUES (1234, '2026-10-06', 'Hydraulic Oil Seal 45x65', 2, 'nos')");
run("INSERT INTO grn (id, grn_no, grn_date, description, qty, unit_price, supplier) VALUES (7206, 'GRN-7206', '2026-10-06', 'Fan Belt', 4, 1200, 'Dimo')");
run("INSERT INTO mtn (id, mtn_no, txn_date, from_location, to_location, description, qty) VALUES (328, '328', '2026-10-06', 'Work Shop Stores', 'CEP-03 Wadakada', 'Fly Wheel', 1)");
run("INSERT INTO mtn_lines (mtn_id, line_no, description, qty, unit) VALUES (328, 1, 'Fly Wheel', 1, 'nos')");
run("INSERT INTO mrn (id, mrn_no, req_date, status) VALUES (3222, 'MRN-3222', '2026-10-06', 'open')");
run("INSERT INTO mrn_lines (mrn_id, description, qty, unit) VALUES (3222, 'Brake Pad Set', 2, 'nos')");
const { findBrowserPath } = require('../src/lib/pdf_generator');

const {
  renderMinDocumentHtml,
  renderGrnDocumentHtml,
  renderMtnDocumentHtml,
  renderMrnDocumentHtml,
} = require('../src/lib/stores_documents');
const { generatePdfBuffer } = require('../src/lib/pdf_generator');

test('Store ISO Documents: Styling, Layout & PDF Rendering', async (t) => {
  await t.test('1. MIN document matches EC1.ST.FO.04 specification and landscape layout', () => {
    const html = renderMinDocumentHtml(1234);
    assert.ok(html, 'MIN HTML rendered');
    assert.match(html, /size:\s*A4 landscape/, 'Specifies A4 landscape page size');
    assert.match(html, /Edward and Christie \(Pvt\) Ltd/, 'Has company header');
    assert.match(html, /Material Issue Note/, 'Has document title');
    assert.match(html, /Doc\. No\.: EC1\.ST\.FO\.04/, 'Has exact ISO document code');
    assert.match(html, /Issue No\.: 03/, 'Has exact Issue No');
    assert.match(html, /Date of Issue: 2018\.01\.26/, 'Has exact Date of Issue');
    assert.match(html, /Requested By[\s\S]*Approved By[\s\S]*Received By/, 'Has 3-column signatory table');
    assert.match(html, /stamp-no/, 'Has mechanical stamped number styling');

    // Counts data rows (at least 12 rows enforced)
    const rowMatches = html.match(/<tr>\s*<td class="c">/g) || [];
    assert.ok(rowMatches.length >= 12, `Expected at least 12 rows, got ${rowMatches.length}`);
  });

  await t.test('2. GRN document matches EC1.ST.FO.2:5:21.12 with address and boxed metadata', () => {
    const html = renderGrnDocumentHtml(7206);
    assert.ok(html, 'GRN HTML rendered');
    assert.match(html, /size:\s*A4 landscape/, 'Specifies A4 landscape page size');
    assert.match(html, /Goods Received Note \(GRN\)/, 'Has GRN title');
    assert.match(html, /No\.: 64\/9, Nawala Road, Nugegoda/, 'Has head office address subheader');
    assert.match(html, /Doc\. No\.: EC1\.ST\.FO\.2:5:21\.12/, 'Has exact GRN ISO code');
    assert.match(html, /grn-meta-table/, 'Has boxed metadata grid');
    assert.match(html, /Date of Received:/, 'Has Received Date field');
    assert.match(html, /Supplier:/, 'Has Supplier field');
    assert.match(html, /Bin Card<br>Page No\./, 'Has Bin Card column header');
    assert.match(html, /Prepared By[\s\S]*Approved By/, 'Has 2-column signatory table');
  });

  await t.test('3. MTN document matches EC1.ST.FO.05 with 4-stage signatures', () => {
    const html = renderMtnDocumentHtml(328);
    assert.ok(html, 'MTN HTML rendered');
    assert.match(html, /size:\s*A4 landscape/, 'Specifies A4 landscape page size');
    assert.match(html, /Materials\/ Goods Transfer Note/, 'Has MTN title');
    assert.match(html, /Doc\. No\.: EC1\.ST\.FO\.05/, 'Has exact MTN ISO code');
    assert.match(html, /Issue No\.: 04/, 'Has Issue No 04');
    assert.match(html, /Date of Issue: 2018\.07\.25/, 'Has Date of Issue');
    assert.match(html, /Transferred From :/, 'Has Transferred From field');
    assert.match(html, /Transferred To :/, 'Has Transferred To field');
    assert.match(html, /Prepared By[\s\S]*Approved By[\s\S]*Received By[\s\S]*Accepted By/, 'Has 4-stage signatory grid');
  });

  await t.test('4. MRN document matches EC1.ST.FO.01 requisition layout', () => {
    const html = renderMrnDocumentHtml(3222);
    assert.ok(html, 'MRN HTML rendered');
    assert.match(html, /size:\s*A4 landscape/, 'Specifies A4 landscape page size');
    assert.match(html, /Material Requisition/, 'Has MRN title');
    assert.match(html, /Doc\. No\.: EC1\.ST\.FO\.01/, 'Has exact MRN ISO code');
    assert.match(html, /Issue No\.: 04/, 'Has Issue No 04');
    assert.match(html, /Date of Issue: 2018\.11\.14/, 'Has Date of Issue');
    assert.match(html, /Received Qty\.<br>\(Cumulative\)/, 'Has cumulative received qty column');
    assert.match(html, /Available<br>Qty\./, 'Has available qty column');
    assert.match(html, /Required<br>Qty\./, 'Has required qty column');
  });

  // Needs Edge or Chrome on the machine (pdf_generator.findBrowserPath); skipped where there is none.
  await t.test('5. Headless Edge generates single-page PDF without errors', { skip: !findBrowserPath() && 'no Edge or Chrome on this machine' }, async () => {
    const html = renderMinDocumentHtml(1234, { forPdf: true });
    const pdfBuf = await generatePdfBuffer(html);
    assert.ok(pdfBuf && pdfBuf.length > 5000, 'Generates valid non-empty PDF binary');
    assert.equal(pdfBuf.slice(0, 5).toString('utf8'), '%PDF-', 'Buffer starts with PDF header');

    // Confirm PDF is exactly 1 page
    const pageCount = (pdfBuf.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.equal(pageCount, 1, 'PDF fits exactly on 1 page without spillover');
  });
});
