'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { migrate } = require('./db');
const { authenticate } = require('./lib/auth');
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

// Uploaded evidence photos.
fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir));

// Health check.
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'WorkshopOne' }));

// API routers. Each module is a self-contained Express Router.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/aliases', require('./routes/aliases'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/oil', require('./routes/oil'));
app.use('/api/batteries', require('./routes/batteries'));
app.use('/api/jobs', require('./routes/jobcards'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));

// Static frontend (SPA).
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(errorHandler);

if (require.main === module) {
  startScheduler();
  app.listen(config.port, () => {
    console.log(`WorkshopOne listening on http://localhost:${config.port}`);
  });
}

module.exports = app;
