# Tax Submission Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Finance → Tax module that lets the user create tax schedules, auto-generates per-period submission tasks with lead-time alerts (cron + email), and auto-calculates each return via a per-party template — shipping with NC DOR Sales & Use Tax as the first party.

**Architecture:** A thin party-agnostic engine (`lib/tax/`) owns schedules, task lifecycle, period math, and worksheet chrome; self-contained party modules (`lib/tax/parties/<party>/`) plug into a `TaxPartyTemplate` contract via a central registry and own all rate logic, data sources, and recompute behavior. Return figures derive from Square POS tax data now persisted per-line (`pos_line_item_taxes`). UI lives under `app/finance/tax/` with settings under `app/finance/settings/tax-filing/`.

**Tech Stack:** Next.js 16 (App Router, TS), Tailwind v4, Supabase Postgres (+ Storage), Square API (raw fetch), Resend, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-tax-submission-module-design.md`

## Global Constraints

- Next.js 16 conventions per `docs/nextjs16-deltas.md` — not training-data Next.js.
- No business logic in `app/api/**` or page components — extract to `lib/`.
- Supabase client per context: `lib/supabase/{server,browser,admin}`. Finance data is service-role-only; never the browser anon client for tax tables.
- Auth via `lib/auth.ts` (`getSessionUser`, roles viewer<brewer<manager<admin>`): manager+ to prepare/complete a task; admin for settings/identity writes.
- API routes parse with `requireDateRange()`/manual param parse + wrap errors with `apiError()` (`lib/utils/api.ts`).
- Every new/modified `lib/` module ships co-located `*.test.ts`; don't drop coverage below `vitest.config.ts` floor. `npm run verify` (lint + typecheck + tests) is the per-task DoD.
- UI: `app/globals.css` tokens + `app/components/ui/` primitives only — no raw `zinc/amber/red/green/blue/gray`, no hand-rolled buttons/inputs/cards/modals/badges/tabs. Page shell `<main className="px-4 sm:px-6 py-4 sm:py-8">`. Per `docs/UI_STANDARD.md`.
- All money in integer cents. Statutory tax rates are code constants (viewable, not user-editable); user-controllable choices are stored settings.
- Square API version `2025-04-16`; location `LZ8TH4A632YW0`; shared request wrapper in `lib/square/client.ts`.
- Migrations: new file in `supabase/migrations/`, never hand-edit existing. Migrations are applied to prod only by the human after explicit OK.

## Canonical Type Contracts (single source of truth — Task 5 creates these verbatim)

```ts
// lib/tax/types.ts
export type Frequency = "monthly" | "quarterly" | "annual";
export type TaxTaskStatus = "open" | "completed" | "skipped";
export type FieldOwnership = "computed" | "manual";

export interface TaxPeriod { start: string; end: string; due: string } // YYYY-MM-DD

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "email" | "tel" | "money" | "select";
  sensitive?: boolean;               // SSN/FEIN — never returned to the browser
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
}
export interface ReferenceTable { title: string; columns: string[]; rows: (string | number)[][] }
export interface ReferenceSpec { tables: ReferenceTable[]; notes?: string[] }

// Persisted to tax_tasks.worksheet (jsonb).
export interface WorksheetData {
  fields: Record<string, number | string | null>;  // field key -> value
  warnings?: string[];                               // e.g. reconciliation flag
  meta?: Record<string, unknown>;                    // { computedAt, provenance }
}

export interface TaxSchedule {
  id: string; party_key: string; frequency: Frequency;
  lead_days: number; active: boolean; config: Record<string, unknown>;
  created_at: string; updated_at: string;
}
export interface TaxTask {
  id: string; schedule_id: string; party_key: string;
  period_start: string; period_end: string; due_date: string;
  status: TaxTaskStatus; alert_sent_at: string | null;
  worksheet: WorksheetData | null;
  confirmation_number: string | null; amount_paid_cents: number | null;
  submitted_on: string | null; notes: string | null;
  completed_at: string | null; completed_by: string | null;
  created_at: string; updated_at: string;
}
export type TaxFilingProfileValues = Record<string, string>;

export interface ComputeContext {
  schedule: TaxSchedule;
  profile: TaxFilingProfileValues;
  period: TaxPeriod;
}
export interface TaxPartyTemplate {
  key: string;
  label: string;
  supportedFrequencies: Frequency[];
  computePeriod(freq: Frequency, ref: Date): TaxPeriod;
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;
  fieldOwnership: Record<string, FieldOwnership>;
  mergeWorksheet(current: WorksheetData, recomputed: WorksheetData): WorksheetData;
  settingsSchema: FieldSpec[];         // profile-level editable fields
  scheduleConfigSchema: FieldSpec[];   // schedule.config editable fields (counties)
  referenceView: ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;          // registry key for the React worksheet
}
```

NC DOR shapes (Task 9/10/11):
```ts
// tax_schedules.config for "nc_dor_sales_use"
interface NcDorConfig { counties: { code: string; weight: number }[] } // weights sum to 100
// tax_filing_profiles.values for "nc_dor_sales_use"
// { contact_name, contact_email, contact_phone, account_id, fein, ssn?, general_sales_tax_id }
```

---

## Task Summary & Model Assignments

| # | Task | Model | Depends on |
|---|------|-------|-----------|
| 1 | Migration: `pos_line_item_taxes` | Haiku | — |
| 2 | Persist applied taxes in POS sync (+ types/fetch) | Sonnet | 1 |
| 3 | Backfill route for `pos_line_item_taxes` | Sonnet | 2 |
| 4 | Migration: `tax_schedules`/`tax_tasks`/`tax_filing_profiles`/`tax_task_files` + Storage bucket | Sonnet | — |
| 5 | `lib/tax/types.ts` contracts | Haiku | — |
| 6 | `lib/tax/period.ts` (generic period math) | Sonnet | 5 |
| 7 | `lib/tax/registry.ts` | Haiku | 5 |
| 8 | `lib/tax/schedules.ts` + `tasks.ts` orchestration | Sonnet | 5,6,7 |
| 9 | NC DOR `rates.ts` constants + counties | Haiku | 5 |
| 10 | NC DOR `calc.ts` (pure figures + Square pull) | Opus | 5,9,2 |
| 11 | NC DOR `template.ts` + register | Sonnet | 5,6,7,9,10 |
| 12 | API routes: profiles/schedules/tasks CRUD + compute/recompute | Sonnet | 8,11 |
| 13 | API routes: file upload/download (Storage) | Sonnet | 4,12 |
| 14 | Cron `tax-tasks` + `vercel.json` + Resend email | Sonnet | 8,11 |
| 15 | Finance nav + Tax tab list (status badges) | Sonnet | 12 |
| 16 | Schedule editor modal | Sonnet | 11,12 |
| 17 | Worksheet shell + NC DOR worksheet component (autosave + recompute) | Sonnet | 12 |
| 18 | Complete/upload flow | Sonnet | 13,17 |
| 19 | Settings "Tax Filing" subtab (identity + disclosure) | Sonnet | 11,12 |
| 20 | Final whole-branch review | Opus | all |

Group by locality when executing: Tasks 1–3 (POS sync) → one agent; 5–8 (engine) → one agent; 9–11 (NC DOR module) → one agent; 12–14 (API/cron) → one agent; 15–19 (UI) → grouped by adjacent files.

---

## Phase 1 — Data layer

### Task 1: Migration — `pos_line_item_taxes`

**Files:**
- Create: `supabase/migrations/20260711_pos_line_item_taxes.sql`

**Interfaces:**
- Produces: table `pos_line_item_taxes (id uuid pk default gen_random_uuid(), line_item_id uuid not null references pos_line_items(id) on delete cascade, square_tax_id text not null, tax_name text, tax_pct numeric, amount_cents integer not null default 0, created_at timestamptz default now())`; index on `line_item_id`; index on `square_tax_id`.

- [ ] **Step 1:** Read the two most recent `supabase/migrations/*.sql` for column-comment + RLS conventions; confirm `pos_line_items` PK name/type via `grep -rn "create table.*pos_line_items" supabase/migrations`.
- [ ] **Step 2:** Write the migration: table above + both indexes. Add `comment on column pos_line_item_taxes.amount_cents is 'tax applied to this line by this tax, in cents'`. Enable RLS with the same service-role-only posture as sibling finance tables (mirror the policy block from `20260709_enable_rls_phase1.sql` for a service-role-only table).
- [ ] **Step 3:** Verify SQL parses locally (dry review — no prod apply). Run `npm run verify` (no code touched; ensures repo still builds).
- [ ] **Step 4:** Commit: `feat(tax): add pos_line_item_taxes migration`.

**Acceptance:** migration file exists, references `pos_line_items` with cascade delete, RLS matches finance service-role-only pattern. NOT applied to prod (human-gated).

---

### Task 2: Persist per-line applied taxes in POS sync

**Files:**
- Modify: `types/square.ts` (add `applied_taxes` to `OrderLineItem`, `taxes` to `Order`)
- Modify: `lib/square/orders.ts` (ensure Search/Batch orders return applied taxes)
- Modify: `lib/finance/syncPosTransactions.ts` (build + upsert `pos_line_item_taxes` rows)
- Modify/Create test: `lib/finance/syncPosTransactions.test.ts`

**Interfaces:**
- Consumes: `pos_line_item_taxes` schema (Task 1).
- Produces:
  - `types/square.ts`: `OrderAppliedTax { uid: string; tax_uid: string; applied_money?: Money }`; `OrderLineItem.applied_taxes?: OrderAppliedTax[]`; `OrderTax { uid: string; catalog_object_id?: string; name?: string; percentage?: string; type?: string }`; `Order.taxes?: OrderTax[]`.
  - `syncPosTransactions.ts`: exported pure helper `buildLineItemTaxRows(order: Order, lineItemDbIdByUid: Map<string,string>): PosLineItemTaxRow[]` where `PosLineItemTaxRow = { line_item_id: string; square_tax_id: string; tax_name: string | null; tax_pct: number | null; amount_cents: number }`. Resolves each line's `applied_taxes[].tax_uid` → the order's `taxes[]` entry (for `catalog_object_id`=`square_tax_id`, `name`, `percentage`) and `applied_money.amount`=`amount_cents`.

- [ ] **Step 1 (test-first):** Add test `buildLineItemTaxRows maps applied_taxes to catalog tax ids` — fixture order with `taxes:[{uid:"t1",catalog_object_id:"TAX_GEN",name:"General Sales Tax",percentage:"7.25"}]` and a line with `applied_taxes:[{uid:"at1",tax_uid:"t1",applied_money:{amount:725}}]`; assert one row `{square_tax_id:"TAX_GEN",tax_name:"General Sales Tax",tax_pct:7.25,amount_cents:725}`. Add a second test: a line with two applied taxes → two rows; a line with none → zero rows.
- [ ] **Step 2:** Run `npx vitest run lib/finance/syncPosTransactions.test.ts` → FAIL (helper undefined).
- [ ] **Step 3:** Add the type additions to `types/square.ts`. Confirm SearchOrders/BatchRetrieve responses include `applied_taxes`/`taxes` by default (they do at v2025-04-16); no request-body change needed unless a `return_entries`/field mask is set — verify in `lib/square/orders.ts` and add nothing if already full-entity.
- [ ] **Step 4:** Implement `buildLineItemTaxRows`. In the sync's insert path, after `pos_line_items` are inserted and their db ids known, build tax rows and insert into `pos_line_item_taxes` in the same batched manner as line items (delete-by-order-id already cascades on line-item delete — confirm cascade covers re-sync; if line items are deleted+reinserted, the cascade removes stale tax rows automatically).
- [ ] **Step 5:** Run the test file → PASS. Run `npm run verify`.
- [ ] **Step 6:** Commit: `feat(tax): persist per-line Square applied taxes in POS sync`.

**Acceptance:** re-syncing an order replaces its tax rows idempotently; mixed orders yield per-line, per-tax rows; existing sync tests still pass.

---

### Task 3: Backfill route for `pos_line_item_taxes`

**Files:**
- Create: `app/api/tax/backfill-line-item-taxes/route.ts`
- Create: `lib/tax/backfillLineItemTaxes.ts` + test

**Interfaces:**
- Consumes: `buildLineItemTaxRows` (Task 2), `fetchOrdersByIds`/`fetchCompletedOrders` (`lib/square/orders.ts`), admin client.
- Produces: `backfillLineItemTaxesForRange(supabase, startDate, endDate): Promise<{ orders: number; taxRows: number }>` — for each existing `pos_line_items` order in range, re-fetch the Square order, rebuild tax rows, and upsert (delete-existing-for-line then insert). Route: `GET` guarded by `Bearer ${CRON_SECRET}` OR admin session; params `start`/`end` via manual parse; errors via `apiError()`.

- [ ] **Step 1 (test-first):** Test `backfillLineItemTaxesForRange inserts rows for taxed lines` with a stubbed supabase + one order fixture; assert returned `taxRows` count and that insert was called with mapped rows. Mock Square fetch.
- [ ] **Step 2:** Run test → FAIL.
- [ ] **Step 3:** Implement `backfillLineItemTaxes.ts` (pure orchestration over injected supabase + fetch fn for testability) and the thin route handler.
- [ ] **Step 4:** Run test → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): backfill route for pos_line_item_taxes`.

**Acceptance:** callable per date range; idempotent; admin- or cron-guarded. (Run against prod is human-gated, post-merge.)

---

### Task 4: Migration — tax module tables + Storage bucket

**Files:**
- Create: `supabase/migrations/20260711_tax_module.sql`

**Interfaces:**
- Produces (all service-role-only RLS, matching finance posture):
  - `tax_schedules (id uuid pk, party_key text not null, frequency text not null check (frequency in ('monthly','quarterly','annual')), lead_days int not null default 7, active boolean not null default true, config jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now())`
  - `tax_filing_profiles (party_key text primary key, values jsonb not null default '{}', updated_at timestamptz default now())`
  - `tax_tasks (id uuid pk, schedule_id uuid not null references tax_schedules(id) on delete cascade, party_key text not null, period_start date not null, period_end date not null, due_date date not null, status text not null default 'open' check (status in ('open','completed','skipped')), alert_sent_at timestamptz, worksheet jsonb, confirmation_number text, amount_paid_cents int, submitted_on date, notes text, completed_at timestamptz, completed_by uuid, created_at timestamptz default now(), updated_at timestamptz default now(), unique (schedule_id, period_end))`
  - `tax_task_files (id uuid pk, task_id uuid not null references tax_tasks(id) on delete cascade, storage_path text not null, file_name text not null, label text, uploaded_at timestamptz default now(), uploaded_by uuid)`
  - Private Storage bucket `tax-confirmations` via `insert into storage.buckets (id, name, public) values ('tax-confirmations','tax-confirmations', false) on conflict do nothing;`
  - Index `tax_tasks(status, due_date)`; index `tax_tasks(schedule_id)`.

- [ ] **Step 1:** Read latest migrations for RLS/service-role policy block + column-comment style.
- [ ] **Step 2:** Write the migration with all four tables, indexes, checks, unique constraint, RLS blocks, and the bucket insert.
- [ ] **Step 3:** `npm run verify` (repo still builds). SQL dry-reviewed, not prod-applied.
- [ ] **Step 4:** Commit: `feat(tax): tax module tables + storage bucket migration`.

**Acceptance:** all tables/constraints/bucket present; `unique(schedule_id, period_end)` enforced; RLS service-role-only.

---

## Phase 2 — Shared engine (`lib/tax/`)

### Task 5: Type contracts

**Files:**
- Create: `lib/tax/types.ts`

**Interfaces:**
- Produces: every type in the "Canonical Type Contracts" block above, verbatim.

- [ ] **Step 1:** Create `lib/tax/types.ts` with the canonical contracts exactly as specified (no logic → no test file; types are exercised by consumers' tests).
- [ ] **Step 2:** `npx tsc --noEmit` (via `npm run verify`) → PASS.
- [ ] **Step 3:** Commit: `feat(tax): shared type contracts`.

**Acceptance:** compiles; names/types match the canonical block used by all later tasks.

---

### Task 6: Generic period math

**Files:**
- Create: `lib/tax/period.ts` + `lib/tax/period.test.ts`

**Interfaces:**
- Consumes: `Frequency`, `TaxPeriod` (Task 5); brewery timezone helpers (`lib/utils/datetime`) for local-day boundaries.
- Produces:
  - `monthPeriod(ref: Date): { start: string; end: string }` — first/last local day of ref's month.
  - `quarterPeriod(ref: Date): { start: string; end: string }`
  - `yearPeriod(ref: Date): { start: string; end: string }`
  - `periodContaining(freq: Frequency, ref: Date): { start: string; end: string }` — dispatch.
  - `lastDayOfFollowingMonth(end: string): string` (helper for due dates).
  - `addDaysIso(iso: string, days: number): string`.

- [ ] **Step 1 (test-first):** Tests: `monthPeriod(2026-06-15) → {start:'2026-06-01',end:'2026-06-30'}`; `quarterPeriod(2026-05-10) → Q2 {'2026-04-01','2026-06-30'}`; `lastDayOfFollowingMonth('2026-06-30') → '2026-07-31'`; `addDaysIso('2026-07-20',-7) → '2026-07-13'`. Include a year-boundary case (`monthPeriod(2026-12-05).end==='2026-12-31'`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement using date-only arithmetic (no TZ drift — operate on YYYY-MM-DD strings / UTC-noon dates).
- [ ] **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): generic tax period math`.

**Acceptance:** all frequencies + boundary cases correct; pure, no I/O.

---

### Task 7: Party registry

**Files:**
- Create: `lib/tax/registry.ts` + `lib/tax/registry.test.ts`

**Interfaces:**
- Consumes: `TaxPartyTemplate` (Task 5).
- Produces: `registerParty(t: TaxPartyTemplate): void`; `getParty(key: string): TaxPartyTemplate` (throws on unknown); `listParties(): TaxPartyTemplate[]`. Internal `Map<string, TaxPartyTemplate>`.

- [ ] **Step 1 (test-first):** Test: register a stub template, `getParty(key)` returns it; `getParty('nope')` throws; `listParties()` includes it.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): party template registry`.

**Acceptance:** register/get/list work; unknown key throws a clear error.

---

### Task 8: Schedule + task orchestration

**Files:**
- Create: `lib/tax/schedules.ts`, `lib/tax/tasks.ts` + tests
- Consumes: registry (7), period (6), admin client, `getParty`.

**Interfaces:**
- Produces:
  - `schedules.ts`: `listSchedules(sb)`, `createSchedule(sb, input)`, `updateSchedule(sb, id, patch)`, `setScheduleActive(sb, id, active)` — thin DB ops returning `TaxSchedule`.
  - `tasks.ts` (pure core + DB wrapper):
    - `dueDateFor(party: TaxPartyTemplate, freq, periodEnd: string): string` — delegates to `party.computePeriod`.
    - `periodsNeedingTasks(freq, today: Date, lookbackDays: number, party): TaxPeriod[]` — distinct periods whose `end < today` within lookback and not future. Pure.
    - `ensureTasksForSchedule(sb, schedule): Promise<{ created: number }>` — upsert (idempotent on `unique(schedule_id, period_end)`) for each period from `periodsNeedingTasks`.
    - `tasksNeedingAlert(sb, today: Date): Promise<TaxTask[]>` — open tasks where `today >= due_date - lead_days` (join schedule for lead_days) and `alert_sent_at is null`.
    - `markAlerted(sb, taskId)`, `getTask(sb, id)`, `listTasks(sb, filter)`, `saveWorksheet(sb, id, WorksheetData)`, `completeTask(sb, id, { confirmation_number, amount_paid_cents, submitted_on, notes, userId })`.

- [ ] **Step 1 (test-first):** `periodsNeedingTasks` — monthly, today=2026-07-05, lookback=45 → includes June (end 2026-06-30) and May, excludes July (not ended). Assert exact period list. Test `dueDateFor` monthly June → `2026-07-20` (via a stub party whose `computePeriod` returns the NC rule) — or defer due-rule assertion to Task 11 and here assert `dueDateFor` delegates to the party.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement pure fns; DB wrappers use injected `sb`. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): schedule + task orchestration`.

**Acceptance:** `ensureTasksForSchedule` idempotent; alert query respects per-schedule `lead_days`; pure period-selection tested independent of DB.

---

## Phase 3 — NC DOR party module (`lib/tax/parties/ncDorSalesUse/`)

### Task 9: Rates + counties constants

**Files:**
- Create: `lib/tax/parties/ncDorSalesUse/rates.ts` + test

**Interfaces:**
- Produces:
  - `NC_STATE_RATE = 0.0475`.
  - `interface CountyTier { local: number; transit: number }` (decimals, e.g. `{local:0.02, transit:0.005}`).
  - **County code convention:** the internal `code` is the uppercased county name (e.g. `"WAKE"`, `"NEW_HANOVER"`) — used everywhere (tiers, schedule config, worksheet field keys). The NC DOR numeric schedule code (Alamance=1…) is carried separately as `ncCode` for display/ordering only.
  - `NC_COUNTY_TIERS: Record<string, CountyTier>` — every NC county keyed by `code` (uppercased name), tier from the spec chart: base `{local:0.02,transit:0}`; the 2.25% list `{local:0.0225,transit:0}`; Mecklenburg & Wake `{local:0.02,transit:0.005}`; Durham & Orange `{local:0.0225,transit:0.005}`.
  - `NC_COUNTIES: { code: string; name: string; ncCode: number }[]` — the 100 counties; `code`=uppercased name, `name`=display name, `ncCode`=numeric code from the county-schedule image (Alamance=1 … in order).
  - `countyRateLine(tier: CountyTier): '9'|'10'` — 0.02→line 9, 0.0225→line 10.
  - `transitRateLine(tier: CountyTier): '11'|'12'|null` — 0.005→line 11, 0.0025→line 12, 0→null.

- [ ] **Step 1 (test-first):** Assert `NC_COUNTY_TIERS['WAKE']` = `{local:0.02,transit:0.005}`; `['DURHAM']` = `{local:0.0225,transit:0.005}`; `['ALAMANCE']` = `{local:0.02,transit:0}`; `NC_COUNTIES.length === 100`; `countyRateLine({local:0.0225,transit:0})==='10'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Populate constants from the spec chart + county-list image. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): NC DOR statutory rates + county tiers`.

**Acceptance:** every county mapped to correct tier; Wake/Durham/Orange/Mecklenburg special tiers correct; codes match NC DOR schedule ordering.

---

### Task 10: NC DOR calc (pure figures + Square pull)

**Files:**
- Create: `lib/tax/parties/ncDorSalesUse/calc.ts` + `calc.test.ts`

**Interfaces:**
- Consumes: `rates.ts` (9), `WorksheetData`/`ComputeContext` (5), admin client, `pos_line_item_taxes` (2).
- Produces:
  - Pure core `computeNcDorFigures(args: { taxableBaseCents: number; counties: { code: string; weight: number }[]; collectedGeneralTaxCents: number }): WorksheetData` — computes all worksheet field values (below), routing each county split to its tier's page-1 rate/transit lines and page-2 county rows; sets `warnings` with a reconciliation message when `|Σ computed county+transit+state ... |` vs `collectedGeneralTaxCents` differ beyond a 1-cent-per-line tolerance. (Reconciliation compares computed **total** tax on the base against Square-collected tax on the same lines.)
  - `fetchTaxableBase(sb, generalSalesTaxId: string, period: TaxPeriod): Promise<{ baseCents: number; collectedCents: number }>` — SQL join `pos_line_item_taxes` → `pos_line_items` for lines in the period carrying `square_tax_id = generalSalesTaxId`; `baseCents = Σ(line total_money_cents − line tax_cents_for_that_line)` (base = pre-tax receipts; see note), `collectedCents = Σ amount_cents`.
  - `computeNcDorWorksheet(ctx: ComputeContext): Promise<WorksheetData>` — reads config counties + `general_sales_tax_id` from ctx, calls `fetchTaxableBase`, then `computeNcDorFigures`.

**Worksheet field keys** (`WorksheetData.fields`): `line1_gross_receipts`, `line2_sales_for_resale`, `line3_exempt`, and per rate line N∈{4,5,6,7,8,9,10,11,12}: `lineN_purchases`, `lineN_receipts`, `lineN_tax`; `line13_total`, `line14_excess`, `line15_total`, `line16_penalty`, `line17_interest`, `line18_less_prepay`, `line19_prepay_next`, `line20_credit`, `line20_credit_explanation`, `line21_total_due`; per selected county code C: `county_${C}_2pct`, `county_${C}_225pct`, `county_${C}_transit`. All monetary values in cents.

**Base note:** `total_money − total_tax` per line = post-discount pre-tax receipts. `pos_line_items` stores `tax_cents` as the line's *total* tax across all taxes; when only General Sales Tax applies to a line, `base = total_money_cents − tax_cents`. When multiple taxes apply, subtract the line's full tax to get the pre-tax base (the base is shared across co-applied taxes). Implement base as `total_money_cents − tax_cents` for lines that carry the general-sales tax id.

- [ ] **Step 1 (test-first):** Golden tests on `computeNcDorFigures`:
  - Single county Wake, `base=100000` (¢), `collected=7250`: `line1_gross_receipts=100000`; `line4_receipts=100000`, `line4_tax=4750`; `line9_receipts=100000`, `line9_tax=2000`; `line11_tax=500`; `line13_total=7250`; `line15_total=7250`; `line21_total_due=7250`; `county_WAKE_2pct=2000`, `county_WAKE_transit=500`; no warning.
  - Two counties (Wake 50 / Durham 50), `base=100000`: Wake split→L9/L11, Durham split→L10/L12? (Durham transit 0.5%→L11). Assert L9_tax=1000 (Wake 2% on 50000), L10_tax=1125 (Durham 2.25% on 50000), L11_tax = 250+250=500 (both transit 0.5%), county rows populated, Σ county entries = L9+L10 (+transit).
  - Reconciliation warning when `collected` deviates > tolerance from computed total.
  - `line21` responds to manual fields is NOT tested here (manual fields default 0 in compute; recompute merge tested in Task 11).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement pure core, then `fetchTaxableBase` (test with stubbed sb returning fixture rows), then `computeNcDorWorksheet`. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): NC DOR sales & use tax calc`.

**Acceptance:** single- and multi-county splits produce correct page-1 lines + page-2 county rows; totals mirror form arithmetic; reconciliation flag fires on divergence; base excludes tax and tips.

---

### Task 11: NC DOR template + registration

**Files:**
- Create: `lib/tax/parties/ncDorSalesUse/template.ts` + test
- Create: `lib/tax/parties/index.ts` (imports each party module for side-effect registration)
- Modify: wherever the registry is first consumed (API/cron), ensure `import "@/lib/tax/parties"`.

**Interfaces:**
- Consumes: `TaxPartyTemplate` (5), period helpers (6), `registerParty` (7), rates (9), calc (10).
- Produces: `ncDorSalesUseTemplate: TaxPartyTemplate` with:
  - `key:"nc_dor_sales_use"`, `label:"NC DOR — Sales & Use Tax"`, `supportedFrequencies:["monthly","quarterly"]`.
  - `computePeriod(freq, ref)`: monthly → `{start,end}=monthPeriod(ref)`, `due=addDaysIso... ` no — `due = '20th of following month'` (monthly) / `lastDayOfFollowingMonth(end)` (quarterly). Implement monthly due as `YYYY-MM-20` of month after `end`.
  - `computeWorksheet = computeNcDorWorksheet`.
  - `fieldOwnership`: `line1`, all `lineN_receipts`, `lineN_tax` (N in active rate lines), `line13_total`, `line15_total`, `line21_total_due`, and every `county_*` → `computed`; `line2/3`, all `lineN_purchases`, `line14/16/17/18/19/20*` → `manual`.
  - `mergeWorksheet(current, recomputed)`: for each key, `ownership==='computed' ? recomputed : (current ?? recomputed)`; then re-derive dependent totals (`line13/15/21`) from the merged field set so manual penalty/interest/credit flow into `line21`. (Totals recomputation helper shared with calc.)
  - `settingsSchema`: contact_name/email/phone, account_id, fein (required), ssn (sensitive, optional), general_sales_tax_id (select — options fetched from Square catalog taxes at render; schema marks it `type:"select"`).
  - `scheduleConfigSchema`: counties multi-select with per-county weight.
  - `referenceView`: tables for state rate + county tier chart + period/due rules (from `rates.ts`).
  - `recomputeLabel:"Recompute from Square"`, `worksheetComponent:"nc_dor_sales_use"`.
  - Calls `registerParty(ncDorSalesUseTemplate)` at module load.

- [ ] **Step 1 (test-first):** `computePeriod('monthly', 2026-06-15)` → `{start:'2026-06-01',end:'2026-06-30',due:'2026-07-20'}`; quarterly Q2 → `due:'2026-07-31'`. `mergeWorksheet` preserves a manual `line16_penalty` while overwriting `line1_gross_receipts`, and `line21_total_due` reflects the manual penalty. `getParty('nc_dor_sales_use')` returns the template after importing `parties/index`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement template + index. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): NC DOR template + registry wiring`.

**Acceptance:** period/due rules correct; merge preserves manual + re-derives totals; template registered and retrievable.

---

## Phase 4 — API + cron

### Task 12: API routes — profiles / schedules / tasks / compute

**Files:**
- Create: `app/api/tax/profiles/[party]/route.ts` (GET non-sensitive view / PUT admin)
- Create: `app/api/tax/schedules/route.ts` (GET list, POST create), `app/api/tax/schedules/[id]/route.ts` (PATCH, DELETE→deactivate)
- Create: `app/api/tax/tasks/route.ts` (GET list w/ filter), `app/api/tax/tasks/[id]/route.ts` (GET one, PATCH worksheet autosave), `app/api/tax/tasks/[id]/recompute/route.ts` (POST), `app/api/tax/tasks/[id]/complete/route.ts` (POST)
- Create: `app/api/tax/parties/route.ts` (GET registry metadata: key/label/frequencies/schemas/referenceView)

**Interfaces:**
- Consumes: `lib/tax/schedules.ts`, `tasks.ts`, `getParty`/`listParties`, `getSessionUser`, `apiError`, admin client, `import "@/lib/tax/parties"`.
- Produces: JSON per route. Profile GET **strips `sensitive` fields** (SSN/FEIN) from `values` — returns masked (`"present"`/`"absent"`) status, never the value, to the browser. Recompute route loads task+schedule+profile, calls `party.computeWorksheet`, `party.mergeWorksheet(current, recomputed)`, saves, returns worksheet. Complete route enforces manager+.

- [ ] **Step 1 (test-first):** Where pure logic exists (e.g. `maskSensitive(values, schema)` helper in `lib/tax/profiles.ts`), test it: sensitive keys → masked. Route handlers themselves are thin; assert via a `lib/tax/profiles.test.ts` for the masking helper.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `lib/tax/profiles.ts` (get/put + `maskSensitive`) and all route handlers (thin; delegate to lib; `apiError` wrapping; role checks). **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): tax module API routes`.

**Acceptance:** CRUD works; sensitive profile fields never leave the server unmasked; recompute applies merge policy; complete is manager-gated.

---

### Task 13: API routes — file upload / download (Storage)

**Files:**
- Create: `app/api/tax/tasks/[id]/files/route.ts` (POST upload → `tax_task_files` + Storage; GET list), `app/api/tax/tasks/[id]/files/[fileId]/route.ts` (GET signed URL, DELETE)
- Create: `lib/tax/files.ts` + test

**Interfaces:**
- Consumes: admin client Storage API, `tax_task_files` (4).
- Produces: `uploadTaskFile(sb, taskId, { file, fileName, label, userId }): Promise<TaxTaskFile>` (path `${taskId}/${crypto.randomUUID()}-${fileName}`); `listTaskFiles(sb, taskId)`; `signedUrlForFile(sb, fileId): Promise<string>`; `deleteTaskFile(sb, fileId)`. `TaxTaskFile` type added to `lib/tax/types.ts`.

- [ ] **Step 1 (test-first):** Test `uploadTaskFile` builds the storage path + inserts a row (stubbed sb Storage + table). Test `deleteTaskFile` removes storage object then row.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement lib + routes (multipart parse per Next 16 conventions; manager+). **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): task confirmation file upload/download`.

**Acceptance:** multiple labeled files per task; download via signed URL only (private bucket); delete cleans storage + row.

---

### Task 14: Cron `tax-tasks` + schedule + email

**Files:**
- Create: `app/api/cron/tax-tasks/route.ts`
- Create: `lib/tax/alertEmail.ts` + test
- Modify: `vercel.json` (add cron entry)

**Interfaces:**
- Consumes: `runCronJob` (`lib/cron/runCronJob`), `listSchedules`+`ensureTasksForSchedule`+`tasksNeedingAlert`+`markAlerted` (8), `sendEmail`+`ADMIN_EMAIL` (`lib/resend`), `getParty`.
- Produces: cron GET guarded by `Bearer ${CRON_SECRET}`; per active schedule → `ensureTasksForSchedule`; then `tasksNeedingAlert` → `renderTaxAlertEmail(task, party, schedule): { subject: string; html: string }` → `sendEmail(ADMIN_EMAIL, ...)` → `markAlerted`. Summary returned into `cron_runs.detail`. `vercel.json` entry: `{ "path": "/api/cron/tax-tasks", "schedule": "0 8 * * *" }`.

- [ ] **Step 1 (test-first):** Test `renderTaxAlertEmail` → subject contains party label + due date; html contains period + due + a link path `/finance/tax/<taskId>`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement email renderer + cron route + `vercel.json` entry. **Step 4:** Run → PASS; `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): tax-tasks cron + lead-time alert email`.

**Acceptance:** idempotent task creation; one email per task at `due − lead_days`; monitored via `cron_runs`.

---

## Phase 5 — UI (`app/finance/tax/`, settings)

### Task 15: Finance nav + Tax tab list

**Files:**
- Modify: `app/finance/nav-config.ts` (add `{ href:"/finance/tax", match:"/finance/tax", label:"Tax" }`)
- Create: `app/finance/tax/page.tsx`, `app/finance/tax/TaxNav.tsx` (if subnav needed), `app/finance/tax/TaskList.tsx`, `app/finance/tax/hooks/useTaxData.ts`

**Interfaces:**
- Consumes: `/api/tax/tasks`, `/api/tax/schedules`. Uses `<PageHeader>`, `<Card>`, `<Badge tone>`, existing table controls per search/filter/sort standard.
- Produces: list of tasks grouped open/upcoming/completed; each row shows party label, period ending, due date, status `<Badge>` (overdue=danger, due-soon=info/warning, completed=success — via tokens), link to `/finance/tax/[taskId]`. Due-soon/overdue derived client-side from `due_date` + schedule `lead_days`.

- [ ] **Step 1:** Add nav entry; build `useTaxData` (fetch tasks + schedules). **Step 2:** Build `TaskList` with status badges + links using UI primitives (no raw colors). **Step 3:** Verify in browser preview (Tax tab renders, empty state OK). **Step 4:** `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): Finance Tax tab + task list`.

**Acceptance:** Tax tab appears in Finance nav; tasks list with correct status tones; rows link to the workspace. Docs-light UI task → skip per-task deep review only if config-only (this is not — include review).

---

### Task 16: Schedule editor modal

**Files:**
- Create: `app/finance/tax/ScheduleEditor.tsx`, `app/finance/tax/ScheduleList.tsx`

**Interfaces:**
- Consumes: `/api/tax/parties` (schemas), `/api/tax/schedules`. `<Modal>/<ModalActions>/<Field>`, `.inp`/`.inp-sm`, `.btn-*`.
- Produces: create/edit schedule — party select, frequency select (limited to party `supportedFrequencies`), lead_days, and `scheduleConfigSchema`-driven fields (NC DOR: county multi-select + per-county weight with a sum=100 validation). Renders party `settingsSchema` link to settings for identity.

- [ ] **Step 1:** Build config-schema-driven form (renders `scheduleConfigSchema` generically). **Step 2:** County multi-select + weight inputs + client validation (weights sum 100). **Step 3:** Wire create/PATCH; browser-verify create + edit. **Step 4:** `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): tax schedule editor`.

**Acceptance:** can create/edit/deactivate a schedule; county weights validated; frequency options driven by party template.

---

### Task 17: Worksheet shell + NC DOR worksheet

**Files:**
- Create: `app/finance/tax/[taskId]/page.tsx`, `app/finance/tax/[taskId]/TaxWorksheetShell.tsx`, `app/finance/tax/parties/NcDorSalesUse/Worksheet.tsx`, `app/finance/tax/parties/registry.ts` (component key → component)

**Interfaces:**
- Consumes: `/api/tax/tasks/[id]` (GET/PATCH autosave), `/api/tax/tasks/[id]/recompute`, `/api/tax/profiles/[party]` (masked identity display). `<PageHeader>`, `<Card>`, `<Banner>` (reconciliation warnings), `.inp-sm`, `.btn-*`.
- Produces:
  - `TaxWorksheetShell` — read-only filing identity header, `worksheet.warnings` in a `<Banner>`, recompute button (`recomputeLabel`), a debounced autosave (PATCH worksheet) on field change, totals footer, "Continue to Complete" action. Selects the party worksheet via `app/finance/tax/parties/registry.ts` using `worksheetComponent`.
  - `NcDorSalesUse/Worksheet.tsx` — renders the NC DOR form: Line 1–21 with computed fields read-only-styled (but overridable per `fieldOwnership` — computed shown, manual editable), plus the page-2 county schedule table. Live totals recompute client-side mirroring `line13/15/21` so edits reflect instantly (server is source of truth on save).

- [ ] **Step 1:** Build the component registry + shell (identity header, banner, autosave, recompute). **Step 2:** Build NC DOR worksheet form mirroring the two form pages using tokens/primitives (data-entry table = allowed structured layout; no raw colors). **Step 3:** Browser-verify: open a task (seed one via API), figures prefill, edit a manual field → total updates + autosaves, recompute button repulls. **Step 4:** `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): tax worksheet shell + NC DOR worksheet`.

**Acceptance:** worksheet prefills from compute, manual fields editable, totals live, recompute preserves manual entries, autosave persists, reconciliation warning shows when present.

---

### Task 18: Complete / upload flow

**Files:**
- Create: `app/finance/tax/[taskId]/CompletePanel.tsx`, `app/finance/tax/[taskId]/FileUploader.tsx`

**Interfaces:**
- Consumes: `/api/tax/tasks/[id]/complete`, `/api/tax/tasks/[id]/files` (+ `[fileId]`). `<Modal>` or inline `<Card>`, `<Field>`, `.btn-primary`.
- Produces: confirmation form (confirmation_number, amount_paid, submitted_on, notes) + free-form multi-file uploader (add file → type label → upload; list with download/delete). "Mark Submitted" → complete → task shows completed; files listed on the task afterward.

- [ ] **Step 1:** Build `FileUploader` (free-form label per file). **Step 2:** Build `CompletePanel` + wire complete. **Step 3:** Browser-verify: upload two labeled files, complete task, confirm status flips + files downloadable. **Step 4:** `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): task completion + confirmation uploads`.

**Acceptance:** any number of labeled files; complete flips status + records confirmation; completed task read-only with downloadable files.

---

### Task 19: Settings — Tax Filing subtab

**Files:**
- Modify: `app/finance/settings/SettingsNav.tsx` (add `{ href:"/finance/settings/tax-filing", label:"Tax Filing" }`)
- Create: `app/finance/settings/tax-filing/page.tsx`, `IdentityForm.tsx`, `ReferenceDisclosure.tsx`

**Interfaces:**
- Consumes: `/api/tax/profiles/[party]` (GET masked / PUT), `/api/tax/parties` (settingsSchema + referenceView), Square catalog taxes for the general-sales-tax select (`lib/square/catalog.ts`).
- Produces: per-party identity form (renders `settingsSchema`; SSN/FEIN inputs write-only — masked on load, blank means "unchanged"); `ReferenceDisclosure` renders `referenceView.tables` (state rate, county tier chart, period/due rules) read-only so the user audits the calc inputs. General-sales-tax field is a select populated from Square catalog taxes.

- [ ] **Step 1:** Add nav entry; build `IdentityForm` (schema-driven; sensitive fields write-only). **Step 2:** Build `ReferenceDisclosure` (renders reference tables). **Step 3:** Browser-verify: save identity, sensitive value not echoed back; disclosure shows Wake tier + rates. **Step 4:** `npm run verify`.
- [ ] **Step 5:** Commit: `feat(tax): Tax Filing settings (identity + reference disclosure)`.

**Acceptance:** identity persists; sensitive fields never re-displayed; reference tables match `rates.ts`; general-sales-tax id selectable from Square taxes.

---

### Task 20: Final whole-branch review

- [ ] **Step 1:** Run `npm run verify` on the full branch → all green.
- [ ] **Step 2:** Opus whole-branch review (superpowers:requesting-code-review) covering: calc correctness (multi-county, reconciliation), sensitive-data handling (SSN/FEIN never to browser), RLS/service-role usage, idempotency (cron + sync), UI token/primitive compliance, Next 16 route conventions.
- [ ] **Step 3:** Address findings; re-verify.
- [ ] **Step 4:** Summarize human-gated post-merge steps: apply migrations `20260711_pos_line_item_taxes` + `20260711_tax_module` to prod; run `pos_line_item_taxes` backfill for the target tax year; create the Storage bucket if the migration path didn't; set up the first NC DOR schedule + identity profile; confirm `CRON_SECRET` + `RESEND_API_KEY` in Vercel.

**Acceptance:** branch green; review findings resolved; post-merge runbook written.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** schedules (T8,16), cron auto-create + lead time (T14), per-party template calc (T10,11), party-agnostic engine + registry (T5–8), settings identity + disclosure (T19), storable identity surfaced in flow (T17 header, T19), gross-receipts = General-Sales-Taxed base excl. tax/tips (T10), 3-rate Wake + others 0 (T10), county schedule + multi-county (T10,16), completion + multi-file upload (T13,18), in-app + email alerts (T14,15), configurable-vs-statutory split (T9 constants vs T16/19 settings), reconciliation flag (T10,17), data persistence extension (T1–3), Storage first-use (T4,13). All covered.
- **Placeholder scan:** no TBD/TODO; each task has exact paths, signatures, and concrete test assertions.
- **Type consistency:** `WorksheetData`, `TaxPartyTemplate`, field keys (`lineN_*`, `county_${C}_*`), `computeNcDorFigures`/`computeNcDorWorksheet`/`fetchTaxableBase`, `ensureTasksForSchedule`/`tasksNeedingAlert`, `mergeWorksheet` used consistently across tasks. `TaxTaskFile` added in T13.
- **Scope:** single coherent module, phased; NC DOR only party implemented (framework general). No decomposition needed.
