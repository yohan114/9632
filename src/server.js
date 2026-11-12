'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const config = require('./config');
const { migrate, get, multidb } = require('./db');
const { authenticate, enforcePasswordChange, enforceMfaSetup, requireAuth, hasCap, rolesForUser, liveSession, COOKIE } = require('./lib/auth');
const { requireModule } = require('./lib/permissions');
const { errorHandler, asyncHandler } = require('./lib/http');
const { startScheduler } = require('./lib/backup');
const backupStatus = require('./lib/backup_status');
const { securityHeaders, originGuard, trustedOrigins, originAllowed } = require('./lib/security');
const dailyReports = require('./lib/daily_reports');
const emitter = require('./lib/emitter');
const vehicleDocuments = require('./lib/vehicle_documents');

// Apply schema on boot (idempotent).
migrate();
try {
  require('./lib/store_locations').seedStoreLocations();
} catch (e) {
  console.warn('Store locations seed warning:', e.message);
}

const app = express();
// WHO IS ALLOWED TO TELL US THE VISITOR'S ADDRESS.
//
// `true` trusts any X-Forwarded-For header from anyone. On the workshop LAN that was harmless.
// Facing the internet it is a hole: a client sends "X-Forwarded-For: 1.2.3.4", changes it every
// request, and walks straight through the login rate limiter, which counts by address.
//
// Only the proxy on this machine is believed — in every mode, not just production: a LAN server
// with NODE_ENV unset is just as reachable by someone who wants past the rate limiter. nginx sits on
// 127.0.0.1, rewrites the address to the real visitor using Cloudflare's CF-Connecting-IP (see
// deploy/nginx-storesdb.conf), and passes it on — so the chain of trust ends at something we
// control. A request arriving from anywhere else has its forwarding headers ignored, which is
// exactly what should happen. TRUST_PROXY overrides this for a proxy on another machine.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
// "X-Powered-By: Express" tells a scanner which exploits to try first, and tells a user nothing.
app.disable('x-powered-by');
app.use(securityHeaders);
// Before the body parsers: a cross-site write is refused before its body is even read.
app.use('/api', originGuard());

// Targeted body parsers (M1): global 1mb limit, raised to 50mb strictly on upload endpoints
const uploadJson = express.json({ limit: '50mb' });
const uploadUrlencoded = express.urlencoded({ limit: '50mb', extended: true });
const standardJson = express.json({ limit: '1mb' });
const standardUrlencoded = express.urlencoded({ limit: '1mb', extended: true });

const isUploadRoute = (req) => {
  const p = (req.originalUrl || req.url || '').split('?')[0];
  return (
    p.includes('/photos') ||
    p.includes('/attachments') ||
    p.includes('/images') ||
    p.includes('/invoices') ||
    p.includes('/evidence') ||
    p.includes('/vehicle-documents') ||
    p.includes('/fleet/documents') ||
    p.includes('/signature')
  );
};

app.use(cookieParser());
app.use(authenticate);
// Bounded request body limits (DoS prevention), parsed AFTER authenticate on purpose:
// 1mb for everyone, 50mb only on upload endpoints for a request authenticate() has actually signed
// in. Checking for a session COOKIE instead (as this did) let anyone send `wo_session=x` and have a
// 50mb body read before anything looked at whether the cookie was real. Nothing in authenticate,
// multidb or the context middleware reads req.body.
app.use((req, res, next) => {
  if (isUploadRoute(req) && req.user) {
    return uploadJson(req, res, (err) => {
      if (err) return next(err);
      uploadUrlencoded(req, res, next);
    });
  }
  return standardJson(req, res, (err) => {
    if (err) return next(err);
    standardUrlencoded(req, res, next);
  });
});
app.use(multidb.multidbMiddleware);
app.use(require('./lib/context').activeContextMiddleware);
app.use(enforcePasswordChange);
// Someone whose role requires two-factor sign-in, and who has not set it up, reaches only the
// enrolment screens until they have (src/lib/auth.js).
app.use(enforceMfaSetup);

// Protected Uploads & Attachment Vault:
// Static unauthenticated mounts removed. All file downloads strictly verify authentication,
// capability grants, and site/project tenancy before serving file bytes.
fs.mkdirSync(config.uploadDir, { recursive: true });

