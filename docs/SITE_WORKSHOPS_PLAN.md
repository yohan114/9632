# Plan — a site workshop stands on its own, and can see the others' work

_Status: plan only. Nothing is built yet._

---

## 1. What is being asked

Adding a workshop should set up a place that **runs itself**:

- its **own store**, its **own job cards**, its **own mechanics, daily work and purchasing**;
- everything of its own starts **empty** — a new site begins with a clean book, not a share of
  somebody else's;
- but it can **look at** the job cards and service records of the main workshop and of the other
  sites, including the ones already on the book. Looking only: it signs nothing and changes
  nothing there.

So: **separate to work in, open to read.**

---

## 2. Where things stand today

Most of the separation exists. It was built as Stages 2–5 and is switched on by **"Separate
workshops"** on the Workshops page (off until an admin turns it on, and idle until there is more
than one active workshop).

**Already kept apart** — a scoped person sees only their own workshop's:

| What | How |
|---|---|
| Job cards, job requests | `job_cards.workshop_id`, `job_requests.workshop_id` |
| Daily work | through the card's workshop |
| Requests, receipts, issues, transfers (MRN/GRN/MIN/MTN) | `mrn.workshop_id`, and the store each movement happened in |
| Stock | per store (`workshops.own_store` / `uses_store` / `store_opened`) |
| Mechanics | `mechanic_workshops`, from a date |
| Attendance and day sign-off | per workshop |
| Purchasing | `purchasing_flow.js`, on the request's workshop |
| Reports | Stage 5, per workshop |

**Not kept apart, and in the way of this:**

| What | Why it matters |
|---|---|
| **Service records** (`service_jobs`) | No `workshop_id` at all — only a `store_id`. `routes/filters.js` makes no scope check, so every site sees every service record today. "View the previous services" is already true by accident; it needs to become true on purpose, and say whose each one is. |
| **Tools and toolboxes, tyre & battery requests, the stock cockpit, general stock, the oil book, filter stock** | Zero scope checks between them. Stock itself is per store, but these screens are not, so a site sees the whole company's lists. |
| **Adding a workshop** | `workshops.create()` writes a row with a code, a name and a place. Nothing else. A new workshop starts **using the main store**, with nobody in it, and the separation switch untouched. Every other step is by hand, on three different screens, and nothing says what is still to do. |

**The one piece of the new idea that already exists.** On a vehicle's page, another workshop's open
card is listed but *veiled* — `src/routes/assets.js:106` returns its number, status and workshop and
drops the description, the cost and the link. That is exactly the shape this plan generalises.

---

## 3. The one new idea: three states, not two

Scoping today is a yes/no: you reach a record, or you get a 403. This needs a middle state.

| State | Means | Where it applies |
|---|---|---|
| **Mine** | see it, work on it, sign it | my workshop's everything |
| **Visible** | read it in full; every button is gone; the server refuses every write | **job cards and service records** of other workshops |
| **Out of reach** | not listed, 403 by id | everything else of other workshops — requests, stock, mechanics, daily work, purchasing, attendance |

Putting it in one place matters: `scope.mayReach()` is called from eleven route files, and a second
rule invented per screen is how a site ends up able to close another site's job card from the list
while being refused on the card itself.

Concretely, `src/lib/scope.js` gains one function next to `mayReach`:

```
mayRead(user, workshopId, kind)   // kind: 'job' | 'service'
```

`true` when `mayReach` is true, and also when the person holds the new viewing capability and the
record is one of the two readable kinds. Writes keep calling `mayReach` and are unaffected, so no
existing refusal is loosened by accident.

---

## 4. Decisions to confirm

These change the shape of the work. The recommendation is what §5 is written against.

