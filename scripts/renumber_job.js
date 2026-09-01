'use strict';

// Give a job card the number it should have had.
//
//   node scripts/renumber_job.js 2026/9/R/1 2026/9/R/2            # dry run
//   node scripts/renumber_job.js 2026/9/R/1 2026/9/R/2 --apply    # do it
//   node scripts/renumber_job.js 2026/9/R/1 --to 2026/9/R/604 --apply
//
// Written for a specific mess: the generator used to restart the sequence every month, so cards
// raised on the 1st came out as 2026/9/R/1 and /2 while August had already reached 603. The
// generator is fixed (src/lib/jobno.js); this repairs what it made before that.
//
// Given no --to, each card takes the next free number for its year and kind, IN THE ORDER LISTED,
// keeping its own month. So the two above become .../604 and .../605.
//
// The number is what is written on the paperwork in the workshop, so this refuses to be clever:
// dry run by default, one card at a time in a transaction, and it will not touch a CLOSED card
// without --force, because a closed card's number has been on a monthly report.

const { migrate, get, all, run, tx } = require('../src/db');
const audit = require('../src/lib/audit');

migrate();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const toIdx = args.indexOf('--to');
const EXPLICIT = toIdx !== -1 ? args[toIdx + 1] : null;
// `toIdx + 1` is the value belonging to --to, which is not a card to renumber. Guard the -1 case:
// without --to, toIdx is -1 and toIdx + 1 is 0, which silently swallowed the FIRST card named.
const skipIdx = toIdx === -1 ? -1 : toIdx + 1;
const targets = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx);

if (!targets.length) {
  console.log('\nusage: node scripts/renumber_job.js <job-no> [<job-no> …] [--to <new-no>] [--apply]\n');
  console.log('  Dry run unless --apply. --to only makes sense with a single card.');
  console.log('  --force allows renumbering a CLOSED card (its number has been reported).\n');
  process.exit(0);
}
if (EXPLICIT && targets.length > 1) {
  console.error('--to sets one number, so name one card.');
  process.exit(1);
}

const parse = (no) => {
  const p = String(no).split('/');
  if (p.length !== 4) return null;
  const seq = parseInt(p[3], 10);
  if (!Number.isFinite(seq)) return null;
  return { year: p[0], month: p[1], letter: p[2], seq };
};

/** Highest sequence in use for this year and kind — the same rule the generator follows. */
function maxSeq(year, letter) {
  let max = 0;
  for (const r of all('SELECT job_no FROM job_cards WHERE job_no LIKE ?', `${year}/%/${letter}/%`)) {
    const p = parse(r.job_no);
    if (!p || p.year !== year || p.letter !== letter) continue;
    if (p.seq > max) max = p.seq;
  }
  return max;
}

console.log(`\n${APPLY ? 'RENUMBERING' : 'DRY RUN — nothing will be written'}\n${'='.repeat(74)}`);

const plan = [];
const taken = new Set();
let refused = 0;

for (const oldNo of targets) {
  const card = get('SELECT id, job_no, status, type, description FROM job_cards WHERE job_no = ?', oldNo);
  if (!card) { console.log(`  SKIP  ${oldNo.padEnd(16)} no such job card`); refused++; continue; }
  const p = parse(oldNo);
  if (!p) { console.log(`  SKIP  ${oldNo.padEnd(16)} not a YYYY/M/(R|S)/seq number`); refused++; continue; }
  if (card.status === 'CLOSED' && !FORCE) {
    console.log(`  SKIP  ${oldNo.padEnd(16)} is CLOSED — its number has been on a monthly report. --force to override.`);
    refused++; continue;
  }

  let newNo = EXPLICIT;
  if (!newNo) {
    // Next free for the year, keeping the card's own month. `taken` carries the ones planned in
    // this same run, so two cards named together get consecutive numbers rather than the same one.
    let seq = maxSeq(p.year, p.letter) + 1;
    while (taken.has(`${p.year}/${p.letter}/${seq}`)
           || get('SELECT 1 AS x FROM job_cards WHERE job_no = ?', `${p.year}/${p.month}/${p.letter}/${seq}`)) seq += 1;
    newNo = `${p.year}/${p.month}/${p.letter}/${seq}`;
    taken.add(`${p.year}/${p.letter}/${seq}`);
  } else if (get('SELECT 1 AS x FROM job_cards WHERE job_no = ?', newNo)) {
    console.log(`  SKIP  ${oldNo.padEnd(16)} ${newNo} is already in use`);
    refused++; continue;
  }

  // Places the OLD number is written down as text rather than joined by id.
  const services = all('SELECT id FROM service_jobs WHERE job_no = ?', oldNo).map((r) => r.id);
  const snaps = all(
    'SELECT id, kind, report_date FROM daily_report_snapshots WHERE payload LIKE ?', `%${oldNo}%`);

  plan.push({ card, oldNo, newNo, services, snaps });
  console.log(`  ${APPLY ? 'OK  ' : 'would'}  ${oldNo.padEnd(16)} -> ${newNo.padEnd(16)} ${card.status.padEnd(12)} ${String(card.description || '').slice(0, 30)}`);
  if (services.length) console.log(`         also updating service_jobs: ${services.join(', ')}`);
  if (snaps.length) {
    // Deliberately NOT rewritten. A frozen daily report is what was printed and circulated that
    // day; changing it would make the file disagree with the paper somebody already has.
    console.log(`         NOTE: ${snaps.length} frozen daily report(s) mention ${oldNo} and are left alone:`);
    for (const s of snaps) console.log(`               ${s.kind} ${s.report_date}`);
  }
}

if (APPLY && plan.length) {
  for (const p of plan) {
    tx(() => {
      run('UPDATE job_cards SET job_no = ? WHERE id = ?', p.newNo, p.card.id);
      for (const sid of p.services) run('UPDATE service_jobs SET job_no = ? WHERE id = ?', p.newNo, sid);
    });
    audit.record({
      userId: null, entity: 'job_card', entityId: p.card.id, action: 'renumber',
      before: { job_no: p.oldNo }, after: { job_no: p.newNo },
      reason: 'monthly reset in the old generator; corrected to continue the year',
    });
  }
}

console.log('='.repeat(74));
console.log(`${plan.length} ${APPLY ? 'renumbered' : 'to renumber'}, ${refused} skipped.`);
if (!APPLY && plan.length) console.log('Nothing was written. Re-run with --apply.\n');
else if (APPLY) console.log('Tell the workshop — the number on the paper card needs to match.\n');
else console.log('');

process.exit(0);