app.get('/uploads/*', requireAuth, asyncHandler(async (req, res) => {
  let relPath = (req.params[0] || req.path.replace(/^\/uploads\/?/, '')).trim();
  try { relPath = decodeURIComponent(relPath); } catch (_) {}
  if (!relPath || relPath.includes('..') || relPath.includes('\0') || path.isAbsolute(relPath)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const uploadBase = path.resolve(config.uploadDir);
  const fullPath = path.resolve(uploadBase, relPath);

  if (!fullPath.startsWith(uploadBase) || !fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const st = fs.statSync(fullPath);
  if (st.isDirectory()) {
    return res.status(403).json({ error: 'Directory listing forbidden' });
  }

  const user = req.user;
  const normalized = relPath.replace(/\\/g, '/');

  // 1. Vehicle statutory documents & certificates
  if (normalized.startsWith('vehicle_documents/')) {
    if (!hasCap(user, 'vehicle_docs.view')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient capability vehicle_docs.view' });
    }
    const parts = normalized.split('/');
    const assetId = Number(parts[1]);
    if (assetId && user && !user.isAllSitesMode && user.activeProjectId) {
      const asset = get('SELECT current_project_id, home_project_id FROM assets WHERE id = ?', assetId);
      if (asset) {
        const isCurrent = asset.current_project_id === user.activeProjectId;
        const isHome = asset.home_project_id === user.activeProjectId;
        if (!isCurrent && !isHome) {
          return res.status(403).json({ error: 'Forbidden: Document belongs to a vehicle outside your project site' });
        }
      }
    }
  }
  // 2. Technical and fabrication drawings
  else if (normalized.startsWith('drawings/')) {
    if (!hasCap(user, 'fabrication.view') && !hasCap(user, 'jobs.view')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient capability to view technical drawings' });
    }
  }
  // 3. Evidence photos
  else if (normalized.startsWith('evidence/')) {
    if (!hasCap(user, 'jobs.view') && !hasCap(user, 'stores.view')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient capability to view evidence photos' });
    }
  }
  // 4. Outsourcing documents
  else if (normalized.startsWith('outsourcing/')) {
    if (!hasCap(user, 'outsourcing.view')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient capability outsourcing.view' });
    }
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An uploaded file is someone else's content served from OUR origin. Opened directly (an .html,
  // an .svg, anything a browser would render), it must not run script as this site: the sandbox
  // gives it a unique opaque origin with scripts off. Anything that is not a plain image or a PDF is
  // handed over as a download instead of being rendered at all.
  //
  // PDFs are the exception to the sandbox: Chrome's built-in PDF viewer can refuse to open a
  // sandboxed document, and a PDF cannot run script as this site anyway — any script in it runs
  // inside the viewer, not in the page's origin.
  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.pdf') res.setHeader('Content-Security-Policy', 'sandbox');
  if (!INLINE_UPLOAD_EXTS.has(ext)) res.attachment(path.basename(fullPath));
  return res.sendFile(fullPath);
}));
// SVG is deliberately absent: it is an image format that can carry script.
const INLINE_UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf']);

const RELEASE_ID = process.env.RELEASE_ID || process.env.GIT_REV || '873c230e2129ec78c06d61066fece0b2ad5a1a8b-v0.1.0';

// Health check. Public: "is it up" and release id. An admin additionally sees whether the
// backups are actually happening — the question nobody asks until the day they are needed.
app.get('/api/health', (req, res) => {
  const out = { ok: true, name: 'WorkshopOne', releaseId: RELEASE_ID };
  if (hasCap(req.user, 'system.status')) out.backup = backupStatus.summary();
  res.json(out);
});

let activeMaintenance = null;

// Maintenance status query: returns current active update notice if any
app.get('/api/system/maintenance-status', (_req, res) => {
  if (!activeMaintenance || Date.now() >= activeMaintenance.expiresAt) {
    activeMaintenance = null;
    return res.json({ active: false });
  }
  const remainingSeconds = Math.max(0, Math.round((activeMaintenance.expiresAt - Date.now()) / 1000));
  res.json({
    active: true,
    ...activeMaintenance,
    remainingSeconds
  });
});

// Maintenance broadcast endpoint: callable with explicitly provisioned system secret (from CLI) or admin session
app.post('/api/system/maintenance-broadcast', (req, res) => {
  const secretHeader = req.headers['x-system-secret'];
  const provisionedSecret = process.env.MAINTENANCE_BROADCAST_SECRET ||
    (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'unused-session-tokens-are-random' ? process.env.SESSION_SECRET : null);

  // With that secret unset, header-based authorization must fail
  const isSecretValid = Boolean(provisionedSecret && secretHeader && secretHeader === provisionedSecret);
  const isUserAuthorized = Boolean(req.user && hasCap(req.user, 'system.status'));

  if (!isSecretValid && !isUserAuthorized) {
    return res.status(403).json({ error: 'Unauthorized broadcast: invalid or unprovisioned system secret' });
  }

  const seconds = Math.max(1, Math.round(Number(req.body?.seconds || (Number(req.body?.minutes) * 60) || 120)));
  const title = String(req.body?.title || '⚠️ SYSTEM UPDATE NOTICE');
  const message = String(req.body?.message || `The system is updating in ${Math.ceil(seconds / 60)} minutes. Please save all files and tasks and log out now.`);

  const payload = {
    title,
    message,
    seconds,
    expiresAt: Date.now() + seconds * 1000,
    timestamp: new Date().toISOString()
  };

  activeMaintenance = payload;

  emitter.emit('maintenance_alert', payload);
  if (io) io.emit('maintenance_alert', payload);

  res.json({ ok: true, broadcasted: true, payload });
});

// Global API authentication gate (R-04):
// Every /api route requires an authenticated session, except /api/auth/login, /api/health,
// /api/auth/mfa/verify, /api/system/maintenance-broadcast and /api/system/maintenance-status.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/health' || req.path === '/auth/mfa/verify' ||
      req.path === '/system/maintenance-broadcast' || req.path === '/system/maintenance-status' ||
      req.path.startsWith('/sap/')) return next();
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
});

