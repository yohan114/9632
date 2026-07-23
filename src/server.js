'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { migrate } = require('./db');
const { authenticate, enforcePasswordChange } = require('./lib/auth');
const { requireModule } = require('./lib/permissions');
const { errorHandler } = require('./lib/http');
const { startScheduler } = require('./lib/backup');

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
app.use('/api/stores', requireModule('stores'), require('./routes/stores'));
app.use('/api/oil', requireModule('oil'), require('./routes/oil'));
app.use('/api/batteries', requireModule('batteries'), require('./routes/batteries'));
app.use('/api/filters', requireModule('filters'), require('./routes/filters'));
app.use('/api/jobs', requireModule('jobs'), require('./routes/jobcards'));
app.use('/api/job-requests', requireModule('jobrequests'), require('./routes/jobrequests'));
app.use('/api/daily-work', requireModule('dailywork'), require('./routes/dailywork'));
app.use('/api/mechanics', require('./routes/mechanics'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));

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
  app.listen(config.port, config.host, () => {
    console.log(`WorkshopOne listening on ${config.host}:${config.port}`);
    console.log('Reachable on this network at:');
    for (const u of lanUrls(config.port)) console.log('  ' + u);
  });
}

module.exports = app;
