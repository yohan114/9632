'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (avoids an extra dependency). Only sets vars not already
// present in the real environment, so container/CI env always wins.
function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env file — fall back to defaults below */
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const config = {
  root: ROOT,
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0', // bind all interfaces so the LAN can reach it
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/workshopone.db'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  sessionTtlHours: int('SESSION_TTL_HOURS', 12),
  uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads'),
  backupDir: path.resolve(ROOT, process.env.BACKUP_DIR || './backups'),
  // Optional second location (external drive / network share) mirrored on each snapshot.
  backupMirrorDir: process.env.BACKUP_MIRROR_DIR ? path.resolve(ROOT, process.env.BACKUP_MIRROR_DIR) : null,
  backupIntervalMinutes: int('BACKUP_INTERVAL_MINUTES', 30),
  backupRetention: int('BACKUP_RETENTION', 96),
  forecastWindowDays: int('FORECAST_WINDOW_DAYS', 90),
  lowStockDays: int('LOW_STOCK_DAYS', 14),
  // Anomaly thresholds — BUSINESS CALLS. Defaults are sensible starting points;
  // the owner should tune them (see Phase 5 §1).
  anomalyConsumptionFactor: num('ANOMALY_CONSUMPTION_FACTOR', 2.5), // recent rate > N× the asset's own baseline
  anomalyPriceSpikeFactor: num('ANOMALY_PRICE_SPIKE_FACTOR', 1.5), // GRN price > N× the item's recent average
  isProduction: process.env.NODE_ENV === 'production',

  // The Service Planner (the fuel system). It knows what each machine has actually RUN —
  // meter growth and fuel-derived hours/km — which is the only honest basis for "due for
  // service"; WorkshopOne holds no meter or fuel data of its own. Left unset, the Service &
  // Filter Plan falls back to its own date estimate and says so on screen.
  servicePlannerUrl: process.env.SERVICE_PLANNER_URL || 'http://localhost:3300',
  servicePlannerToken: process.env.SERVICE_PLANNER_TOKEN || '',
};

function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

module.exports = config;
