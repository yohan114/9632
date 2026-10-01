'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Locate browser executable for headless print-to-pdf
function findBrowserPath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/**
 * Generate a PDF Buffer from an HTML string using headless browser.
 * @param {string} html The full HTML document string
 * @returns {Promise<Buffer>}
 */
async function generatePdfBuffer(html) {
  const browserPath = findBrowserPath();
  if (!browserPath) {
    const err = new Error('No supported browser (Edge or Chrome) found on host system for server-side PDF conversion');
    err.status = 501;
    throw err;
  }

  const nonce = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const tmpHtml = path.join(os.tmpdir(), `wo_doc_${nonce}.html`);
  const tmpPdf = path.join(os.tmpdir(), `wo_doc_${nonce}.pdf`);

  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');

    execFileSync(browserPath, [
      '--headless',
      '--disable-gpu',
      '--run-all-compositor-stages-before-draw',
      '--no-pdf-header-footer',
      `--print-to-pdf=${tmpPdf}`,
      tmpHtml,
    ], { timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });

    if (!fs.existsSync(tmpPdf)) {
      throw new Error('PDF conversion process completed without generating an output file');
    }

    return fs.readFileSync(tmpPdf);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpPdf); } catch {}
  }
}

/**
 * Express middleware helper to stream HTML as a downloadable PDF attachment.
 */
async function sendPdf(res, filename, html) {
  try {
    const buf = await generatePdfBuffer(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    // If PDF conversion fails, fallback gracefully to returning the printable HTML
    // with a header note so the user is never blocked from printing/saving.
    console.warn('PDF generator fallback to HTML print:', err.message);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }
}

module.exports = {
  findBrowserPath,
  generatePdfBuffer,
  sendPdf,
};
