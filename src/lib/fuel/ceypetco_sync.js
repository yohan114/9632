'use strict';

/**
 * Automatic Ceypetco (Ceylon Petroleum Corporation) Official Fuel Price Sync
 *
 * Fetches official published retail tariffs from Ceypetco (primary JSON active
 * endpoint, historical JSON fallback, and legacy HTML table fallback), maps
 * product names cleanly onto WorkshopOne fuel codes, and upserts date-effective
 * rows into `fuel_prices` without disturbing manual overrides or back-dated
 * unchanged rows.
 */

const config = require('../../config');
const { get, run, tx } = require('../../db');
const audit = require('../audit');

const CEYPETCO_ACTIVE_API_URL = 'https://api.ceypetco.gov.lk/api/admin/fuel-prices/active?limit=100';
const CEYPETCO_HISTORICAL_API_URL = 'https://api.ceypetco.gov.lk/api/admin/historical-prices/active';
const CEYPETCO_LEGACY_HTML_URL = 'https://ceypetco.gov.lk/historical-prices/';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Order matters: KEROSENE explicitly rejects Industrial Kerosene ("LIK") so
// Lanka Industrial Kerosene never overwrites retail Lanka Kerosene.
const FUEL_MATCHERS = [
  {
    code: 'AUTO_DIESEL',
    label: 'Auto Diesel',
    match: (text) => /auto\s*diesel|^\s*lad\s*$/i.test(text),
  },
  {
    code: 'SUPER_DIESEL',
    label: 'Super Diesel',
    match: (text) => /super\s*diesel|^\s*lsd\s*$/i.test(text),
  },
  {
    code: 'PETROL_92',
    label: 'Petrol 92',
    match: (text) => /petrol\s*(?:octane\s*)?92|92\s*(?:octane|unl)|^\s*lp\s*92\s*$/i.test(text),
  },
  {
    code: 'PETROL_95',
    label: 'Petrol 95',
    match: (text) => /petrol\s*(?:octane\s*)?95|95\s*(?:octane|unl)|^\s*lp\s*95\s*$/i.test(text),
  },
  {
    code: 'KEROSENE',
    label: 'Kerosene',
    match: (text) => !/industrial/i.test(text) && (/^\s*lk\s*$|kerosene/i.test(text)),
  },
];

// Positional columns in https://ceypetco.gov.lk/historical-prices/ (`kind: "fuel"`):
// ['LP 95', 'LP 92', 'LAD', 'LSD', 'LK', 'LIK', 'FUR. 800', 'FUR 1500 (High)', 'FUR. 1500 (Low)']
const HISTORICAL_FUEL_COLUMNS = ['PETROL_95', 'PETROL_92', 'AUTO_DIESEL', 'SUPER_DIESEL', 'KEROSENE'];

const MATCHER_BY_CODE = Object.fromEntries(FUEL_MATCHERS.map((m) => [m.code, m]));

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

let inFlightPromise = null;
let initialTimer = null;
let pollTimer = null;

function todayColomboStr(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function matchFuelProduct(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  for (const m of FUEL_MATCHERS) {
    if (m.match(name)) return m;
  }
  return null;
}

function parsePriceCents(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  let num;
  if (typeof raw === 'number') {
    num = raw;
  } else {
    const cleaned = String(raw).replace(/,/g, '');
    const m = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    num = parseFloat(m[1]);
  }
  if (!Number.isFinite(num) || num <= 0 || num > 10000) return null;
  return Math.round(num * 100);
}

function buildIsoDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseEffectiveDateStr(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return null;

  // 8-digit sortKey e.g. 20261102
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return buildIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  // ISO / YYYY.MM.DD / YYYY-MM-DDTHH:mm:ssZ
  m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:$|T|\s)/);
  if (m) return buildIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  // dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy
  m = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (m) return buildIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));

  // dd Mon yyyy
  m = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return buildIsoDate(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  }

  // Mon dd, yyyy
  m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return buildIsoDate(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
  }

  return null;
}

