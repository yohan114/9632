'use strict';

// The two sheets the office kept by hand, now built from the system:
//
//   Pending Parts    — one sheet per purchase source per day ("14HP", "14LP"), columns
//                      NO | Date | MR No | Vehicle no | Description | Unit | Qty | Site | Remarks,
//                      grouped so a multi-item request shows its number once and the rest of its
//                      items underneath, exactly as the workbook did.
//   Maintenance      — "Maintenance Summery- Workshop", one sheet per day, columns
//   Summery            No | Machine No | Type | Site | Start date | Completed Repairs |
//                      Pending Repairs | Overall Job status | Spare parts.
//   Pending Price    — receipts that arrived without a price, same HP/LP split, with the price
//                      column left empty for the office to fill.
//
// On the Summery, three columns start from what the system knows — Completed Repairs from the
// mechanics' daily work, Spare parts from what was requested and has not arrived, and Pending
// Repairs deliberately blank because what is still outstanding is a judgement, not the job title.
// Anything the supervisor types wins and carries forward, held in job_summary_notes.

const { get, all, run } = require('../db');

const d10 = (v) => String(v || '').slice(0, 10);
/** The office writes dates as 14.08.2026. */
const dotDate = (v) => {
  const s = d10(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (s || '');
};
// Their sheet tab names: day number + HP / LP.
const SOURCE_TABS = { head_office: 'HP', local_purchase: 'LP', unassigned: 'NA' };
const SOURCE_LABEL = { head_office: 'Head Office', local_purchase: 'Local Purchase', unassigned: 'Source not set' };

// Two descriptions name the same item if they match once case, spacing and stray punctuation
// are set aside — "Fuel Filter (FC-707A)" and "Fuel Filter FC-707A" are one item typed twice.
// Three things deliberately survive, because each of them names a DIFFERENT part:
//   digits    — "Cabin Fan (24V)" is not "Cabin Fan (12V)"
//   + and -   — "Battery terminal Pole type (+)" is not the same terminal as "(-)"
// A hyphen or slash sitting between two characters is part-number punctuation and goes, so
// FC-707A and FC707A still meet; one standing alone is a polarity mark and stays.
const itemKey = (s) => String(s || '').toLowerCase()
  .replace(/([a-z0-9])[-/]([a-z0-9])/g, '$1$2')
  .replace(/[^a-z0-9+-]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');
/** Quantities read as "4" and "0.5", never "4.00". */
const num2 = (v) => String(Math.round(Number(v || 0) * 100) / 100);

/**
 * Everything still on order, grouped by request, split by purchase source.
 * `asOf` bounds the request date so a past day can be rebuilt as it stood.
 */
function pendingParts({ asOf } = {}) {
  const cutoff = d10(asOf) || d10(new Date().toISOString());
  const rows = all(`
    SELECT ml.id AS line_id, m.id AS mrn_id, m.mrn_no, date(m.req_date) AS req_date,
           ml.description, COALESCE(ml.unit,'nos') AS unit,
           ROUND(ml.qty - COALESCE(ml.qty_received,0), 2) AS qty,
           ml.qty AS qty_ordered, COALESCE(ml.qty_received,0) AS qty_received,
           COALESCE(ml.purchase_source, m.purchase_source) AS source,
           COALESCE(a.registration, a.code, '') AS vehicle,
           COALESCE(j.site, p.name, '') AS site,
           COALESCE(n.remarks, '') AS remarks
      FROM mrn_lines ml
      JOIN mrn m            ON m.id = ml.mrn_id
      LEFT JOIN assets a    ON a.id = m.asset_id
      LEFT JOIN job_cards j ON j.id = m.job_id
      LEFT JOIN projects p  ON p.id = j.project_id
      LEFT JOIN pending_part_notes n ON n.mrn_line_id = ml.id
     WHERE COALESCE(ml.qty_received,0) < ml.qty
       AND date(m.req_date) <= date(?)
     ORDER BY COALESCE(ml.purchase_source, m.purchase_source), date(m.req_date), m.mrn_no, ml.id`, cutoff);

  const gkey = (r) => [r.mrn_id, r.source || '', r.unit, itemKey(r.description)].join('§');

  // Ten lines of "Speedo Meter (km)" qty 1 on one request is ONE item, qty 10 — which is how
  // the office writes it by hand and how it should read back. The merge is bounded to a
  // single request on purpose: the same item on two requests is two separate requisitions of
  // different ages, and folding those together would hide how long one has been waiting.
  //
  // A remark belongs to the ITEM on the request, not to one of the lines it was typed on.
  // The row carries the lowest still-outstanding line as its id, which is the row a remark is
  // written to and read back from — so the round trip closes. Anchoring on a line that is
  // already delivered would put the remark somewhere this report never looks again.
  const collapse = (list) => {
    const seen = new Map();
    const out = [];
    for (const r of list) {
      const key = gkey(r);
      const g = seen.get(key);
      if (!g) {
        seen.set(key, { ...r, line_ids: [r.line_id], remark_set: r.remarks ? [r.remarks] : [], merged: 1 });
        out.push(seen.get(key));
      } else {
        g.qty = Math.round((g.qty + r.qty) * 100) / 100;
        g.qty_ordered += r.qty_ordered;
        g.qty_received += r.qty_received;
        g.line_ids.push(r.line_id);
        g.merged += 1;
        if (r.line_id < g.line_id) g.line_id = r.line_id;
        // Merge remarks, never drop one. Two distinct remarks under one item can only happen
        // if lines were annotated before they merged, so they are joined rather than lost.
        if (r.remarks && !g.remark_set.includes(r.remarks)) g.remark_set.push(r.remarks);
      }
    }
    for (const g of out) g.remarks = g.remark_set.join(' / ');
    return out;
  };

  const groups = { head_office: [], local_purchase: [], unassigned: [] };
  for (const r of collapse(rows)) {
    const key = groups[r.source] ? r.source : 'unassigned';
    groups[key].push(r);
  }

  // Number each REQUEST once; its extra items sit underneath with the leading columns blank.
  const shape = (list) => {
    const out = [];
    let no = 0; let lastMrn = null;
    for (const r of list) {
      const first = r.mrn_no !== lastMrn;
      if (first) { no++; lastMrn = r.mrn_no; }
      out.push({
        no: first ? no : '',
        date: first ? dotDate(r.req_date) : '',
        mrn_no: first ? (r.mrn_no || '') : '',
        vehicle: first ? r.vehicle : '',
        description: r.description || '',
        unit: r.unit,
        qty: r.qty,
        site: first ? r.site : '',
        remarks: r.remarks,
        // What the system knows, kept apart from what a person typed — the Remarks box is
        // saved back verbatim, so anything generated must never be inside it.
        // Only ever says something the row itself cannot. A single line's Qty column already
        // reads as what is outstanding; it is the MERGED rows where a summed quantity would
        // otherwise hide that part of the order has already arrived.
        note: [
          r.merged > 1 ? `${r.merged} lines on this request` : '',
          r.merged > 1 && r.qty_received > 0 ? `${num2(r.qty)} of ${num2(r.qty_ordered)} still to come` : '',
          r.req_date < '2015-01-01' ? '(request date looks wrong)' : '',
        ].filter(Boolean).join(' · '),
        line_id: r.line_id,
        line_ids: r.line_ids,
      });
    }
    return out;
  };

  return {
    as_of: cutoff,
    sections: Object.entries(groups)
      .filter(([, list]) => list.length)
      .map(([source, list]) => ({
        source, tab: SOURCE_TABS[source], label: SOURCE_LABEL[source],
        requests: new Set(list.map((r) => r.mrn_no)).size,
        rows: shape(list),
      })),
  };
}

/**
 * The jobs the workshop is attending, with the supervisor's running notes.
 * A job appears while it is open; the notes persist against the job itself.
 */
function jobSummary({ asOf, activeDays = 30 } = {}) {
  const day = d10(asOf) || d10(new Date().toISOString());
  const win = Number(activeDays) > 0 ? Number(activeDays) : 30;
  // "Attended" is the handful of machines actually in the workshop, not every card left open —
  // 229 cards are open but only ~36 have been worked on in the last month, which is the size the
  // hand-kept sheet ran to. A job the supervisor has written notes against stays on the list too,
  // so one being chased without a mechanic on it today does not silently drop off.
  const rows = all(`
    SELECT j.id, j.job_no, j.description, date(j.requested_at) AS start_date, j.asset_id,
           COALESCE(a.registration, a.code, '') AS machine,
           COALESCE(NULLIF(TRIM(COALESCE(a.brand,'') || ' ' || COALESCE(a.type,'')), ''), a.asset_class, '') AS type,
           COALESCE(NULLIF(j.site,''), NULLIF(p.name,''), NULLIF(ap.name,''), '') AS site,
           COALESCE(n.completed_repairs,'') AS completed_repairs,
           COALESCE(n.pending_repairs,'')   AS pending_repairs,
           COALESCE(n.job_status,'')        AS job_status,
           COALESCE(n.spare_parts,'')       AS spare_parts,
           n.updated_at AS notes_updated_at,
           (SELECT MAX(date(w.work_date)) FROM job_daily_work w WHERE w.job_id = j.id) AS last_worked
      FROM job_cards j
      LEFT JOIN assets a   ON a.id = j.asset_id
      LEFT JOIN projects p ON p.id = j.project_id
      LEFT JOIN projects ap ON ap.id = COALESCE(a.current_project_id, a.home_project_id)
      LEFT JOIN job_summary_notes n ON n.job_id = j.id
     WHERE j.status NOT IN ('CLOSED','REJECTED')
       AND j.asset_id IS NOT NULL
       AND date(COALESCE(j.requested_at, j.created_at)) <= date(?)
       AND (
         n.job_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM job_daily_work w
                     WHERE w.job_id = j.id
                       AND date(w.work_date) <= date(?)
                       AND date(w.work_date) >= date(?, '-' || ? || ' day'))
       )
     ORDER BY date(j.requested_at) DESC, j.id DESC`, day, day, day, win);

  // What was actually DONE on the job — the mechanics' own daily-work descriptions, newest first
  // and de-duplicated (the same task written on three consecutive days is one line of work, not
  // three). Bounded by the report day so an earlier day's sheet does not show later work.
  const workDone = (jobId) => {
    const seen = new Set();
    const out = [];
    for (const w of all(
      `SELECT description FROM job_daily_work
        WHERE job_id = ? AND COALESCE(description,'') <> '' AND date(work_date) <= date(?)
        ORDER BY date(work_date) DESC, id DESC`, jobId, day)) {
      const text = String(w.description).trim();
      const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out.join(', ');
  };

  // Parts asked for that have NOT turned up — this is what the machine is waiting on. Found
  // through the MRN's job link AND through job_parts, because only some requests carry the
  // former; going by one alone misses parts the workshop is genuinely chasing.
  const awaitedParts = (jobId) => {
    const rows2 = all(
      `SELECT DISTINCT ml.id, ml.description,
              ROUND(ml.qty - COALESCE(ml.qty_received,0), 2) AS short, ml.unit, m.mrn_no
         FROM mrn_lines ml
         JOIN mrn m ON m.id = ml.mrn_id
        WHERE COALESCE(ml.qty_received,0) < ml.qty
          AND date(m.req_date) <= date(?)
          AND (m.job_id = ?
               OR ml.id IN (SELECT jp.mrn_line_id FROM job_parts jp
                             WHERE jp.job_id = ? AND jp.mrn_line_id IS NOT NULL))
        ORDER BY m.req_date DESC, ml.id`, day, jobId, jobId);
    return rows2
      .map((p) => `${String(p.description || '').trim()}${p.short > 1 ? ` x${p.short}` : ''} (MRN ${p.mrn_no || '-'})`)
      .join('; ');
  };

  // Fold several cards' text into one cell without repeating a clause — the same task carried
  // on both of a machine's cards is one line of work, not two. Same stripped-key rule workDone
  // uses, so the two behave alike.
  const mergeText = (parts, sep) => {
    const split = sep === '; ' ? /\s*;\s*/ : /\s*,\s*/;
    const seen = new Set();
    const out = [];
    for (const piece of parts.flatMap((p) => String(p || '').split(split))) {
      const text = piece.trim();
      const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out.join(sep);
  };

  // ONE ROW PER MACHINE. A machine carrying two cards left open would otherwise print twice,
  // and that is the one thing the hand-kept sheet never does — there the Machine No IS the row
  // identity and there is no job-number column at all. Rows arrive newest card first, so the
  // first of each group leads; its notes are the ones an edit writes back to.
  const byMachine = new Map();
  for (const r of rows) {
    const k = r.asset_id;
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k).push(r);
  }
  // Which of a machine's cards leads the row — i.e. where a typed note is saved. By JOB NUMBER,
  // not requested_at: a quarter of the open cards carry the bulk-import timestamp rather than
  // the day they were raised, so requested_at picks the wrong card on machines where it matters.
  // Rows stay in their original order on the sheet; this only decides the lead.
  const seq = (no) => {
    const m = String(no || '').match(/^(\d+)\/(\d+)\/[A-Z]+\/0*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  };
  const newestFirst = (a, b) => {
    const x = seq(a.job_no); const y = seq(b.job_no);
    return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]) || (b.id - a.id);
  };
  for (const cards of byMachine.values()) cards.sort(newestFirst);
  const latest = (vals) => vals.filter(Boolean).sort().pop() || null;

  return {
    as_of: day,
    rows: [...byMachine.values()].map((cards, i) => {
      const lead = cards[0];
      const one = cards.length === 1;
      // An edit writes to the lead card, so once the lead has a record of its own that record
      // IS the row — otherwise deleting a word would just bring back the older card's copy of
      // it on the next render, and nothing could ever be removed. Until then the older card's
      // notes still show, so raising a new card never blanks what someone wrote.
      const own = lead.notes_updated_at != null;
      const typed = (f) => (one || own ? lead[f] : mergeText(cards.map((c) => c[f]), ', '));
      // Derived text always spans every card — work done on the older card is still work done
      // on this machine.
      const derived = (fn, sep) => (one ? fn(lead.id) : mergeText(cards.map((c) => fn(c.id)), sep));
      return {
        no: i + 1,
        machine: lead.machine,
        type: lead.type,
        site: lead.site,
        // The oldest card's date. The office keeps the date the machine came in and never
        // advances it, even when a second card is raised against the same machine later.
        start_date: dotDate(cards.map((c) => c.start_date).filter(Boolean).sort()[0] || lead.start_date),
        // What the card was raised for, in its own column — it is the job's title, which is a
        // different thing from what has been done or what is still outstanding.
        job_description: one ? (lead.description || '') : mergeText(cards.map((c) => c.description), ', '),
        // Each column falls back to what the system knows, and anything typed by the supervisor
        // wins — their words are the record, the derived text is just a head start.
        completed_repairs: typed('completed_repairs') || derived(workDone, ', '),
        // Deliberately blank: what is still outstanding is a judgement, not the job's title.
        pending_repairs: typed('pending_repairs'),
        job_status: typed('job_status'),
        spare_parts: typed('spare_parts') || derived(awaitedParts, '; '),
        job_id: lead.id, job_no: lead.job_no,
        // Every card behind the row, so an edit knows what it is speaking for and nothing
        // becomes unreachable just because it is no longer the row's identity.
        cards: cards.length,
        job_ids: cards.map((c) => c.id),
        job_nos: cards.map((c) => c.job_no),
        last_worked: latest(cards.map((c) => c.last_worked)),
        notes_updated_at: latest(cards.map((c) => c.notes_updated_at)),
      };
    }),
  };
}


/**
 * Goods that arrived but carry no price yet, split by who bought them.
 *
 * This is the money the workshop has taken in but cannot yet charge to a vehicle: every one of
 * these lines is a job cost sitting at zero until the invoice is entered. Unlike the pending-parts
 * sheet the source is well recorded here, because it is set on the receipt itself.
 */
function pendingPrice({ asOf } = {}) {
  const cutoff = d10(asOf) || d10(new Date().toISOString());
  const rows = all(`
    SELECT g.id AS grn_id, g.grn_no, date(g.delivery_date) AS recv_date, g.qty,
           g.supplier, g.invoice_no, date(g.invoice_date) AS invoice_date,
           m.mrn_no, date(m.req_date) AS req_date,
           COALESCE(ml.description, g.description, '') AS description,
           COALESCE(ml.unit, 'nos') AS unit,
           COALESCE(g.purchase_source_norm, m.purchase_source, ml.purchase_source) AS source,
           COALESCE(a.registration, a.code, '') AS vehicle,
           COALESCE(NULLIF(j.site,''), NULLIF(p.name,''), '') AS site,
           COALESCE(n.remarks, '') AS remarks
      FROM grn g
      LEFT JOIN mrn_lines ml ON ml.id = g.mrn_line_id
      LEFT JOIN mrn m        ON m.id  = COALESCE(g.mrn_id, ml.mrn_id)
      LEFT JOIN assets a     ON a.id  = m.asset_id
      LEFT JOIN job_cards j  ON j.id  = m.job_id
      LEFT JOIN projects p   ON p.id  = j.project_id
      LEFT JOIN receipt_price_notes n ON n.grn_id = g.id
     WHERE g.unit_price IS NULL
       AND date(COALESCE(g.delivery_date, g.created_at)) <= date(?)
     ORDER BY COALESCE(g.purchase_source_norm, m.purchase_source, ml.purchase_source),
              date(g.delivery_date) DESC, g.id`, cutoff);

  const groups = { head_office: [], local_purchase: [], unassigned: [] };
  for (const r of rows) groups[groups[r.source] ? r.source : 'unassigned'].push(r);

  // One number per REQUEST, the way the pending-parts sheet reads — that is the number the
  // storekeeper is chasing. Grouping by delivery note instead put two unrelated requests under
  // one number whenever a receipt had no GRN number of its own.
  const blockKey = (r) => r.mrn_no || ('grn:' + (r.grn_no || r.grn_id));

  // A request's goods can arrive on several different days, and the numbering below starts a
  // new number every time the key changes from the previous row — so unless a request's rows
  // sit together, the same MR number gets numbered again further down the sheet. Sorting by
  // delivery date alone scatters them. Order the requests by their most recent delivery so the
  // sheet still reads newest-first, then keep each request's own rows together underneath.
  const order = (list) => {
    const newest = new Map();
    for (const r of list) {
      const k = blockKey(r);
      const d = r.recv_date || '';
      if (!newest.has(k) || d > newest.get(k)) newest.set(k, d);
    }
    const desc = (a, b) => (a === b ? 0 : (a < b ? 1 : -1));
    return list.slice().sort((a, b) => {
      const ka = blockKey(a); const kb = blockKey(b);
      if (ka !== kb) return desc(newest.get(ka) || '', newest.get(kb) || '') || (ka < kb ? -1 : 1);
      return desc(a.recv_date || '', b.recv_date || '') || (a.grn_id - b.grn_id);
    });
  };

  const shape = (list) => {
    const out = [];
    let no = 0; let lastKey = null;
    for (const r of list) {
      const key = blockKey(r);
      const first = key !== lastKey;
      if (first) { no++; lastKey = key; }
      out.push({
        no: first ? no : '',
        recv_date: dotDate(r.recv_date),
        grn_no: r.grn_no || '',
        mrn_no: first ? (r.mrn_no || '') : '',
        vehicle: first ? r.vehicle : '',
        description: r.description,
        unit: r.unit,
        qty: r.qty,
        supplier: first ? (r.supplier || '') : '',
        invoice_no: r.invoice_no || '',
        site: r.site,
        remarks: r.remarks,
        grn_id: r.grn_id,
      });
    }
    return out;
  };

  return {
    as_of: cutoff,
    sections: Object.entries(groups)
      .filter(([, list]) => list.length)
      .map(([source, list]) => ({
        source, tab: SOURCE_TABS[source], label: SOURCE_LABEL[source],
        // Count what the NO column actually numbers. Counting delivery notes instead made the
        // header claim one request per row, because an unpriced receipt rarely has a GRN number
        // yet and every row then fell back to its own id.
        requests: new Set(list.map(blockKey)).size,
        rows: shape(order(list)),
      })),
  };
}

const BUILDERS = { pending_parts: pendingParts, job_summary: jobSummary, pending_price: pendingPrice };

/** Build a report for a day, live from the system. */
function build(kind, opts) {
  const fn = BUILDERS[kind];
  if (!fn) throw new Error(`Unknown report: ${kind}`);
  return fn(opts || {});
}

/** Freeze today's copy. Re-running on the same day replaces it, so it always holds the latest. */
function snapshot(kind, { asOf, userId } = {}) {
  const data = build(kind, { asOf });
  const date = data.as_of;
  // Count by shape, not by name — a sectioned report has no top-level rows, and naming one kind
  // explicitly meant the next sectioned report added threw here, silently, inside the scheduler.
  const count = Array.isArray(data.sections)
    ? data.sections.reduce((s, x) => s + x.rows.length, 0)
    : (data.rows || []).length;
  run(
    `INSERT INTO daily_report_snapshots (kind, report_date, generated_by, row_count, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, report_date) DO UPDATE SET
       generated_at = datetime('now'), generated_by = excluded.generated_by,
       row_count = excluded.row_count, payload = excluded.payload`,
    kind, date, userId || null, count, JSON.stringify(data));
  return get('SELECT id, kind, report_date, generated_at, row_count FROM daily_report_snapshots WHERE kind = ? AND report_date = ?', kind, date);
}

/** A saved day, or null. */
function readSnapshot(kind, date) {
  const row = get('SELECT * FROM daily_report_snapshots WHERE kind = ? AND report_date = ?', kind, d10(date));
  if (!row) return null;
  return { ...row, data: JSON.parse(row.payload) };
}

function history(kind, limit = 60) {
  return all(
    `SELECT s.id, s.kind, s.report_date, s.generated_at, s.row_count, u.username AS generated_by_name
       FROM daily_report_snapshots s LEFT JOIN users u ON u.id = s.generated_by
      WHERE s.kind = ? ORDER BY s.report_date DESC LIMIT ?`, kind, Number(limit) || 60);
}

module.exports = { build, snapshot, readSnapshot, history, pendingParts, jobSummary, pendingPrice, dotDate, SOURCE_TABS, SOURCE_LABEL };

// ---------------------------------------------------------------------------
// Excel, laid out to match the workbook the office already reads.
// ---------------------------------------------------------------------------
const ExcelJS = require('exceljs');

const THIN = { style: 'thin', color: { argb: 'FF999999' } };
const box = (c) => { c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; };
const head = (c) => {
  c.font = { bold: true, size: 10 };
  c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  box(c);
};

/** Pending Parts — one worksheet per source, named <day><HP|LP> like the original. */
function pendingPartsWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  const day = String(Number(data.as_of.slice(8, 10)));
  const COLS = [
    ['NO', 6], ['Date', 12], ['MR No', 11], ['Vehicle no', 14], ['Description', 40],
    ['Unit', 7], ['Qty', 7], ['Site', 16], ['Remarks', 26],
  ];
  for (const sec of data.sections) {
    const ws = wb.addWorksheet(day + sec.tab);
    COLS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
    COLS.forEach(([t], i) => { const c = ws.getCell(1, i + 1); c.value = t; head(c); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    sec.rows.forEach((r, n) => {
      // On paper the typed remark and the system's own note share one column; on screen they
      // are kept apart so the editable box only ever holds what a person wrote.
      const vals = [r.no, r.date, r.mrn_no, r.vehicle, r.description, r.unit, r.qty, r.site,
        [r.remarks, r.note].filter(Boolean).join(' · ')];
      vals.forEach((v, i) => {
        const c = ws.getCell(n + 2, i + 1);
        c.value = v === '' ? null : v;
        c.font = { size: 10 };
        c.alignment = { vertical: 'top', wrapText: i === 4 || i === 8 };
        if (i === 6) c.alignment = { horizontal: 'right' };
        box(c);
      });
    });
  }
  if (!data.sections.length) wb.addWorksheet(day + 'HP').getCell(1, 1).value = 'Nothing outstanding.';
  return wb;
}

/** Maintenance Summery — one worksheet per day, named after the day number. */
function jobSummaryWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  const ws = wb.addWorksheet(String(Number(data.as_of.slice(8, 10))));
  const COLS = [
    ['No', 5], ['Machine No', 13], ['Type', 22], ['Site', 16], ['Start date', 12],
    ['Job Card Description', 32], ['Completed Repairs', 32], ['Pending Repairs', 30],
    ['Overall Job  status', 18], ['Spare parts', 24],
  ];
  COLS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });

  ws.mergeCells(1, 1, 1, COLS.length);
  const t = ws.getCell(1, 1);
  t.value = 'Maintenance Summery-  Workshop';
  t.font = { bold: true, size: 13 };
  t.alignment = { horizontal: 'center' };

  ws.mergeCells(2, 1, 2, COLS.length);
  const d = ws.getCell(2, 1);
  d.value = `Date - ${dotDate(data.as_of).replace(/\./g, '/')}`;
  d.font = { bold: true, size: 11 };
  d.alignment = { horizontal: 'center' };

  ws.mergeCells(3, 1, 3, COLS.length);
  const s = ws.getCell(3, 1);
  s.value = 'Attended Jobs';
  s.font = { bold: true, size: 11 };
  s.alignment = { horizontal: 'center' };

  COLS.forEach(([label], i) => { const c = ws.getCell(4, i + 1); c.value = label; head(c); });
  ws.views = [{ state: 'frozen', ySplit: 4 }];

  data.rows.forEach((r, n) => {
    const vals = [r.no, r.machine, r.type, r.site, r.start_date,
      r.job_description, r.completed_repairs, r.pending_repairs, r.job_status, r.spare_parts];
    vals.forEach((v, i) => {
      const c = ws.getCell(n + 5, i + 1);
      c.value = v === '' ? null : v;
      c.font = { size: 10 };
      c.alignment = { vertical: 'top', wrapText: i >= 5 };
      box(c);
    });
  });
  return wb;
}

