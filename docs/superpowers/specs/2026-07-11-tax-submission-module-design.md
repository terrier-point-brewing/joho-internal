# Tax Submission Module — Design

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Feature area:** Finance → Tax (new subtab)

## 1. Purpose

A new module under the Finance tab that helps the user prepare and track monthly,
quarterly, and annual tax submissions to external receiving parties. It:

1. Lets the user create **tax schedules** (receiving party + frequency + payment
   timing).
2. Runs a **cron** that auto-creates a **tax task** per period with enough lead
   time to review and submit, and alerts the user (in-app + email).
3. **Auto-calculates** the return figures using a per-party template that encodes
   that receiving party's unique rate/logic, presenting them as an editable
   worksheet the user reviews, copies into the party's portal, then closes out
   with an optional confirmation upload.

The first concrete receiving party is **NC Department of Revenue — Sales & Use
Tax**. The framework is built so additional parties (e.g. NC DOR Withholding, TTB
Excise) drop in as self-contained party modules with no framework changes.

## 2. Architecture — party-template registry

Everything party-agnostic (schedules, task lifecycle, cron, alerts, period math,
completion/upload flow, worksheet chrome) lives in shared code. Everything unique
to a receiving party (rate logic, worksheet shape, period/due rules, settings
fields, data sources, recompute behavior) lives in a self-contained **party
module** that plugs into a common interface and is registered centrally.

### `lib/tax/` — shared engine
- `types.ts` — `TaxPartyTemplate` (the plug-in contract), `TaxSchedule`,
  `TaxTask`, worksheet/field types.
- `registry.ts` — party key (`"nc_dor_sales_use"`) → `TaxPartyTemplate`.
- `period.ts` — pure period math: given frequency + reference date, compute
  `periodStart`, `periodEnd` (period ending), `dueDate` via the party's rule.
- `schedules.ts` / `tasks.ts` — CRUD + "generate due tasks with lead time"
  orchestration the cron calls. Pure logic where possible; DB I/O thin.
- `parties/ncDorSalesUse/` — first concrete template (see §6).

### `app/finance/tax/` — UI
- `page.tsx` — Tax tab: list of open/upcoming/completed tasks with due-date
  status badges (overdue / due-soon tones). Schedule list + editor (modal) here.
- `[taskId]/` — task workspace: the editable worksheet + complete/upload flow.
- `parties/NcDorSalesUse/` — party-specific worksheet component, selected by the
  task's party key. Wrapped by a shared `<TaxWorksheetShell>` (header, read-only
  filing identity, totals footer, recompute + complete actions).

### `app/finance/settings/` — new "Tax Filing" subtab
Filing identity per party, party reference disclosure (read-only rate tables),
and (optionally) schedule management.

### `app/api/tax/**` + `app/api/cron/tax-tasks/`
Thin route handlers (logic in `lib/tax/`); the generator cron.

### `TaxPartyTemplate` contract (shape)
```ts
type Frequency = "monthly" | "quarterly" | "annual";

interface TaxPartyTemplate {
  key: string;                         // "nc_dor_sales_use"
  label: string;                       // "NC DOR — Sales & Use Tax"
  supportedFrequencies: Frequency[];   // ["monthly","quarterly"]

  // Period ending + due date for a given frequency and reference date.
  computePeriod(freq: Frequency, ref: Date): { start: string; end: string; due: string };

  // Party's sole authority on WHERE data comes from and HOW fields are derived.
  // Returns computed field values + provenance. May read Square, Supabase
  // tables, external systems — the framework does not know or care.
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;

  // Field-ownership: which worksheet fields are engine-computed vs user-manual.
  // Drives the generic Recompute merge policy (overwrite computed, preserve manual).
  fieldOwnership: Record<string, "computed" | "manual">;

  // User-editable settings (identity, county selection, Square tax id, lead days).
  settingsSchema: FieldSpec[];

  // Read-only reference disclosure (statutory rate table, county tier chart,
  // period/due rules) rendered in settings so the user audits what the calc uses.
  referenceView: ReferenceSpec;

  recomputeLabel?: string;             // e.g. "Recompute from Square"
  worksheetComponent: string;          // which React component renders it
}
```

