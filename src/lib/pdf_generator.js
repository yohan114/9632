'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Locate browser executable for headless print-to-pdf.
//
// WHAT IS SET EXPLICITLY WINS. CHROME_BIN and EDGE_BIN used to be looked at last, after the
// four Windows install paths, so on a PC with Edge installed the variable someone had set on
// purpose was ignored.
//
// LINUX PATHS ARE NOT OPTIONAL. The list was Windows-only, so on the server every download fell
// back to browser print with "No supported browser (Edge or Chrome) found" — including after
// Chrome had been installed, because nothing looked in /usr/bin. The server logged that twice
// in a minute on 1 October: somebody pressed the button, got HTML, and pressed it again.
function findBrowserPath() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    // Windows: the office PC and the LAN machines.
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Linux: the VPS. Chrome's own .deb, then the distribution's chromium, then the snap.
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
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
  // A PROFILE OF ITS OWN, thrown away afterwards. Without it the browser opens the profile of
  // whoever the server runs as — which on the office PC is a person who has that browser open.
  // A second instance on one profile waits for the first, and the wait is the whole 25 seconds
  // below: the storekeeper gets nothing while a browser window sits there. A fresh profile also
  // starts cleaner (measured: 344-373 ms against 413-454 ms, byte-identical PDF) because there
  // is no history, no extensions and nothing to sync.
  const tmpProfile = path.join(os.tmpdir(), `wo_doc_${nonce}_profile`);

  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');

    execFileSync(browserPath, [
      '--headless',
      '--disable-gpu',
      '--run-all-compositor-stages-before-draw',
      '--no-pdf-header-footer',
      `--user-data-dir=${tmpProfile}`,
      // Printing a local file needs none of this, and each of them is a way for a first run to
      // sit waiting on the network instead of drawing the page.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
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
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
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