function parseCeypetcoActiveApi(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.data) ? payload.data : []);
  const byCode = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.status != null && String(row.status).trim().toLowerCase() !== 'active') continue;

    const productName = String(row.product || row.name || row.fuel_type || row.fuelKind || '').trim();
    const matched = matchFuelProduct(productName);
    if (!matched) continue;

    const priceCents = parsePriceCents(row.price ?? row.pricePerLitre ?? row.price_per_litre);
    if (priceCents == null) continue;

    const effectiveDate = parseEffectiveDateStr(
      row.effectiveDate || row.effective_date || row.effectiveFrom || row.updatedAt || row.createdAt
    );
    const freshness = String(row.updatedAt || row.createdAt || '');

    const prev = byCode.get(matched.code);
    const shouldReplace = !prev
      || (effectiveDate && (!prev.effectiveDate || effectiveDate > prev.effectiveDate))
      || (effectiveDate === prev.effectiveDate && freshness > prev._freshness);

    if (shouldReplace) {
      byCode.set(matched.code, {
        code: matched.code,
        label: matched.label,
        priceCents,
        effectiveDate,
        productName,
        _freshness: freshness,
      });
    }
  }

  const items = Array.from(byCode.values()).map(({ _freshness, ...rest }) => rest);
  return { source: 'api_active', items };
}

function parseCeypetcoHistoricalApi(payload) {
  const rawRows = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.data) ? payload.data : []);
  const fuelRows = rawRows
    .filter((r) => r && String(r.kind || '').trim().toLowerCase() === 'fuel')
    .sort((a, b) => (Number(b.sortKey) || 0) - (Number(a.sortKey) || 0));

  for (const row of fuelRows) {
    if (!Array.isArray(row.values)) continue;
    const effectiveDate = parseEffectiveDateStr(row.dateLabel) || parseEffectiveDateStr(row.sortKey);
    const items = [];
    for (let idx = 0; idx < HISTORICAL_FUEL_COLUMNS.length; idx++) {
      const code = HISTORICAL_FUEL_COLUMNS[idx];
      const matcher = MATCHER_BY_CODE[code];
      const priceCents = parsePriceCents(row.values[idx]);
      if (priceCents != null) {
        items.push({
          code,
          label: matcher ? matcher.label : code,
          priceCents,
          effectiveDate,
          productName: matcher ? matcher.label : code,
        });
      }
    }
    if (items.length >= 2) {
      return { source: 'api_historical', items };
    }
  }

  return { source: 'api_historical', items: [] };
}

function stripHtmlTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlTableRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let tr;
  while ((tr = trRe.exec(String(html || '')))) {
    const cells = [];
    let cell;
    cellRe.lastIndex = 0;
    while ((cell = cellRe.exec(tr[1]))) {
      cells.push(stripHtmlTags(cell[1]));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function parseCeypetcoHtmlPrices(html) {
  const rows = extractHtmlTableRows(html);
  let headerIdx = -1;
  let colOf = {};

  for (let i = 0; i < rows.length; i++) {
    const mapped = {};
    for (const matcher of FUEL_MATCHERS) {
      const col = rows[i].findIndex((cell) => matcher.match(cell));
      if (col >= 0) mapped[matcher.code] = col;
    }
    if (Object.keys(mapped).length >= 2) {
      headerIdx = i;
      colOf = mapped;
      break;
    }
  }

  if (headerIdx < 0) return { source: 'html_table', items: [] };

  const dateCol = rows[headerIdx].findIndex((c) => /date|effective|w\.?e\.?f/i.test(c));

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const effectiveDate = dateCol >= 0 && dateCol < row.length ? parseEffectiveDateStr(row[dateCol]) : null;
    const items = [];
    for (const [code, col] of Object.entries(colOf)) {
      const matcher = MATCHER_BY_CODE[code];
      const priceCents = col < row.length ? parsePriceCents(row[col]) : null;
      if (priceCents != null) {
        items.push({
          code,
          label: matcher ? matcher.label : code,
          priceCents,
          effectiveDate,
          productName: rows[headerIdx][col] || (matcher ? matcher.label : code),
        });
      }
    }
    if (items.length >= 2) {
      return { source: 'html_table', items };
    }
  }

  return { source: 'html_table', items: [] };
}

async function fetchWithTimeout(fetchFn, url, accept, timeoutMs) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: accept,
      Origin: 'https://ceypetco.gov.lk',
      Referer: 'https://ceypetco.gov.lk/',
    },
    signal,
  });
  if (!res || !res.ok) {
    throw new Error(`HTTP ${res ? res.status : 'unknown'}`);
  }
  return res;
}

