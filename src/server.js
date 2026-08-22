'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./config');
const { migrate } = require('./db');
const { authenticate, enforcePasswordChange } = require('./lib/auth');
const { requireModule } = require('./lib/permissions');
const { errorHandler } = require('./lib/http');
const { startScheduler } = require('./lib/backup');
const dailyReports = require('./lib/daily_reports');
const emitter = require('./lib/emitter');

// Apply schema on boot (idempotent).
migrate();

const app = express();
app.set('trust proxy', true);
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

// Static frontend (SPA). index.html is served with a per-boot cache-bust token on
// app.js / styles.css so a normal reload always picks up the latest build.
const publicDir = path.join(__dirname, '..', 'public');
const BUILD = Date.now();
const sendIndex = (res) => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(/(\/(?:app\.js|styles\.css))(\?v=[^"']*)?/g, `$1?v=${BUILD}`);
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
const io = new Server(httpServer, { cors: { origin: '*' } });
app.set('io', io); // available to routes via req.app.get('io') if ever needed directly

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
    console.log('Reachable on this network at:');
    for (const u of lanUrls(config.port)) console.log('  ' + u);
  });
}

module.exports = app;
module.exports.httpServer = httpServer;
module.exports.io = io;