| # | Question | Recommendation |
|---|---|---|
| **D1** | **How much of another site's job card shows?** The whole thing including costs, or the work without the money? | **The whole card, costs included.** It is one company and one owner; the Monthly Cost report already shows every workshop to head office. Hiding the figure on the card and printing it in the report is a line nobody can explain. (Say if site managers should not see each other's costs — it is a filter on one query, but better decided now than after.) |
| **D2** | **Which lists go cross-workshop?** | **The record lists only: All Cards, a card's own page, and Service Records.** The *work* lists stay strictly own-workshop — Requests waiting for a decision, Ongoing, Finishing, Ready to close, the Monitor counts, the dashboard queues. Those are to-do lists, and another site's to-dos are not yours to do. |
| **D3** | **Who may look?** | **A new capability, `jobs.view_other_workshops`**, given by default to the roles that already see job cards (Workshop, Manager, Operational Manager, Transport). A capability rather than a blanket rule, so you can take it off a site later without a code change. |
| **D4** | **Service records need a workshop.** They have none. | **Add `service_jobs.workshop_id`**, backfilled from the service's job card where there is one, else from the store that recorded it, else the main workshop. Without it "whose service is this" has no answer and the Service Records list cannot say. |
| **D5** | **Does a new workshop get its own store automatically?** | **Yes — the add form offers it, ticked, opening today**, because that is what "runs itself" means. It stays changeable: a small site that genuinely draws from the main store unticks it. A store cannot be closed again once stock has moved in it (`stores.setStore`), so the form says so before you commit. |
| **D6** | **The separation switch.** It is global, and today adding a workshop does not touch it. | **Leave it global, but make the add form say what it is doing.** Adding the second workshop while the switch is off means the new site sees everything and nothing is separate — the form should say so and offer to turn it on in the same step. Turning it on per workshop would mean two rules running at once, which is worse. |
| **D7** | **The screens with no scoping at all** — tools, tyre & battery requests, the stock cockpit, general stock, the oil book, filter stock. | **Scope them in this work**, to the person's store or workshop as each one fits. "Its own stores" is not true while the oil book and the general rack show the whole company. This is the largest single piece and could be split out if you want the rest sooner. |

---

## 5. The work, step by step

### 5.1 One rule, in one place — `src/lib/scope.js`

- Add `mayRead(user, workshopId, kind)` and `readFilter(user, column, kind)` beside the existing
  `mayReach` / `filter`. Reads for the two open kinds pass when the capability is held; everything
  else falls through to today's behaviour.
- Add `isReadOnly(user, workshopId)` — true when a record is visible but not mine. Every route that
  returns a job card or a service record carries this to the client as `read_only: true`, so the
  front end never has to work it out from workshop ids.
- No existing export changes meaning. `mayReach` stays the write test, and stays what
  `jobRefusal`, `mrnRefusal` and `jobRequestRefusal` call.

### 5.2 Job cards: readable, never writable

- `GET /api/jobs` — the list uses `readFilter`, so another site's cards appear. Each row carries
  `workshop_code` (it already does) and `read_only`.
- `GET /api/jobs/:id` — `scope.jobParam` currently refuses by id. It becomes: refuse only when the
  person may not even read it; otherwise serve the card with `read_only: true`.
- **Every write route under `/api/jobs/:id` keeps the old refusal.** `router.param` cannot tell a
  GET from a POST on its own, so the guard moves to a pair: `jobReadParam` on the router, and a
  `mustOwn` check at the top of each write handler (transition, edit, daily work, parts, close,
  partial close, reopen, reason, field, attach, unlink). That list is the risk in this plan — one
  missed handler is a site editing another site's card. §6 covers it with a test that walks the
  router's own stack rather than a list someone keeps by hand.
- The Requests, Ongoing, Finishing and Ready lists (`src/lib/jobs_flow.js`) keep `scope.filter`
  unchanged (D2).

### 5.3 Service records get a workshop — `src/db/index.js`, `src/routes/filters.js`

- `ensureColumn('service_jobs', 'workshop_id', 'INTEGER REFERENCES workshops(id)')`, index, and a
  backfill: the service's job card's workshop, else the workshop whose store is `store_id`, else the
  default. A trigger stamps new rows the way `job_cards` and `mrn` already do.
