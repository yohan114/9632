'use strict';

// Put the job cards whose approvals were given on PAPER into the workshop.
//
//   node scripts/legacy_cards_into_workshop.js                      (dry run, default)
//   node scripts/legacy_cards_into_workshop.js --apply
//   node scripts/legacy_cards_into_workshop.js --apply --skip-stuck
//   node scripts/legacy_cards_into_workshop.js --before=2026-10-01  (the cut-off; this is the default)
//
// THE CUT-OFF IS THE WHOLE RULE. Up to 1 October 2026 every Transport Manager and Operational
// Manager approval at this workshop was given by hand, away from the app — so a card raised before
// that date has already been approved twice, and the two steps it is sitting at are asking for
// signatures that exist on paper. From 1 October the whole process runs in the app: a job request
// is raised, certified and approved, and only then does the workshop open the card
// (src/routes/jobcards.js). Nothing on or after the cut-off is touched here, by design — those are
// exactly the ones that must go through it.
//
// The cards move to IN_WORKSHOP, which is where they actually are. The vehicle is held either way
// (REQUESTED is already an open status), so the move frees nothing and blocks nothing; what changes
// is that the Requests list empties and Ongoing shows the real work.
//
// NOT touched, whatever their date:
//   - a card that HAS a job request: it came through the new road and its approvals are real;
//   - a breakdown or field card: REQUESTED on purpose and worked from the Field board. The machine
//     is at a site, and putting it in the workshop would be a lie on that board;
//   - container and imported cards (the Review screen's own test, job_review.CONTAINER_SQL, plus
//     is_historical) — cost holders and history, not work.
//
// STUCK CARDS — over 90 days old with nothing recorded on them — are included, because the cut-off
// covers them and their approvals were given on paper like the rest. They are counted separately in
// the report all the same: a card nobody has touched in three months is likelier to want rejecting
// or closing on its own date through "Review stuck cards" than to be work in progress on the Ongoing
// board. --skip-stuck leaves them where they are.
//
// The approval rows it writes carry NO approver_id, and say why: nobody signed these in the app, and
// inventing a name for a hundred-odd cards would put a person against work they never saw. The dates
// are the card's own requested_at, not today, so a card that has waited seven weeks still reads as
// seven weeks on the Ongoing board rather than resetting to zero.

const { all, run, tx } = require('../src/db');
const review = require('../src/lib/job_review');
const audit = require('../src/lib/audit');

const APPLY = process.argv.includes('--apply');
const SKIP_STUCK = process.argv.includes('--skip-stuck');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const CUTOFF = arg('before', '2026-10-01');
if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF)) {
  console.error(`\n  **  --before must be a date like 2026-10-01, not "${CUTOFF}"\n`);
  process.exit(1);
}
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// The two states a card can be waiting at on the old road.
const WAITING = ['REQUESTED', 'APPROVED_TRANSPORT'];
const SELECT = `
  SELECT j.id, j.job_no, j.status, j.description, j.requested_at, j.asset_id, j.workshop_id, j.total_cost,
         a.code AS asset_code, a.registration AS asset_reg,
         ${review.ACTIVITY_COLS}
    FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
   WHERE j.status IN (${WAITING.map(() => '?').join(',')})
     AND j.job_request_id IS NULL
     AND COALESCE(j.is_historical, 0) = 0
     AND COALESCE(j.breakdown, 0) = 0
     AND COALESCE(j.field, 0) = 0
     AND NOT ${review.CONTAINER_SQL}`;

const before = all(`${SELECT} AND date(j.requested_at) < date(?) ORDER BY j.requested_at, j.id`, ...WAITING, CUTOFF);
const after = all(`${SELECT} AND date(j.requested_at) >= date(?) ORDER BY j.requested_at, j.id`, ...WAITING, CUTOFF);

const now = today();
const stuck = before.filter((r) => review.isStuck(r, now));
const moving = SKIP_STUCK ? before.filter((r) => !review.isStuck(r, now)) : before;

const age = (r) => (r.requested_at ? Math.floor((Date.parse(now) - Date.parse(String(r.requested_at).slice(0, 10))) / 86400000) : null);
const label = (r) => r.asset_reg || r.asset_code || '(no vehicle)';
const worked = (r) => r.daily_work + r.parts + r.mrns + r.issues + r.oil + r.general;

