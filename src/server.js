'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./config');
const { migrate, get } = require('./db');
const { authenticate, enforcePasswordChange, COOKIE } = require('./lib/auth');
const { requireModule } = require('./lib/permissions');
const { errorHandler } = require('./lib/http');
const { startScheduler } = require('./lib/backup');
const dailyReports = require('./lib/daily_reports');
const emitter = require('./lib/emitter');

// Apply schema on boot (idempotent).
migrate();

const app = express();
// WHO IS ALLOWED TO TELL US THE VISITOR'S ADDRESS.
//
// `true` trusts any X-Forwarded-For header from anyone. On the workshop LAN that was harmless.
// Facing the internet it is a hole: a client sends "X-Forwarded-For: 1.2.3.4", changes it every
// request, and walks straight through the login rate limiter, which counts by address.
//
// In production only the proxy on this machine is believed. nginx sits on 127.0.0.1, rewrites the
// address to the real visitor using Cloudflare's CF-Connecting-IP (see deploy/nginx-storesdb.conf),
// and passes it on — so the chain of trust ends at something we control. A request arriving from
// anywhere else has its forwarding headers ignored, which is exactly what should happen.
app.set('trust proxy', process.env.TRUST_PROXY
  || (process.env.NODE_ENV === 'production' ? 'loopback' : true));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(authenticate);
app.use(enforcePasswordChange);

// Uploaded evidence photos.
fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir));

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'WorkshopOne' }));

// API routers. Each module is a self-contained Express Router. Operational
// modules are gated by the RBAC matrix (requireModule); reference/analytics
// routers (aliases, projects, mechanics, reports) stay open to any authenticated
// user (they feed dropdowns + dashboards) and are hidden at the nav level only.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/access', require('./routes/access'));
app.use('/api/assets', requireModule('assets'), require('./routes/assets'));
app.use('/api/aliases', require('./routes/aliases'));
app.use('/api/projects', require('./routes/projects'));
// MRN approval transitions (certify/approve/reject) are authorised by ROLE, not by
// stores-edit level: the Workshop Engineer and Operational Manager who sign off an
// MRN deliberately hold only stores=view (they must not edit stock). Let those three
// POST paths past the module-edit gate; each route still enforces its own requireRole.
const MRN_APPROVAL_PATH = /\/mrn\/\d+\/(certify|approve|reject)$/;
const storesGate = (req, res, next) =>
  (req.method === 'POST' && MRN_APPROVAL_PATH.test(req.path))
    ? next()
    : requireModule('stores')(req, res, next);
