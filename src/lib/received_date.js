'use strict';

// When an item actually arrived.
//
// WHICH COLUMN. `grn` carries four date-ish columns and only one of them is the day the goods
// physically turned up:
//   delivery_date — the storekeeper's own field on the receiving grid (pre-filled with today),
//                   and the column every importer copies from the source receipt. Filled on
//                   3880 of 3880 rows. THIS is the received date.
//   grn_date      — the date written on the GRN paper. Blank on 3781 of 3880 rows, and where
//                   both exist it disagrees with delivery_date on 18 of 99 — a different fact.
//   invoice_date  — the supplier's own document. Blank on 1519 rows.
//   created_at    — when the ROW was written. On 3270 rows that is the import run of
//                   2026-07-16, not an arrival. Never show it as a received date: the old
//                   COALESCE(delivery_date, created_at) idiom is a silent liar rather than a
//                   safety net, because a null delivery_date would print the build timestamp.
//
// DRIVEN BY RECEIPTS, NOT BY qty_received. mrn_line 6824 ('seat kit', MRN 166898) says four
// were received and has no GRN row at all — a 'seat kit'/'Seal Kit' typo pair where the receipt
// was corrected onto the sibling line. A quantity is not evidence of a date, so that line must
// read "not recorded" rather than borrow one.
//
// PART DELIVERIES. 57 lines were received in more than one drop and 37 of those span different
// days — three of them by 127, 172 and 314 days. A bare MAX would quietly report the last van
// as though it were the whole delivery, so callers get `first_received` and `receipt_days`
// alongside and the UI says when a line arrived in pieces. It counts distinct DAYS, not notes —
// two notes keyed on one day are one delivery — so the wording says "dates", which is what is
// actually being counted.
//
// A RETURN IS NOT AN ARRIVAL. A reversal is booked as a grn row with a NEGATIVE qty, usually
// under the same GRN number: mrn_line 7384 ('70*85*70mm Bush') is +2 on 2026-06-06 and -2 on
// 2026-06-08. Counting it gave that line "not received · 0" beside an arrival date of the day
// the goods went BACK, badged as a second delivery. Only positive receipts are arrivals.

// What counts as an arrival at all. Both halves matter: an undated row cannot date anything,
// and a credit note is a departure.
const ARRIVAL = (g) => `NULLIF(${g}.delivery_date, '') IS NOT NULL AND COALESCE(${g}.qty, 0) > 0`;

const dateTriple = (g, where) =>
  `(SELECT MAX(date(${g}.delivery_date)) FROM grn ${g} WHERE ${where}) AS last_received,
          (SELECT MIN(date(${g}.delivery_date)) FROM grn ${g} WHERE ${where}) AS first_received,
          (SELECT COUNT(DISTINCT date(${g}.delivery_date)) FROM grn ${g} WHERE ${where}) AS receipt_days`;

/**
 * SQL for the receipt dates of ONE MRN line.
 * @param {string} lineCol  the mrn_lines.id expression in the surrounding query, e.g. 'ml.id'
 * @param {string} [g]      alias for the correlated grn table (must not clash with the caller's)
 */
function lineReceiptSql(lineCol, g = 'grd') {
  return dateTriple(g, `${g}.mrn_line_id = ${lineCol} AND ${ARRIVAL(g)}`);
}

/** The same, for a whole MRN — grn carries mrn_id directly, so no join hop through the lines. */
function mrnReceiptSql(mrnCol, g = 'grd') {
  return dateTriple(g, `${g}.mrn_id = ${mrnCol} AND ${ARRIVAL(g)}`);
}

/** One receipt's own date. Used where the row IS a grn row. */
const GRN_RECEIVED_DATE = `date(NULLIF(grn.delivery_date, ''))`;

/** YYYY-MM-DD, or '' — never a timestamp, never today-by-accident. */
const d10 = (v) => (v ? String(v).slice(0, 10) : '');

/**
 * How a received date should read on a row, in one place so every surface agrees.
 * Returns { text, title, split } — `text` is already plain (callers escape it), and `split` is
 * the NUMBER of extra dates beyond the one shown (0 when it all came at once), because callers
 * print it: "+2". Keep it a number; a boolean here rendered as "+true" in the Excel exports.
 */
function receivedLabel(row) {
  const last = d10(row && row.last_received);
  const first = d10(row && row.first_received);
  const days = Number(row && row.receipt_days) || 0;
  const claimed = Number(row && (row.qty_received != null ? row.qty_received : row.received)) || 0;
  // Nothing is here. A line whose deliveries were all returned still has arrival dates behind
  // it, but it holds nothing, and a date beside "not received · 0" reads as a contradiction —
  // the receipt table on the request tells that story properly.
  if (claimed <= 0) return { text: '', title: '', split: 0 };
  if (!last) {
    // Says it was received but has no note to date it — say so rather than leave a blank
    // that reads as "nothing arrived".
    return { text: 'not recorded', title: 'Recorded as received, but no goods-received note carries a date for it', split: 0 };
  }
  if (days > 1 && first && first !== last) {
    return { text: last, title: `Received on ${days} dates, ${first} to ${last}`, split: days - 1 };
  }
  return { text: last, title: '', split: 0 };
}

module.exports = { lineReceiptSql, mrnReceiptSql, GRN_RECEIVED_DATE, receivedLabel, d10 };
