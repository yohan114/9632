'use strict';

// The job card number: YYYY/M/(R|S)/seq
//
// THE SEQUENCE RUNS THROUGH THE YEAR, NOT THE MONTH. August ending at 583 means September starts
// at 584, and the month in the number says when the card was raised, not where the counter is.
//
// It used to reset. The generator asked for the highest number matching "2026/9/R/%", found none on
// the first of the month, and started again at 1 — so the workshop got a second card numbered 1
// every month. The evidence is in the book: 2026/7/R/1 was created by the app on 19 July while
// June had already reached 434, and it sits in the same month as 2026/7/R/493.
//
// The paperwork has always worked the other way. Through 2025 each month began exactly where the
// last ended — 106 in February, unbroken to 920 in November — and the count restarts with the year.
// That is the rule implemented here: continue within the year, begin again at 1 in January.
//
// One generator, used by both the job-card route and the job-request route. They had a copy each,
// identical and separately maintained, so a card raised from a job request numbered itself by
// whichever copy had been updated last.

const { get, all } = require('../db');

const letterFor = (type) => (type === 'service' ? 'S' : 'R');

/**
 * The next number for this kind of card.
 * @param {string} type  'repair' | 'service'
 * @param {Date} [when]  the day it is being raised (injectable so the year rollover is testable)
 */
function nextJobNo(type, when = new Date()) {
  const year = when.getFullYear();
  const month = when.getMonth() + 1;
  const letter = letterFor(type);

  // Every card of this kind in this year, whatever month it was raised in.
  let max = 0;
  for (const r of all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', `${year}/%/${letter}/%`)) {
    const parts = String(r.job_no).split('/');
    // LIKE is a blunt filter — "%" would happily match 2026/9/RX/4. Check the shape properly.
    if (parts.length !== 4 || parts[0] !== String(year) || parts[2] !== letter) continue;
    const seq = parseInt(parts[3], 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }

  // job_no is UNIQUE. max+1 cannot already exist for this year by definition, but the imported
  // history is not ours and a clash here would surface as a 500 on the Create button rather than
  // as anything a person could act on. Cheap to rule out.
  let seq = max + 1;
  let no = `${year}/${month}/${letter}/${seq}`;
  while (get('SELECT 1 AS x FROM job_cards WHERE job_no = ?', no)) {
    seq += 1;
    no = `${year}/${month}/${letter}/${seq}`;
  }
  return no;
}

module.exports = { nextJobNo, letterFor };
