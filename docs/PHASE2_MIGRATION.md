# Phase 2 — Job History Migration Plan (ground-truth corrected)

This is the authoritative plan for importing the Excel job history, updated from
the owner's ground-truth analysis of the real files. **The migration itself is
blocked until the source files are provided** (`Job_Record.xlsx`,
`Daily_Work_Done_updated.xlsx`); the code pieces that don't need the files are
already built (see "Done in code" below).

## Source files required

- `Daily_Work_Done_updated.xlsx` — sheets `From 1st Dec2025` (daily work),
  `Labor Hour` (mechanic rates).
- `Job_Record.xlsx` — sheets `C-job`, `Requested job`, `service`, `job cost`,
  `oil` (prices), `Muthur plant` (service specs).

## Validation targets (populated rows, NOT sheet totals)

| Sheet | Rows to import |
|---|---|
| `C-job` | **510** |
| `service` | **130** |
| `Requested job` | **3024** |
| `job cost` | **411** |
| `Daily work` (`From 1st Dec2025`) | **2117** |

Row counts in vs out must match these (or every difference is explained).

## Reference data to seed

- **17 labour rates** from `Labor Hour` (e.g. Anura 425, Buddhika 425,
  Chaminda 250, Krishna 250, Viboda 125, …).
- **8 priced oils** from the `oil` sheet → `product_prices`.
- **5 service specs** from `Muthur plant` → `service_specs`. **Some rows are
  column-misaligned / sparse** — the importer must tolerate sparse rows and map
  by best-effort per column, flagging any row it can't parse rather than guessing.

## Correction #1 — `job cost` is a standalone log, NOT linked to job_cards

The `job cost` sheet uses **its own running sequence (4–984)**. It reconciles to
**neither** `C-job.ref` **nor** `job_no` — **0 / 410 match**. Therefore:

- Import every `job cost` row into the **`historical_job_costs`** table
  (already in the schema): `seq`, `description`, `spare_parts_cost`,
  `external_cost`, `labour_cost`, `total_cost`, `raw_ref` verbatim.
- Leave `job_id` **NULL** — do **not** auto-link to `job_cards`.
- **Ask the owner** how (if at all) these numbers map to jobs before any linking.

## Correction #3 — multi-mechanic split runs BEFORE the history import

**1,100 of 2,117** daily rows list 2+ mechanics; without splitting, ~52% of
historical labour cost imports incorrectly. The importer must split each daily
cell into one `job_daily_work` row per mechanic **before** costing.

- Separators: `,` `&` `+` and the word `and`. **NOT `/`** — a slash joins two
  spellings of one person (`Seethananda/seetha`).
- Reuse `lib/mechanics.splitMechanics()` (already built + tested).

> **Open question for the owner (cost-critical):** when a daily row lists N
> mechanics against H hours, does **each** mechanic get H hours (current
> assumption — one row per mechanic, each H×rate), or is H **shared/divided**
> among them? This changes historical labour cost materially. Confirm before the
> import runs.

## Correction #4 — mechanic-name resolver for rate lookup

Same spelling problem as vehicles ("seetha" vs "Seethananda/seetha",
"Vinod" vs "Vinod M"). Resolve every raw mechanic name to one canonical
mechanic before costing. Reuse `lib/mechanics.resolveMechanic()` (built + tested);
unknown spellings queue as pending mechanic aliases for a human to link.

## Import order

1. Seed reference data: 17 labour rates, 8 oil prices, 5 service specs (tolerate
   sparse Muthur rows).
2. Import `C-job` (510) + `service` (130) + `Requested job` (3024) → `job_cards`
   as historical **CLOSED** records with their recorded totals. Parse the job-no
   format into year/month/type/seq. Resolve each vehicle to an `asset_id`.
   Historical rows are **not** forced through the closure gate.
3. Import `Daily work` (2117) → `job_daily_work`, splitting multi-mechanic cells
   (Correction #3) and resolving each name (Correction #4). Keep the free-text
   description as source of truth; optionally parse embedded oil quantities
   ("CI4-10L, HD68-10L") into a note.
4. Import `job cost` (411) → `historical_job_costs` standalone (Correction #1).
5. Report: row counts in vs out per sheet against the targets above; any
   unparseable Muthur rows; any vehicle names that stayed pending in the resolver.

## Done in code already (no files needed)

- `historical_job_costs` table (standalone, no auto-link).
- `lib/mechanics.js`: `splitMechanics`, `normalizeMechanic`, `resolveMechanic`
  (learning + pending queue), `resolveMechanicName`, `findOrCreateMechanic`.
- Costing routes labour rate lookup through the mechanic resolver.
- Live daily-work entry splits multiple mechanics into one costed row each.
- `/api/mechanics` (registry + rates) and the mechanic alias queue UI.
- Tests cover the split rules, alias→rate resolution, and the multi-mechanic API.