async function fetchCeypetcoPrices({ fetchImpl, timeoutMs = 15000 } = {}) {
  const fetchFn = fetchImpl || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const sources = [
    {
      name: 'api_active',
      url: CEYPETCO_ACTIVE_API_URL,
      accept: 'application/json',
      parse: async (res) => parseCeypetcoActiveApi(await res.json()),
    },
    {
      name: 'api_historical',
      url: CEYPETCO_HISTORICAL_API_URL,
      accept: 'application/json',
      parse: async (res) => parseCeypetcoHistoricalApi(await res.json()),
    },
    {
      name: 'html_table',
      url: CEYPETCO_LEGACY_HTML_URL,
      accept: 'text/html,application/xhtml+xml',
      parse: async (res) => parseCeypetcoHtmlPrices(await res.text()),
    },
  ];

  const errors = [];
  for (const src of sources) {
    try {
      const res = await fetchWithTimeout(fetchFn, src.url, src.accept, timeoutMs);
      const parsed = await src.parse(res);
      if (parsed && Array.isArray(parsed.items) && parsed.items.length >= 2) {
        return parsed;
      }
      errors.push(`${src.name}: no recognisable fuel prices (${parsed && parsed.items ? parsed.items.length : 0} matched)`);
    } catch (err) {
      errors.push(`${src.name}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  throw new Error(`Ceypetco price fetch failed across all sources: ${errors.join(' | ')}`);
}

function readSetting(key) {
  try {
    const row = get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, value == null ? '' : String(value));
  } catch {
    // Ignore when settings table is not yet initialized
  }
}

function getSyncStatus() {
  return {
    enabled: Boolean(config.ceypetcoSyncEnabled),
    intervalMinutes: Number(config.ceypetcoSyncIntervalMinutes) || 0,
    lastSyncAt: readSetting('ceypetco_last_sync_at') || null,
    lastSyncStatus: readSetting('ceypetco_last_sync_status') || null,
    lastSyncError: readSetting('ceypetco_last_sync_error') || null,
    lastSyncSource: readSetting('ceypetco_last_sync_source') || null,
    lastChangeAt: readSetting('ceypetco_last_change_at') || null,
    inFlight: Boolean(inFlightPromise),
  };
}

function isAutoSource(source) {
  return /^(CEYPETCO_AUTO|Auto-fetched|Historical price from ceypetco)/i.test(String(source || '').trim());
}

async function executeSync({ actorId = null, trigger = 'auto', fetchImpl, timeoutMs } = {}) {
  const nowIso = new Date().toISOString();
  try {
    const fetched = await fetchCeypetcoPrices({ fetchImpl, timeoutMs });
    const stored = [];
    const updated = [];
    const unchanged = [];
    const skippedManual = [];
    const fallbackToday = todayColomboStr();

    tx(() => {
      for (const item of fetched.items) {
        const effDate = item.effectiveDate || fallbackToday;
        const exact = get(`
          SELECT id, price_per_litre_cents, source
            FROM fuel_prices
           WHERE fuel_type = ? AND effective_date = ?
        `, item.code, effDate);

        const latest = get(`
          SELECT id, price_per_litre_cents, effective_date, source
            FROM fuel_prices
           WHERE UPPER(COALESCE(fuel_type, fuel_kind)) = ?
           ORDER BY effective_date DESC, id DESC LIMIT 1
        `, item.code);

        if (exact) {
          const prevCents = Number(exact.price_per_litre_cents);
          if (prevCents === Number(item.priceCents)) {
            unchanged.push({
              code: item.code,
              label: item.label,
              priceCents: item.priceCents,
              effectiveDate: effDate,
            });
          } else if (isAutoSource(exact.source)) {
            run(`
              UPDATE fuel_prices
                 SET fuel_kind = ?,
                     price_per_litre_cents = ?,
                     price_per_litre = ?,
                     source = 'CEYPETCO_AUTO',
                     notes = 'Auto-fetched from ceypetco.gov.lk'
               WHERE id = ?
            `, item.code, item.priceCents, item.priceCents / 100, exact.id);
            updated.push({
              code: item.code,
              label: item.label,
              priceCents: item.priceCents,
              previousCents: prevCents,
              effectiveDate: effDate,
            });
          } else {
            skippedManual.push({
              code: item.code,
              label: item.label,
              priceCents: item.priceCents,
              existingCents: prevCents,
              source: exact.source,
              effectiveDate: effDate,
            });
          }
        } else if (
          latest &&
          String(latest.effective_date || '').slice(0, 10) > effDate &&
          Number(latest.price_per_litre_cents) === Number(item.priceCents)
        ) {
          // Newer row already holds this exact price; avoid redundant back-dated entries.
          unchanged.push({
            code: item.code,
            label: item.label,
            priceCents: item.priceCents,
            effectiveDate: String(latest.effective_date).slice(0, 10),
          });
        } else {
          run(`
            INSERT INTO fuel_prices (
              fuel_type, fuel_kind, price_per_litre_cents, price_per_litre,
              effective_date, notes, source, created_by, entered_by
            ) VALUES (?, ?, ?, ?, ?, 'Auto-fetched from ceypetco.gov.lk', 'CEYPETCO_AUTO', ?, ?)
          `,
          item.code,
          item.code,
          item.priceCents,
          item.priceCents / 100,
          effDate,
          actorId || null,
          actorId ? String(actorId) : 'CEYPETCO_AUTO');

          stored.push({
            code: item.code,
            label: item.label,
            priceCents: item.priceCents,
            effectiveDate: effDate,
          });
        }
      }

      writeSetting('ceypetco_last_sync_at', nowIso);
      writeSetting('ceypetco_last_sync_status', 'ok');
      writeSetting('ceypetco_last_sync_error', '');
      writeSetting('ceypetco_last_sync_source', fetched.source);
      if (stored.length > 0 || updated.length > 0) {
        writeSetting('ceypetco_last_change_at', nowIso);
      }
    });

    const changed = stored.length > 0 || updated.length > 0;
    if (changed) {
      const summaryParts = [
        ...stored.map((s) => `${s.label} Rs ${(s.priceCents / 100).toFixed(2)} (${s.effectiveDate})`),
        ...updated.map((u) => `${u.label} Rs ${(u.priceCents / 100).toFixed(2)} (updated ${u.effectiveDate})`),
      ];
      try {
        audit.record({
          userId: actorId || null,
          entity: 'fuel_price',
          entityId: null,
          action: 'fuel.price.synced',
          after: { trigger, source: fetched.source, stored, updated },
          reason: `Ceypetco price sync (${fetched.source}): ${summaryParts.join(', ')}`,
        });
      } catch (_) {}
    }

    return {
      source: fetched.source,
      fetchedCount: fetched.items.length,
      stored,
      updated,
      unchanged,
      skippedManual,
      changed,
    };
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err).slice(0, 300);
    writeSetting('ceypetco_last_sync_at', nowIso);
    writeSetting('ceypetco_last_sync_status', 'error');
    writeSetting('ceypetco_last_sync_error', errMsg);
    throw err;
  }
}

function syncCeypetcoPrices(options = {}) {
  if (options && options.fetchImpl) {
    return executeSync(options);
  }
  if (inFlightPromise) return inFlightPromise;
  inFlightPromise = executeSync(options).finally(() => {
    inFlightPromise = null;
  });
  return inFlightPromise;
}

async function runScheduledTick() {
  try {
    const res = await syncCeypetcoPrices({ trigger: 'auto' });
    if (res.changed) {
      const summary = [
        ...res.stored.map((s) => `${s.label} Rs ${(s.priceCents / 100).toFixed(2)}`),
        ...res.updated.map((u) => `${u.label} Rs ${(u.priceCents / 100).toFixed(2)}`),
      ].join(', ');
      console.log(`[ceypetco-sync] Updated fuel tariffs from ${res.source}: ${summary}`);
    }
    return res;
  } catch (err) {
    console.error('[ceypetco-sync] sync failed, will retry:', err && err.message ? err.message : err);
    return null;
  }
}

function stopScheduler() {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startScheduler({ initialDelayMs = 5000, intervalMinutes } = {}) {
  stopScheduler();
  if (!config.ceypetcoSyncEnabled) {
    console.log('[ceypetco-sync] Scheduler disabled via CEYPETCO_SYNC_ENABLED');
    return null;
  }
  const rawMinutes = intervalMinutes != null ? Number(intervalMinutes) : Number(config.ceypetcoSyncIntervalMinutes);
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) {
    console.log('[ceypetco-sync] Scheduler disabled (interval <= 0)');
    return null;
  }
  const mins = Math.max(5, Math.round(rawMinutes));
  const intervalMs = mins * 60 * 1000;

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runScheduledTick();
    pollTimer = setInterval(() => {
      void runScheduledTick();
    }, intervalMs);
    if (pollTimer.unref) pollTimer.unref();
  }, Math.max(0, Number(initialDelayMs) || 0));

  if (initialTimer.unref) initialTimer.unref();
  console.log(`[ceypetco-sync] Scheduler started — polling ceypetco.gov.lk every ${mins} min`);
  return { stop: stopScheduler, intervalMinutes: mins };
}

module.exports = {
  CEYPETCO_ACTIVE_API_URL,
  CEYPETCO_HISTORICAL_API_URL,
  CEYPETCO_LEGACY_HTML_URL,
  FUEL_MATCHERS,
  HISTORICAL_FUEL_COLUMNS,
  todayColomboStr,
  parsePriceCents,
  parseEffectiveDateStr,
  parseCeypetcoActiveApi,
  parseCeypetcoHistoricalApi,
  parseCeypetcoHtmlPrices,
  fetchCeypetcoPrices,
  syncCeypetcoPrices,
  getSyncStatus,
  startScheduler,
  stopScheduler,
};