## 3. Data model

All tables are finance-domain → **service-role-only** under the existing RLS
posture (finance/payroll are not exposed to the browser anon client).

### 3.1 `pos_line_item_taxes` (new child table)
Per-line applied-tax detail the current POS sync discards. A line→taxes
relationship is genuinely 1:many (one item can carry both General Sales Tax and
Prepared Food & Beverage Tax), and a child table enables SQL-side aggregation
(`SUM(...) WHERE square_tax_id = <general sales>`), which is the hot path for
every worksheet computation.

| column         | type        | notes                                   |
|----------------|-------------|-----------------------------------------|
| id             | uuid pk     |                                         |
| line_item_id   | uuid fk     | → `pos_line_items(id)` ON DELETE CASCADE |
| square_tax_id  | text        | Square catalog tax object id            |
| tax_name       | text        | snapshot for display/resilience         |
| tax_pct        | numeric     | snapshot                                |
| amount_cents   | integer     | tax applied to this line by this tax    |

`syncPosTransactions.ts` is extended to capture Square's per-line `applied_taxes`
(and the order-level `taxes` list linking `tax_uid` → catalog tax id). A backfill
route re-derives history for past periods.

### 3.2 `tax_filing_profiles` (party-level settings)
One row per receiving party, reused by every task/schedule for that party. Holds
identity + user-controllable party-wide settings. **SSN/FEIN are sensitive** —
service-role-only, never sent to the browser anon client. FEIN-first; SSN
optional.

| column     | type      | notes                                             |
|------------|-----------|---------------------------------------------------|
| party_key  | text pk   |                                                   |
| values     | jsonb     | contact name/email/phone, account id, FEIN, SSN?, Square general-sales tax id |
| updated_at | timestamptz |                                                 |

Statutory reference data (state rate, county tier chart) is NOT stored here — it
lives as authoritative constants in the party module (§6), viewable but not
editable.

### 3.3 `tax_schedules` (user-created schedule)
Fully party-agnostic; all party-specific knobs live in `config`.

| column     | type        | notes                                      |
|------------|-------------|--------------------------------------------|
| id         | uuid pk     |                                            |
| party_key  | text        |                                            |
| frequency  | text        | monthly \| quarterly \| annual             |
| lead_days  | integer     | default 7                                  |
| active     | boolean     | default true                               |
| config     | jsonb       | party-specific: county list + weights, etc.|
| created_at / updated_at | timestamptz |                              |

NC DOR `config`: `{ counties: [{ code, weight }], ... }`. Default single county =
100% (Wake). No first-class `counties` column — counties are NC-DOR-specific and
would not apply to e.g. TTB.

### 3.4 `tax_tasks` (one auto-generated submission task per period)

| column               | type        | notes                              |
|----------------------|-------------|------------------------------------|
| id                   | uuid pk     |                                    |
| schedule_id          | uuid fk     | → `tax_schedules(id)`              |
| party_key            | text        | denormalized for convenience       |
| period_start         | date        |                                    |
| period_end           | date        | the "Period Ending"                |
| due_date             | date        |                                    |
| status               | text        | open \| completed \| skipped       |
| alert_sent_at        | timestamptz | one email per task, never re-sent  |
| worksheet            | jsonb       | full editable return state (prefill + user edits) |
| confirmation_number  | text        |                                    |
| amount_paid_cents    | integer     |                                    |
| submitted_on         | date        |                                    |
| notes                | text        |                                    |
| completed_at         | timestamptz |                                    |
| completed_by         | uuid        | user id                            |
| created_at / updated_at | timestamptz |                                 |

**`UNIQUE (schedule_id, period_end)`** — cron idempotency; never two tasks for one
period. Due-soon/overdue is derived from `due_date` at render time, not stored.

### 3.5 `tax_task_files` (new child table — multiple labeled confirmations)
A task can carry a payment confirmation, county-schedule PDFs, etc. Free-form:
the user uploads as many files as they want and types their own label per file.