/** Pending Price — one worksheet per source, laid out like the Pending Parts sheet with the
 *  invoice columns the office needs in order to price the line. */
function pendingPriceWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  const day = String(Number(data.as_of.slice(8, 10)));
  const COLS = [
    ['NO', 6], ['Received', 12], ['GRN No', 11], ['MR No', 11], ['Vehicle no', 14],
    ['Description', 38], ['Unit', 7], ['Qty', 7], ['Supplier', 20], ['Invoice No', 13],
    ['Unit Price', 12], ['Site', 15], ['Remarks', 22],
  ];
  for (const sec of data.sections) {
    const ws = wb.addWorksheet(day + sec.tab);
    COLS.forEach(([, w], i) => { ws.getColumn(i + 1).width = w; });
    COLS.forEach(([t], i) => { const c = ws.getCell(1, i + 1); c.value = t; head(c); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    sec.rows.forEach((r, n) => {
      // Unit Price is left empty on purpose — this is the column the office fills in.
      const vals = [r.no, r.recv_date, r.grn_no, r.mrn_no, r.vehicle, r.description,
        r.unit, r.qty, r.supplier, r.invoice_no, null, r.site, r.remarks];
      vals.forEach((v, i) => {
        const c = ws.getCell(n + 2, i + 1);
        c.value = v === '' ? null : v;
        c.font = { size: 10 };
        c.alignment = { vertical: 'top', wrapText: i === 5 || i === 12 };
        if (i === 7 || i === 10) c.alignment = { horizontal: 'right' };
        if (i === 10) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
        box(c);
      });
    });
  }
  if (!data.sections.length) wb.addWorksheet(day + 'HP').getCell(1, 1).value = 'Everything received has a price.';
  return wb;
}

const WORKBOOKS = { pending_parts: pendingPartsWorkbook, job_summary: jobSummaryWorkbook, pending_price: pendingPriceWorkbook };
const workbookFor = (kind, data) => WORKBOOKS[kind](data);

module.exports.pendingPartsWorkbook = pendingPartsWorkbook;
module.exports.jobSummaryWorkbook = jobSummaryWorkbook;
module.exports.pendingPriceWorkbook = pendingPriceWorkbook;
module.exports.workbookFor = workbookFor;

/**
 * Keep today's copy current without anyone remembering to press a button.
 *
 * Runs hourly and re-freezes today, so the saved sheet always reflects the latest state; the
 * moment the date rolls over, yesterday's copy is left exactly as it stood at its last run.
 * Also fills any day the server was off for, so a weekend or a power cut does not leave a hole
 * in the record.
 */
function startScheduler({ everyMinutes = 60 } = {}) {
  // Off wherever the backup scheduler is off — that is the existing "this is not a live
  // deployment" switch, and a test server has no business freezing daily reports (it also made
  // the suite flaky, several servers all writing snapshots the moment they started).
  if (!require('../config').backupIntervalMinutes) return null;
  const tick = () => {
    try {
      for (const kind of Object.keys(BUILDERS)) {
        const today = d10(new Date().toISOString());
        snapshot(kind, { asOf: today });
        // Backfill: if the last saved day is older than yesterday, the server was down. Freeze
        // the missing days from the data as it stands now — better a late record than none.
        const last = get('SELECT report_date FROM daily_report_snapshots WHERE kind = ? ORDER BY report_date DESC LIMIT 1 OFFSET 1', kind);
        if (last) {
          const from = new Date(last.report_date + 'T00:00:00Z');
          const to = new Date(today + 'T00:00:00Z');
          for (let t = from.getTime() + 86400000; t < to.getTime(); t += 86400000) {
            const day = new Date(t).toISOString().slice(0, 10);
            if (!get('SELECT 1 v FROM daily_report_snapshots WHERE kind = ? AND report_date = ?', kind, day)) {
              snapshot(kind, { asOf: day });
            }
          }
        }
      }
    } catch (e) {
      // Never take the server down for a report — but do not swallow it either: a silent
      // catch here hid a crash that stopped one report being saved at all.
      console.error('[daily-reports] snapshot failed:', e.message);
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(5, everyMinutes) * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports.startScheduler = startScheduler;