- The Service Records list gains a workshop column and a workshop filter, reads with `readFilter`,
  and marks another workshop's rows `read_only`.
- Writing a service record, and attaching to one, keep `mayReach`.

### 5.4 Adding a workshop becomes a setup — `src/lib/workshops.js`, `public/app.js`

`workshops.create()` grows one transaction that does what is done by hand on three screens today:

1. the workshop row (as now);
2. **its own store**, opening on a date (D5) — `stores.setStore` already does this and is reused;
3. **the people who run it**, picked in the form, moved to it;
4. **the separation switch**, offered when this is the second workshop and it is still off (D6).

The Add Workshop form becomes four short steps matching those, with a plain statement above them:

> A new workshop starts empty — no mechanics, no daily work, no stock, no purchasing. It can look
> at other workshops' job cards and service records, but works only on its own.

After it saves, the Workshops page shows a **readiness line** for any workshop with nothing in it
yet — *no mechanics · no stock · nobody assigned* — each linking to the screen that fixes it, so a
half-finished site is visible rather than quietly broken.

### 5.5 The screens with no scoping (D7)

Tools and toolboxes, tyre & battery requests, the stock cockpit, general stock, the oil book and
filter stock each get the same treatment the stores screens had in Stage 4: filter by the person's
store (for stock) or workshop (for the rest), with head office seeing all. Each is a `scope.filter`
on a list query and a refusal on the by-id routes; the pattern is `src/routes/stores.js`.

### 5.6 Screens

- A card or service record that is not yours opens with a band at the top — **"Muthur Workshop's
  job card — you can read it, not change it"** — and every action button absent, not disabled.
- The All Cards and Service Records lists gain a workshop column (they show one already when
  several workshops exist) and an **"All workshops / mine only"** toggle, remembered per person.
- The vehicle page's veil (`assets.js:106`) lifts for whoever holds the capability: the other
  workshop's card becomes a real link instead of a stub.

---

## 6. Tests

The existing `test/stage3_scoping.test.js` is the spine and keeps its meaning: everything it asserts
about requests, stock, mechanics and daily work stays true. What changes is job cards and services.

**New — `test/site_workshops.test.js`:**

- a site sees another workshop's card in the list, and on its own page, with `read_only: true`;
- **every write route on that card is refused** — walked from the router's own stack, so a handler
  added later is covered without anyone remembering to add it here;
- without the capability, the old 403 is exactly what comes back;
- the work lists do NOT cross workshops: Requests, Ongoing, Finishing, Ready and the Monitor counts
  are unchanged for a scoped person;
- service records: the backfill puts each on the right workshop; a site reads another's and cannot
  edit it;
- adding a workshop in one call leaves it with its own store from today, its people moved, nothing
  else, and the switch on when it was asked for;
- a workshop added while the switch is off is reported as not separate rather than silently open;
- the D7 screens: a site's oil book, general rack, tools and tyre requests show its own only.

---

## 7. Order of work

1. `scope.mayRead` / `readFilter` / `isReadOnly` with their tests, changing no behaviour yet (§5.1).
2. The capability, off by default, so nothing moves until it is granted (D3).
3. Job cards readable, writes locked down, with the router-walking test (§5.2) — the piece to get
   right before any of it is switched on.
4. `service_jobs.workshop_id`, its backfill, and the Service Records list (§5.3).
5. Add Workshop as a setup, and the readiness line (§5.4).
6. Screens (§5.6).
7. The unscoped screens (§5.5) — separable, if you want 1–6 live sooner.

---

## 8. What you will see afterwards

- **Adding a workshop** asks four things and leaves a place that works: its own store from today,
  its people in it, and an empty book.
- **A site's own screens** show its own work only, as now — but the oil book, the general rack, the
  tools and the tyre requests join that, which they do not today.
- **Job Cards and Service Records** gain an "All workshops" view: a site can read the main
  workshop's and the other sites' cards and services, old ones included, and cannot touch them.
- **Head office** is unchanged: it already sees and does everything.