| column       | type        | notes                                    |
|--------------|-------------|------------------------------------------|
| id           | uuid pk     |                                          |
| task_id      | uuid fk     | → `tax_tasks(id)` ON DELETE CASCADE      |
| storage_path | text        | path in the bucket                       |
| file_name    | text        | original name                            |
| label        | text        | free text, user-entered                  |
| uploaded_at  | timestamptz |                                          |
| uploaded_by  | uuid        |                                          |

### 3.6 Supabase Storage
New **private** bucket `tax-confirmations`; files at `{task_id}/{file_name}`.
Downloaded via signed URLs from a server route (first Storage use in the app —
setup/migration documented).

## 4. Flow

1. **Create schedule** (user) — Finance → Tax → "New Schedule": pick party,
   frequency, lead days, and party config (counties + weights, Square
   General-Sales-Tax id). → `tax_schedules` row.

2. **Daily cron `tax-tasks`** (via `runCronJob`, monitored in `cron_runs`). Per
   active schedule:
   - **Ensure task rows** — over a bounded lookback (so a late-created schedule or
     a missed cron run still backfills any un-represented ended period), compute
     each period via `computePeriod` and upsert a `tax_task` for any whose period
     has ended and has no row yet (idempotent on `unique(schedule_id,
     period_end)`). Worksheet left empty — Square data may still be settling;
     compute lazily on open.
   - **Fire alerts** — for open tasks where `today ≥ due_date − lead_days` and
     `alert_sent_at IS NULL`: send Resend email to admin + stamp `alert_sent_at`.

3. **Open task** (Tax tab list or email link) — if `worksheet` is empty, run
   `computeWorksheet(ctx)` to prefill + snapshot; else load saved state. Renders
   the party worksheet inside `<TaxWorksheetShell>`, read-only filing identity up
   top. Edits autosave to `worksheet`. A generic **Recompute** action re-invokes
   the party's compute and applies the party's field-ownership merge policy
   (overwrite computed fields, preserve manual ones).

4. **Complete** — user enters confirmation number, amount paid, submitted date,
   notes; optionally uploads any number of labeled files (→ `tax_task_files` +
   Storage). "Mark Submitted" → `status=completed`, `completed_at/by`. Moves to
   completed list.

## 5. Recompute — party-owned field ownership

The framework never hardcodes a data source. Each worksheet field is tagged
**computed** (engine-owned, derived by the party) or **manual** (user-owned —
penalty, interest, credits, prepayments, purchases-for-use). `computeWorksheet` is
the party's sole authority on data sources (Square today; other Supabase tables,
reconciliation inputs, or external systems for other parties tomorrow). The shell
exposes a **generic Recompute** action (label party-suppliable) that re-invokes
compute and applies the party's merge policy. A party needing multi-source manual
reconciliation implements it entirely in its `calc.ts`; the framework is unchanged.

## 6. NC DOR — Sales & Use Tax party module

`lib/tax/parties/ncDorSalesUse/`: `calc.ts`, `rates.ts` (constants), `template.ts`,
co-located tests. Corresponding worksheet component under
`app/finance/tax/parties/NcDorSalesUse/`.

### 6.1 Configurable vs statutory
- **User-controllable → stored, editable settings** (`tax_filing_profiles` /
  `tax_schedules.config`): which counties they operate in (+ split weights), which
  Square tax item is General Sales Tax, lead days, identity fields.
- **Statutory → authoritative constants in `rates.ts`, viewable not editable**
  (decided by NC DOR; cannot be safely user-changed): the 4.75% state rate and
  the county tier chart (2.00 / 2.25 / 2.50 / 2.75 combined local+transit). A rate
  change is a reviewed code change, never a settings edit. Constants surface in
  the settings **reference disclosure** so there are no surprises.

### 6.2 Period / due rules
- Monthly: period ending = last day of month; due = 20th of the following month.
- Quarterly: period ending = quarter end; due = last day of the month following
  the quarter end.