app.use('/api/stores', storesGate, require('./routes/stores'));
app.use('/api/general-stock', requireModule('stores'), require('./routes/general_stock'));
app.use('/api/oil', requireModule('oil'), require('./routes/oil'));
app.use('/api/batteries', requireModule('batteries'), require('./routes/batteries'));
app.use('/api/filters', requireModule('filters'), require('./routes/filters'));
app.use('/api/filter-stock', requireModule('filters'), require('./routes/filter_stock'));
app.use('/api/jobs', requireModule('jobs'), require('./routes/jobcards'));
app.use('/api/job-requests', requireModule('jobrequests'), require('./routes/jobrequests'));
app.use('/api/daily-work', requireModule('dailywork'), require('./routes/dailywork'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/mechanics', require('./routes/mechanics'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
// Gated on the reports module: GET needs reports:view (all roles), price/override writes need
// reports:edit (managers/admin) — a read-only viewer can't tamper with cost-report pricing.
app.use('/api/tyre-battery', requireModule('reports'), require('./routes/tyre_battery'));
// Requesting, issuing and accounting for the old unit. Mounted apart from the reporting routes
// above because those are gated on `reports` — a storekeeper who may not read cost reports still
// has to be able to issue a tyre. Each endpoint carries its own role check instead, and the
// specification picklist is deliberately open to any signed-in user so the form can be filled in.
app.use('/api/tb', require('./routes/tyre_battery_requests'));
// Buying what the workshop asked for. Gated on its own module so the two purchasing officers see
// the queue and nobody else does; WHICH of the two channels each sees is decided inside the router
// by role, because a permission level can say "may use this screen" but not "may use half of it".
app.use('/api/purchasing', requireModule('purchasing'), require('./routes/purchasing'));

// Static frontend (SPA). index.html is served with a per-boot cache-bust token on
// app.js / styles.css so a normal reload always picks up the latest build.
const publicDir = path.join(__dirname, '..', 'public');
const BUILD = Date.now();
// EVERY script and stylesheet gets the token, not just app.js and styles.css.
//
// It used to cover only those two, and the files under /js/ were left to the browser's own
// caching. That held until app.js started calling a function that had just been ADDED to
// /js/live-client.js: browsers took the new app.js and kept the old live-client.js, and the
// mismatch threw "LiveERP.connect is not a function" during boot — which the login screen reported
// as a server connection problem, so a live-update nicety broke signing in altogether.
//
// The quieter half was worse. The stale live-client had no handling for a refused socket and
// retried once a second forever, against a server that had just started refusing anonymous ones.
// Every open tab became a permanent stream of failing connections, and the site felt slow.
const sendIndex = (res) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(/(\/(?:app\.js|styles\.css|js\/[\w.-]+\.(?:js|css)))(\?v=[^"']*)?/g, `$1?v=${BUILD}`);
  res.type('html').set('Cache-Control', 'no-cache').send(html);
};
app.get('/', (_req, res) => sendIndex(res));
app.use(express.static(publicDir, { index: false }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  sendIndex(res);
});

app.use(errorHandler);

// ---- Real-time layer (socket.io) ------------------------------------------
// Wrap the Express app in a raw HTTP server so socket.io can share the same port,
// then bridge our in-process event bus (lib/emitter) out to all connected clients.
// Route files stay unchanged — they just call emitter.emit('<event>', data); we
// forward each known event to every socket. Nothing above this line changed.
const httpServer = http.createServer(app);
// On the LAN any origin was fine — nothing else was on the network. Behind a public domain an
// open socket accepts a connection from any page on the internet, so in production it is pinned to
// the site's own origin. PUBLIC_ORIGIN is the https:// address the workshop actually types.
const io = new Server(httpServer, {
  cors: { origin: process.env.PUBLIC_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*') },
});
app.set('io', io); // available to routes via req.app.get('io') if ever needed directly

// ---- who may open a live socket -------------------------------------------
//
// THE CORS OPTION ABOVE IS NOT A DOOR LOCK. Browsers do not apply the same-origin rules to
// WebSocket connections, so `origin` stops nothing once the transport upgrades: any page on the
// internet could open a socket here and sit on it. Everything the workshop does is broadcast down
// that socket — stock movements, job updates, requests as they are raised — so an unauthenticated
// listener is a live feed of the company's operations to whoever asks for it. On the LAN that was
// theoretical. Behind a public domain it is not.
//
// So a socket is authenticated exactly like every other request: by the session cookie the browser
// already sends with the handshake, checked against the sessions table. The cors pin stays as
// defence in depth for the polling transport, but this is the part that actually decides.
function sessionTokenFromCookies(header) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

io.use((socket, next) => {
  const token = sessionTokenFromCookies(socket.handshake.headers.cookie);
  // The message matters: the browser client reads it to tell "not signed in" (stop retrying, wait
  // for a login) apart from "server is down" (keep retrying). Without that distinction the login
  // page reconnects once a second forever and toasts about it.
  if (!token) return next(new Error('unauthorized'));
  const sess = get(
    `SELECT u.id, u.username, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`,
    token
  );
  if (!sess || !sess.active) return next(new Error('unauthorized'));
  socket.data.user = { id: sess.id, username: sess.username };
  return next();
});

const LIVE_EVENTS = ['stock_updated', 'oil_updated', 'filter_updated', 'job_updated', 'request_updated', 'dashboard_refresh', 'data_changed'];
for (const event of LIVE_EVENTS) {
  emitter.on(event, (data) => io.emit(event, data));
}
io.on('connection', (socket) => {
  socket.emit('live_hello', { ok: true, at: new Date().toISOString() });
});

function lanUrls(port) {
  const os = require('os');
  const urls = [`http://localhost:${port}`];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
    }
  }
  return urls;
}

if (require.main === module) {
  startScheduler();
  // Freeze the day's Pending Parts and Maintenance Summery, hourly, so the record keeps itself.
  dailyReports.startScheduler();
  httpServer.listen(config.port, config.host, () => {
    console.log(`WorkshopOne listening on ${config.host}:${config.port}`);
    console.log('Real-time (socket.io) enabled');

    // WHICH DATABASE, AND DOES ANYONE LIVE IN IT.
    //
    // DB_PATH is resolved against the app directory, so a relative value in .env — which is what
    // .env.example ships — points beside the code rather than at wherever the real database was
    // put. SQLite then creates the file, migrate() fills in the schema, and the app starts
    // perfectly on an empty database. The only symptom is that every correct password is
    // rejected, because there are no accounts to match: it reads as "I forgot the password",
    // which sends you looking in entirely the wrong place. It cost an hour on the VPS cut-over.
    const { get } = require('./db');
    const users = get('SELECT COUNT(*) c FROM users').c;
    console.log(`Database: ${config.dbPath} (${users} user account${users === 1 ? '' : 's'})`);
    if (users === 0) {
      console.warn('  ** NO USER ACCOUNTS — nobody can sign in. **');
      console.warn('  ** Almost always the wrong DB_PATH: this is a new, empty database. **');
      console.warn('  ** Check .env against where the real file actually is. **');
    }

    console.log('Reachable on this network at:');
    for (const u of lanUrls(config.port)) console.log('  ' + u);
  });
}

module.exports = app;
module.exports.httpServer = httpServer;
module.exports.io = io;