// API routers. Each module is a self-contained Express Router. Operational
// modules are gated by the RBAC matrix (requireModule); reference/analytics
// routers (aliases, projects, mechanics, reports) stay open to any authenticated
// user (they feed dropdowns + dashboards) and are hidden at the nav level only.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/access', require('./routes/access'));
app.use('/api/dual-auth', require('./routes/dual_auth'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/audit-logs', require('./routes/audit_logs'));
// The picker lists stay open to anyone signed in; anything else about a vehicle needs Assets.
// This only relaxes the MODULE check -- the global /api gate above still demands a session -- and
// routes/assets.js trims those two responses to PICKER_FIELDS, so no cost or history goes with
// them. Without this the hard gate 403s the pickers before the route can trim them, which is the
// shape this merge first produced: a hard gate from one lineage over a trimming route from the other.
const PICKER_PATH = new Set(['/', '/search']);
const assetsGate = (req, res, next) => (req.method === 'GET' && PICKER_PATH.has(req.path) ? next() : requireModule('assets')(req, res, next));
app.use('/api/assets', assetsGate, require('./routes/assets'));
// The alias queue is a section of its own: it was reachable by any signed-in account, including a
// role given nothing, because this lineage gated the reference routers in the nav only.
app.use('/api/aliases', requireModule('aliases', 'view'), require('./routes/aliases'));
// Job Cards: the Monitor and the Requests list (job cards plan). Checks its own module access.
app.use('/api/job-flow', require('./routes/jobflow'));
// The project list fills the pickers on the vehicle, job card and job request forms, so GET / stays
// open to anyone signed in and routes/projects.js returns names only without Projects clearance.
// A single project, its cost and its sites are the section proper, and need it.
//
// READS only. Every write in routes/projects.js carries its own requireCap('projects.manage'), and
// gating them here as well would answer "no view access to projects" from the mount before the
// route could name the permission the person is actually missing -- which is the more useful
// refusal, and what test/capabilities.test.js asks for. Contrast /api/aliases just above, gated on
// every method: its POST /resolve has no capability of its own and hands back a whole asset row,
// so leaving writes open there would be a way round the trimming that /api/assets does.
const projectsGate = (req, res, next) => (
  req.method !== 'GET' || req.path === '/' ? next() : requireModule('projects', 'view')(req, res, next));
app.use('/api/projects', projectsGate, require('./routes/projects'));
// MRN approval transitions (certify/approve/reject) are authorised by ROLE, not by
// stores-edit level: the Workshop Engineer and Operational Manager who sign off an
// MRN deliberately hold only stores=view (they must not edit stock). Let those three
// POST paths past the module-edit gate; each route still enforces its own requireRole.
const MRN_APPROVAL_PATH = /\/mrn\/\d+\/(certify|approve|reject)$/;
// Head office approves a stock take (stores plan, Part 2) the same way: by capability, from stores=view.
const COUNT_APPROVAL_PATH = /^\/counts\/\d+\/(approve|send-back|cancel)$/;
// And a manager approves a disposal note (Part 4); the route checks the capability.
const DISPOSAL_APPROVAL_PATH = /^\/disposals\/\d+\/(approve|cancel)$/;
const storesGate = (req, res, next) =>
  (req.method === 'POST' && (MRN_APPROVAL_PATH.test(req.path) || COUNT_APPROVAL_PATH.test(req.path) || DISPOSAL_APPROVAL_PATH.test(req.path)))
    ? next()
    : requireModule('stores')(req, res, next);
app.use('/api/stores', storesGate, require('./routes/stores'));
app.use('/api/store-locations', require('./routes/store_locations'));
app.use('/api/stores/locations', require('./routes/store_locations'));
app.use('/api/general-stock', requireModule('stores'), require('./routes/general_stock'));
app.use('/api/oil', requireModule('oil'), require('./routes/oil'));
app.use('/api/batteries', requireModule('batteries'), require('./routes/batteries'));
app.use('/api/filters', requireModule('filters'), require('./routes/filters'));
app.use('/api/filter-stock', requireModule('filters'), require('./routes/filter_stock'));
app.use('/api/tools', require('./routes/tools'));
// The stock cockpit reads the whole stores position, so it needs Stores clearance. This branch
// mounted it bare and its own routes ask only for requireAuth, which left every signed-in account
// -- including a role deliberately given nothing -- able to read it. main gated the mount; that
// gate is kept, in this branch's vocabulary.
app.use('/api/stock-cockpit', requireModule('stores'), require('./routes/stock_cockpit'));
const jobsGate = (req, res, next) => {
  if (req.user && (hasCap(req.user, 'fabrication.open_card') || (req.user.roles && req.user.roles.includes('fabrication_officer')))) {
    return next();
  }
  return requireModule('jobs')(req, res, next);
};
app.use('/api/jobs', jobsGate, require('./routes/jobcards'));
const jobRequestsGate = (req, res, next) => {
  if (req.user && (hasCap(req.user, 'jobrequests.create_fabrication') || (req.user.roles && req.user.roles.includes('fabrication_officer')))) {
    return next();
  }
  return requireModule('jobrequests')(req, res, next);
};
app.use('/api/job-requests', jobRequestsGate, require('./routes/jobrequests'));
const fabricationGate = (req, res, next) => {
  if (req.path.startsWith('/categories') || req.path.startsWith('/drawings')) {
    return requireAuth(req, res, next);
  }
  return requireModule('fabrication', 'view')(req, res, next);
};
app.use('/api/fabrication', fabricationGate, require('./routes/fabrication'));
const dailyWorkGate = (req, res, next) =>
  req.path.startsWith('/mechanics-kpi')
    ? requireAuth(req, res, next)
    : requireModule('dailywork')(req, res, next);
app.use('/api/daily-work', dailyWorkGate, require('./routes/dailywork'));
// Mechanic attendance and the day tally. Reading needs Daily Work view (checked inside); each write
// is decided by its own capability, because the managers who sign off and unlock a day hold Daily
// Work at view only.
app.use('/api/attendance', require('./routes/attendance'));
// Field work (Stage 6): reading needs Job Cards view (checked inside); each write its own capability.
app.use('/api/field', require('./routes/field'));
// Stage 7: operations — machine moves, the site fleet board, workshops at a glance, handovers.
app.use('/api/operations', require('./routes/operations'));
app.use('/api/dashboard', requireModule('dashboard'), require('./routes/dashboard'));
app.use('/api/mechanics', require('./routes/mechanics'));
app.use('/api/workshops', require('./routes/workshops'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
// Vehicle lubricant capacities from Fleet_Oil_Lubricant_Capacities.xlsx
app.use('/api/lubricant-capacities', requireModule('lubricants'), require('./routes/lubricant_capacities'));
app.use('/api/tyre-battery', requireModule('tb_reports'), require('./routes/tyre_battery'));
// Vehicle documents & statutory renewal monitoring (Operations / Fleet)
app.use('/api/vehicle-documents', require('./routes/vehicle_documents'));
app.use('/api/fleet/documents', require('./routes/vehicle_documents'));
// Requesting, issuing and accounting for the old unit. Mounted apart from the reporting routes
// above because those are gated on `reports` — a storekeeper who may not read cost reports still
// has to be able to issue a tyre. Each endpoint carries its own role check instead, and the
// specification picklist is deliberately open to any signed-in user so the form can be filled in.
app.use('/api/tb', require('./routes/tyre_battery_requests'));
// Buying what the workshop asked for. Gated on its own module so the two purchasing officers see
// the queue and nobody else does; WHICH of the two channels each sees is decided inside the router
// by role, because a permission level can say "may use this screen" but not "may use half of it".
// Priority changes happen from the workshop and stores screens day-to-day, so those two endpoints
// are open to anyone who holds the capability or workshop/stores role (checked inside the router).
const PURCHASING_PRIORITY_PATH = /^\/lines\/\d+\/(priority|priority-history|delivery-location)$/;
const purchasingGate = (req, res, next) =>
  PURCHASING_PRIORITY_PATH.test(req.path)
    ? next()
    : requireModule('purchasing')(req, res, next);
app.use('/api/purchasing', purchasingGate, require('./routes/purchasing'));

// Enterprise SAP Integration Gateway (OData v4 & REST compliant with SAP API Style Guide)
app.use('/api/sap/v1', require('./routes/sap'));

// CCOM Outsourced Service & Repair Requests
app.use('/api/outsourcing', require('./routes/outsourcing'));

// Fuel Operations & Bulk Tanks (Plan V2)
app.use('/api/fuel/tanks', require('./routes/fuel_tanks'));
app.use('/api/fuel', require('./routes/fuel'));

// Fleet Allocations & Machine Hire Billing (Plan V2)
app.use('/api/hire', require('./routes/hire_billing'));

// Fleet Financial Reporting & Profitability (Plan V2)
app.use('/api/fleet/finance', require('./routes/fleet_finance'));

// Consolidated Master Dashboard (Plan V2)
app.use('/api/master-dashboard', require('./routes/master_dashboard'));

// Vehicle Final Costing Report & Monthly Fleet Costing (Master Costing Engine)
app.use('/api/vehicle-costing', require('./routes/vehicle_costing'));

// Meter Readings & Daily Telemetry
app.use('/api/meters', require('./routes/meters'));
app.use('/api/fuel/readings', require('./routes/meters'));

// Fuel System compatibility aliases
app.use('/api/tanks', require('./routes/fuel_tanks'));
app.use('/api/billing', require('./routes/hire_billing'));

// Static frontend (SPA). index.html is served with a per-boot cache-bust token on
// app.js / styles.css so a normal reload always picks up the latest build.
const publicDir = path.join(__dirname, '..', 'public');
const BUILD = Date.now();
const getBuildToken = () => {
  try {
    const stat = fs.statSync(path.join(publicDir, 'app.js'));
    return Math.floor(stat.mtimeMs);
  } catch {
    return BUILD;
  }
};
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
  const token = getBuildToken();
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace(/(\/(?:app\.js|styles\.css|(?:js|modules)\/[\w.-]+\.(?:js|css)))(\?v=[^"']*)?/g, `$1?v=${token}`);
  res.type('html').set('Cache-Control', 'no-cache, no-store, must-revalidate').set('Pragma', 'no-cache').send(html);
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
// The socket is pinned to this site and the trusted app origins (PUBLIC_ORIGIN, the packaged
// Android app, CSRF_TRUSTED_ORIGINS — the same list the CSRF check uses, src/lib/security.js).
// It used to answer every origin WITH credentials, so any page on the internet could ride a signed-in
// visitor's cookie into the live feed through the polling transport.
//
// Two locks. `cors` only grants the cross-origin read to a trusted origin (this site's own pages are
// same-origin and need no CORS header). `allowRequest` refuses the handshake outright when a browser
// says it came from any other page — and, unlike `cors`, it also covers the WebSocket upgrade, which
// browsers do not hold to the same-origin rules. No Origin header at all = not a browser (scripts,
// the native app's HTTP layer): allowed here, and still has to pass the session check below.
const socketTrusted = trustedOrigins();
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, Boolean(origin) && socketTrusted.has(String(origin).trim().replace(/\/+$/, '').toLowerCase())),
    credentials: true
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (origin === undefined) return callback(null, true);
    if (originAllowed(origin, req.headers.host, socketTrusted)) return callback(null, true);
    console.warn(`[security] refused live-socket handshake from origin ${origin}`);
    return callback('origin not allowed', false);
  },
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
  if (!socketAllowed(token)) return next(new Error('unauthorized'));
  const { sess } = liveSession(token);
  socket.data.user = { id: sess.user_id, username: sess.username };
  socket.data.token = token;
  return next();
});

// The live feed carries the same data as the API, so it follows the same session rules: expired,
// idle, revoked, or a second factor not passed — and someone who still has to enrol gets no feed.
function socketAllowed(token) {
  const { sess } = liveSession(token);
  if (!sess) return false;
  if (!sess.mfa_enabled && require('./lib/mfa').requiredByRoles(rolesForUser(sess.user_id))) return false;
  return true;
}

// A socket is checked when it connects — and that used to be the only time. Signing someone out,
// resetting their password or deactivating them left their open socket receiving every live update
// until they happened to reconnect. So every connected socket is re-checked: at once when sessions
// change, and every minute (which also catches sessions that simply ran out).
function sweepSockets() {
  for (const [, socket] of io.of('/').sockets) {
    if (!socket.data || !socket.data.token || !socketAllowed(socket.data.token)) socket.disconnect(true);
  }
}
emitter.on('sessions_changed', () => setImmediate(sweepSockets));
setInterval(sweepSockets, 60 * 1000).unref();

const LIVE_EVENTS = ['stock_updated', 'oil_updated', 'filter_updated', 'job_updated', 'request_updated', 'dashboard_refresh', 'data_changed', 'maintenance_alert'];
for (const event of LIVE_EVENTS) {
  emitter.on(event, (data) => io.emit(event, data));
}
io.on('connection', (socket) => {
  socket.emit('live_hello', { ok: true, at: new Date().toISOString() });
  if (activeMaintenance && Date.now() < activeMaintenance.expiresAt) {
    socket.emit('maintenance_alert', {
      ...activeMaintenance,
      seconds: Math.max(0, Math.round((activeMaintenance.expiresAt - Date.now()) / 1000))
    });
  }
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
  // Why did it stop? Starts, stops and crashes go to logs/workshopone-crash.log; a crash exits with
  // code 1 instead of carrying on half-broken (src/lib/lifecycle.js).
  const lifecycle = require('./lib/lifecycle').install({
    file: config.crashLog,
    onStop: () => require('./db').db.close(),
  });

  // A PORT SOMETHING ELSE ALREADY HOLDS is the startup failure an office PC actually hits, and as
  // an uncaught exception it reads as a stack trace about a socket. On the office PC another
  // server has port 3000, so the app died on startup the moment start_server.bat was
  // double-clicked — and with no server there, the symptom reported was "nobody can sign in".
  // Name the port and say where to change it; the crash log gets the same line.
  httpServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(lifecycle.write(`CRASHED — port ${config.port} is already in use, so the server could not start`));
      console.error(`  ** Another program is already listening on port ${config.port}. **`);
      console.error('  ** Set PORT in .env to a free port (the office copy uses 1929), or stop that program. **');
      console.error(`  ** To see what is holding it:  netstat -ano | findstr :${config.port}  **`);
      process.exit(1);
    }
    throw err; // anything else is a real fault: let it crash and be logged in full
  });
  startScheduler();
  // Freeze the day's Pending Parts and Maintenance Summery, hourly, so the record keeps itself.
  dailyReports.startScheduler();
  // Periodic statutory compliance checks, reminder logs, and future version promotion.
  vehicleDocuments.startScheduler();
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
