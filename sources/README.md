# `sources/` — full dataset export for the master system migration

This folder is your **entire dataset as plain CSV files** — both databases (Stores + Oil) and the job-history spreadsheets. Commit it to your repo's `sources/` folder and point your coding agent at it. Your agent never needs the raw `.db`/`.xlsx` files; it reads these CSVs directly. Everything is UTF-8.

## How your agent should use this
- **Phase 1 (merge Stores + Oil):** load `stores/*.csv` and `oil/*.csv`.
- **Phase 2 Step 2 (reference seed):** load `reference/*.csv`.
- **Phase 2 Step 7 (job history):** load `jobs/*.csv` as already-closed history.

## Folder contents & row counts

### `stores/` — from `inventory.db`
| File | Rows | What it is |
|---|---|---|
| items.csv | 4,055 | MRN material requests per vehicle/machine |
| receipts.csv | 3,270 | GRN receipts (unit price, supplier, invoice, purchase source) |
| issues.csv | 299 | Items/repair charges issued to a vehicle |
| general_items.csv | 78 | Consumable item master |
| general_item_transactions.csv | 345 | Running-balance ledger for consumables |
| material_transfers.csv | 93 | MTN transfers between locations/vehicles |
| batteries.csv | 42 | Battery records (Stores side) |
| battery_movements.csv | 85 | Battery movement history (Stores side) |

### `oil/` — from `oilbook.db`
| File | Rows | What it is |
|---|---|---|
| products.csv | 21 | Lubricant/fuel master |
| transactions.csv | 1,807 | Oil stock ledger — **preserve `balance_after` running balance** |
| fleet_assets.csv | 424 | Plant/machinery/vehicle register |
| projects.csv | 11 | Project locations |
| sites.csv | 0 | (empty) |
| stock_counts.csv | 63 | Monthly physical count vs book, with variance |
| batteries.csv | 16 | Battery records (Oil side) — **merge with stores/batteries on serial** |
| battery_events.csv | 26 | Battery events (Oil side) — **merge with stores/battery_movements** |
| aliases.csv | 156 | Existing fuzzy name→asset/project resolver — seed the new alias engine from this |
| settings.csv | 7 | App settings (forecast_window_days=90, low_stock_days=14, etc.) |
| users.csv | 5 | Users — **`password_hash` is [REDACTED]; set fresh passwords on import** |
| user_projects.csv | 1 | User↔project mapping |
| requisitions.csv | 0 | (empty; feature built, unused) |

### `jobs/` — from the two Excel files
| File | Rows | What it is |
|---|---|---|
| c_job.csv | 510 | Completed repair jobs (Job no, Ref, Vehicle, Description, Hrs, Cost, Site) |
| service.csv | 376 | Service jobs (labour/filter/oil/total) — **labour is a FLAT charge, not hours×rate** |
| requested_job.csv | 3,039 | Job requests (col_1 = job/serial no, Major/Minor flag) |
| job_cost.csv | 492 | Standalone cost log — **does NOT link to C-job (0/410 on ref); import unlinked** |
| daily_work.csv | 2,166 | Daily work log (Date, Vehicle, Work, Mechanic, Hours, Outside Value) |
| mg_guide_rail.csv | 1 | Guide-rail tracking (minor) |

### `reference/` — cleaned seed data
| File | Rows | What it is |
|---|---|---|
| labour_rates.csv | 17 | Mechanic → hourly rate + canonical key for the mechanic resolver |
| oil_prices.csv | 13 | Product → price (8 priced, 5 blank) |
| service_specs.csv | 5 | Per-machine service template (filter costs + oil quantities), columns aligned |

## Critical migration notes (carry these into the import)
1. **`job_cost.csv` is standalone.** It uses its own sequence (4–984), unrelated to `c_job.csv`'s `Ref` (0/410 exact matches). Import it as a historical cost log with `job_id` NULL; do not auto-link. Ask the owner how (if at all) its numbers map to jobs.
2. **Row counts here = "any non-empty cell".** They differ slightly from counts by key column (e.g. service has 376 rows but ~130 with a vehicle; job_cost 492 rows but ~411 with a job-no). Rows without a vehicle/job-no are likely blanks or subtotals — filter as appropriate.
3. **Multi-mechanic split:** ~1,100 of the daily_work rows list 2+ mechanics (`Buddhika, Krishna`). Split into one costed row per mechanic (separators `, & + and`, but **not** `/`). Required for correct historical labour.
4. **Hours are TOTAL man-hours, not per-mechanic.** Cost each mechanic at `H/N` hours (equal split ≡ `H × avg crew rate`). Confirmed by consumption pattern (a solo oil change ≈3h; a 2-mechanic one ≈6.5h).
5. **Two labour models:** repairs/daily-work = hourly; **services = flat labour** (`service.csv` labour column). Don't run service jobs through the hourly engine.
6. **Mechanic-name fuzzy matching** needed for rate lookup (`seetha`→`Seethananda/seetha`, `Vinod` vs `Vinod M`) — mirror the asset alias resolver.
7. **Asset is the master key.** Union vehicle/machine codes across `oil/fleet_assets`, `stores/items`+`issues`, and the `jobs/*` vehicle columns (~1,437 distinct); normalise; auto-merge exact matches; queue the rest as pending aliases.
8. **Dates are TEXT** in varied formats (ISO in `*DateISO` columns; display strings elsewhere) — normalise on import. **Batteries appear in both DBs** — merge on serial and reconcile "current vehicle". **`users.password_hash` is redacted** — assign new passwords.