- Due dates land on the brewery-local calendar (consistent with the rest of the
  app's timezone handling); the exact business-day/holiday rounding, if any, is a
  detail for the plan.
- (`supportedFrequencies = ["monthly","quarterly"]`; annual N/A for S&U.)

### 6.3 Calc (all integer cents)
- **Isolate General-Sales-Taxed lines** for the period via
  `pos_line_item_taxes.square_tax_id = <configured general-sales id>` (name-match
  fallback). Correctly handles mixed orders — a keg (taxed) + pump deposit
  (untaxed) on one order contributes only the keg line.
- **Taxable base** = Σ over those lines of `(total_money − total_tax)` =
  post-discount, pre-tax receipts. Excludes tax by construction; excludes tips
  (order-level). This is **Line 1 Gross Receipts** *and* the **Receipts** on each
  active rate line (Sales for Resale / Exempt = 0 for the taproom).
- **Multi-county split.** The base is split across the schedule's counties by
  weight. Each split routes to its tier's page-1 rate line (2% county → L9,
  2.25% county → L10) and transit line (L11/L12), and to its row on the page-2
  county schedule. Single taproom = degenerate 100% / one-tier (Wake: 2% county +
  0.5% transit) case.
- **Rate lines** (prefilled; others 0): L4 General State = base × 4.75%; county &
  transit lines per each county's tier. "Purchases for Use" defaults 0 (editable,
  self-assessed use tax).
- **Totals (live, mirror the form):** L13 = Σ L4–L12 tax; L15 = L13 + L14;
  **L21 = L15 + L16 + L17 + L19 − L18 − L20.**
- **County schedule (page 2)** — per-county 2% / 2.25% / transit entries.
  Validations: county weights sum to 100%; Σ county-schedule entries = L9+L10
  (+ transit L11+L12).
- **Reconciliation flag** — compare computed tax (base × rate) vs tax Square
  *actually collected* on those lines; divergence beyond rounding raises a warning
  banner (catches a misconfigured Square tax before filing).

## 7. Settings surfaces

Finance → Settings → new "Tax Filing" subtab (added to `SettingsNav`):
- **Filing identity** per party — Contact Name/Email/Phone, Account ID, FEIN (SSN
  optional) → `tax_filing_profiles`.
- **Party reference disclosure (read-only)** — the party's statutory rate table,
  county tier chart, and period/due rules, rendered from the template.
- **Schedules** list + editor lives on the **Tax tab** (editor as a modal); the
  settings subtab is identity + disclosure.

## 8. Scope / phasing

Multi-group plan → writing-plans then subagent-driven execution.

1. **Data layer** — migrations (5 tables + bucket); extend `syncPosTransactions`
   to persist `pos_line_item_taxes`; backfill route for history.
2. **Shared engine** — `lib/tax/` types, registry, period math, schedule/task
   orchestration (pure, unit-tested).
3. **NC DOR party module** — `calc.ts`, `rates.ts`, `template.ts`, field-ownership
   + recompute merge; unit tests (mixed keg+deposit orders, multi-county split,
   reconciliation-flag cases, period/due math).
4. **Cron** — `app/api/cron/tax-tasks` (ensure-tasks + fire-alerts), `vercel.json`
   entry, Resend email.
5. **UI** — Tax tab (task list + status badges), schedule editor, worksheet shell
   + NC DOR worksheet component, complete/upload flow, settings subtab (identity +
   disclosure). Uses existing UI primitives/tokens per `docs/UI_STANDARD.md`.

## 9. Testing & auth

- Per CLAUDE.md, every new `lib/` module ships co-located `*.test.ts`. The calc
  engine and period math are pure and get the heaviest coverage (golden-order
  fixtures → expected worksheet). Route handlers stay thin. `npm run verify` is
  the DoD.
- Writes gated via `lib/auth.ts` — manager+ to prepare/complete a task; admin for
  settings/identity — consistent with the finance area's service-role posture.

## 10. Out of scope (v1)

- Parties other than NC DOR Sales & Use Tax (framework supports them; only NC DOR
  is implemented).
- Automated submission to the NC DOR portal (the app prepares figures; the user
  files manually).
- Annual frequency for S&U (not applicable).
