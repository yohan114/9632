'use strict';

// Put the job cards raised BEFORE job requests existed into the workshop.
//
//   node scripts/legacy_cards_into_workshop.js            (dry run, default — changes nothing)
//   node scripts/legacy_cards_into_workshop.js --apply
//   node scripts/legacy_cards_into_workshop.js --apply --include-stuck
//
// A job card is now opened by the workshop against a job request that has been raised, certified
// and approved (src/routes/jobcards.js). The cards raised before that have no request behind them,
// and were approved on paper rather than in the app — so the two approval steps they are sitting at
// are asking for a signature that was already given, by people who would be signing for work from
// weeks ago. Left alone they stay in the Requests list for ever.
//
// This moves them to IN_WORKSHOP, which is where they actually are. The vehicle is held either way
// (REQUESTED is already an open status), so nothing is freed or blocked by the move; what changes is
// that the Requests list empties and the Ongoing list shows the real work.
//
// NOT touched:
//   - a card that HAS a job request (job_request_id): it came through the new road and its approvals
//     are real;
//   - container and imported cards (the Review screen's own test, job_review.CONTAINER_SQL, plus
//     is_historical) — they are cost holders and history, not work;
//   - a breakdown or field card: it is REQUESTED on purpose and is worked from the Field board. The
//     machine is at a site, not in the workshop, and saying otherwise would be a lie on the board;
//   - a STUCK card — REQUESTED, over 90 days old, nothing done on it. Those are what
//     "Review stuck cards" (Job Cards → 🧹) is for: they want rejecting or closing on their own
//     date, not relabelling as work in progress. --include-stuck overrides that, deliberately.
//
// The approval rows it writes carry NO approver_id, and say why: nobody signed these in the app, and
// inventing a name for 127 cards would put a person's name against work they never saw. The dates
// are the card's own requested_at, not today, so a card that has been waiting seven weeks still
// reads as seven weeks of waiting on the Ongoing board rather than resetting to zero.

const { all, run, tx } = require('../src/db');
const review = require('../src/lib/job_review');
const audit = require('../src/lib/audit');

const APPLY = process.argv.includes('--apply');
const INCLUDE_STUCK = process.argv.includes('--include-stuck');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// The two states a card can be waiting at on the old road.
const WAITING = ['REQUESTED', 'APPROVED_TRANSPORT'];

const rows = all(`
  SELECT j.id, j.job_no, j.status, j.description, j.requested_at, j.asset_id, j.workshop_id,
         j.is_historical, j.breakdown, j.field, j.total_cost,
         a.code AS asset_code, a.registration AS asset_reg,
         ${review.ACTIVITY_COLS}
    FROM job_cards j LEFT JOIN assets a ON a.id = j.asset_id
   WHERE j.status IN (${WAITING.map(() => '?').join(',')})
     AND j.job_request_id IS NULL
     AND COALESCE(j.is_historical, 0) = 0
     AND COALESCE(j.breakdown, 0) = 0
     AND COALESCE(j.field, 0) = 0
     AND NOT ${review.CONTAINER_SQL}
   ORDER BY j.requested_at, j.id`, ...WAITING);

const now = today();
const stuck = rows.filter((r) => review.isStuck(r, now));
const live = rows.filter((r) => !review.isStuck(r, now));
const moving = INCLUDE_STUCK ? rows : live;

const age = (r) => (r.requested_at ? Math.floor((Date.parse(now) - Date.parse(String(r.requested_at).slice(0, 10))) / 86400000) : null);
const label = (r) => r.asset_reg || r.asset_code || '(no vehicle)';
const worked = (r) => r.daily_work + r.parts + r.mrns + r.issues + r.oil + r.general;

console.log(`\nJob cards with no job request, waiting at an approval step: ${rows.length}`);
console.log(`  ${live.length} still live (under 90 days, or worked on since)`);
console.log(`  ${stuck.length} stuck — over 90 days with nothing done${INCLUDE_STUCK ? ' (INCLUDED: --include-stuck)' : " (left for 'Review stuck cards')"}`);

if (!moving.length) {
  console.log('\nNothing to move.\n');
  process.exit(0);
}

const byStatus = {};
for (const r of moving) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const ages = moving.map(age).filter((n) => n != null).sort((x, y) => x - y);
const withWork = moving.filter((r) => worked(r) > 0).length;

console.log(`\nMoving ${moving.length} card(s) to IN_WORKSHOP:`);
console.log(`  from: ${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', ')}`);
if (ages.length) console.log(`  age:  ${ages[0]}–${ages[ages.length - 1]} days (median ${ages[Math.floor(ages.length / 2)]})`);
console.log(`  ${withWork} already have work, parts or requests recorded; ${moving.length - withWork} have nothing yet`);
console.log(`  ${new Set(moving.map((r) => r.asset_id)).size} vehicles\n`);

for (const r of moving.slice(0, 15)) {
  console.log(`  ${r.job_no.padEnd(16)} ${String(label(r)).padEnd(16)} ${String(age(r) ?? '?').padStart(4)}d  ${String(r.description || '').slice(0, 52)}`);
}
if (moving.length > 15) console.log(`  … and ${moving.length - 15} more`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing was changed. To do it:\n  node scripts/legacy_cards_into_workshop.js --apply\n`);
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const why = `Raised before job requests existed, and approved outside the app — moved into the workshop in bulk on ${stamp}.`;

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

console.log(`\n${moved} card(s) moved to IN_WORKSHOP.`);
console.log(`They are on Job Cards → ONGOING now, and out of the Requests list.`);
if (stuck.length && !INCLUDE_STUCK) {
  console.log(`\n${stuck.length} stuck card(s) were left alone. Work them through Job Cards → 🧹 Review stuck cards,`);
  console.log(`which rejects or closes each on its own date rather than calling it work in progress.`);
}
console.log();