console.log(`\nCut-off: ${CUTOFF} — approvals before it were given on paper, from it they run in the app.\n`);
console.log(`Job cards with no job request, waiting at an approval step:`);
console.log(`  ${before.length} raised BEFORE ${CUTOFF} — already approved by hand`);
console.log(`  ${after.length} raised ON OR AFTER ${CUTOFF} — these must go through the process, and are left alone`);

if (!moving.length) {
  console.log(`\nNothing to move.\n`);
  process.exit(0);
}

const byStatus = {};
for (const r of moving) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const ages = moving.map(age).filter((n) => n != null).sort((x, y) => x - y);
const withWork = moving.filter((r) => worked(r) > 0).length;

console.log(`\nMoving ${moving.length} card(s) to IN_WORKSHOP:`);
console.log(`  from:     ${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', ')}`);
if (ages.length) console.log(`  age:      ${ages[0]}–${ages[ages.length - 1]} days (median ${ages[Math.floor(ages.length / 2)]})`);
console.log(`  activity: ${withWork} already carry work, parts or requests; ${moving.length - withWork} have nothing yet`);
console.log(`  vehicles: ${new Set(moving.map((r) => r.asset_id)).size}`);
if (stuck.length) {
  console.log(`\n  ${SKIP_STUCK ? `${stuck.length} stuck card(s) LEFT OUT (--skip-stuck)`
    : `of these, ${stuck.length} are stuck — over 90 days with nothing recorded.`}`);
  console.log(`  ${SKIP_STUCK ? '  Work them through Job Cards → 🧹 Review stuck cards.'
    : '  They will land on the Ongoing board as work nobody has touched in months. To leave'}`);
  if (!SKIP_STUCK) console.log(`    them for Job Cards → 🧹 Review stuck cards instead, add --skip-stuck.`);
}

console.log();
for (const r of moving.slice(0, 15)) {
  console.log(`  ${r.job_no.padEnd(16)} ${String(label(r)).padEnd(16)} ${String(age(r) ?? '?').padStart(4)}d  ${String(r.description || '').slice(0, 50)}`);
}
if (moving.length > 15) console.log(`  … and ${moving.length - 15} more`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing was changed. To do it:\n  node scripts/legacy_cards_into_workshop.js --apply\n`);
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const why = `Raised before ${CUTOFF}, when Transport and Operational approvals were given on paper rather than in the app. Moved into the workshop in bulk on ${stamp}.`;

let moved = 0;
tx(() => {
  for (const r of moving) {
    // The dates the card already carries, not today's: a card that has waited seven weeks should go
    // on reading as seven weeks on the Ongoing board.
    const at = r.requested_at || stamp;
    run(`UPDATE job_cards
            SET status = 'IN_WORKSHOP',
                approved_transport_at = COALESCE(approved_transport_at, ?),
                approved_ops_at       = COALESCE(approved_ops_at, ?),
                updated_at            = datetime('now')
          WHERE id = ?`, at, at, r.id);
    // No approver_id: nobody signed these in the app, and the reason says so rather than leaving a
    // reader to wonder who did.
    for (const role of ['transport_manager', 'operational_manager']) {
      run(`INSERT INTO job_approvals (job_id, role, approver_id, decision, reason, created_at)
           VALUES (?, ?, NULL, 'approved', ?, ?)`, r.id, role, why, at);
    }
    audit.record({ entity: 'job_card', entityId: r.id, action: 'transition',
      before: { status: r.status }, after: { status: 'IN_WORKSHOP' }, reason: why, notify: false });
    moved++;
  }
});

console.log(`\n${moved} card(s) moved to IN_WORKSHOP — on Job Cards → ONGOING now, and out of the Requests list.`);
if (after.length) {
  console.log(`\n${after.length} card(s) raised on or after ${CUTOFF} were left where they are: from the cut-off`);
  console.log(`the approvals belong in the app, so those go through the process like any other.`);
}
if (SKIP_STUCK && stuck.length) {
  console.log(`\n${stuck.length} stuck card(s) were left alone. Work them through Job Cards → 🧹 Review stuck cards,`);
  console.log(`which rejects or closes each on its own date rather than calling it work in progress.`);
}
console.log();
