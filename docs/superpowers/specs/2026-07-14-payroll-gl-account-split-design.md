# Payroll: split bank withdrawals across GL accounts via Gusto upload

**Date:** 2026-07-14
**Branch:** `claude/payroll-gl-account-split-90155a`
**Status:** Approved (design), pending implementation plan

## Problem

Every `expenses` row (Ramp cards/bills + bank-sourced operating debits) codes to exactly one
`chart_of_accounts_id`. Gusto payroll withdrawals are no exception today — coded as a single
lump "payroll" expense via `expense_counterparty_mappings` (Gusto is already the flagship
example in that settings UI). In reality one Gusto withdrawal blends dollars that belong to
several GL accounts:

- **6110** — Taproom staff wages (Front of House)
- **6120** — Sales & admin wages
- **5130** — Direct production labor
- **6130** — Payroll taxes & processing fees (employer-side)

Gusto's own "Payroll Journal Report" CSV export already carries the data needed to make this
split precise: a `Department` column per employee (Front of House / Production / etc.), a gross
`Amount` column, and a pre-summed `Employer Taxes` column. This feature makes uploading that
report — per completed pay period, into the existing Payroll module — the source of truth for
splitting the matching bank withdrawal(s) in Finance > Transactions across the four GL accounts.

Gusto typically debits the bank account **multiple times** per pay run (e.g. a net-pay debit and
a separate tax debit), so the design matches N transactions to one pay period rather than
assuming a 1:1 relationship.

## Decisions (locked)

1. **Storage shape is generic, usage is payroll-only for now.** A new `expense_gl_splits` table
   (mirrors the existing `invoice_line_items` header/lines pattern) lets any `expenses` row carry
   multiple GL lines instead of one `chart_of_accounts_id`. Only the payroll flow writes to it in
   this feature; Financials reads it through one shared resolver everywhere it currently reads a
   row's single account, so no other code needs to special-case payroll.
2. **Split amounts come from real Gusto numbers, not guesses.** Each pay period's parsed report
   produces GL bucket totals. Each matched expense's split is that expense's proportional share
   (`expense.amount / sum(all matched expenses for the period)`) of the period's bucket totals —
   not an arbitrary per-transaction allocation.
3. **Matching precedes upload.** An expense can be matched to a pay period (via nearest `pay_day`
   suggestion) before that period's Gusto report is uploaded. Until the report exists, the
   expense is flagged "awaiting Gusto upload" — no split, no normal single-account coding either.
4. **Reconciliation is informational, not blocking.** Matched-expenses-total vs. parsed-report-total
   variance is surfaced (Payroll period page + Transactions) but never blocks saving — Gusto debit
   timing doesn't always align cleanly with pay-period boundaries.
5. **Recompute is explicit and safe.** A per-expense "Recompute split" action regenerates only
   `split_source = 'payroll_auto'` rows. If a user has hand-edited a split (`'manual'`), recompute
   requires confirmation before overwriting.
6. **Benefits (6140) and Gusto processing fees are out of scope.** The sample Payroll Journal
   Report has no benefits or fee columns. Skipped entirely for this version — see Out of scope.
7. **Tips are excluded from the split.** `Cash Tips` / `Paycheck Tips` sub-rows in the CSV are
   pass-through (already tracked via POS/taxable-base elsewhere), not a wage expense.
8. **GL accounts already exist.** 6110/6120/5130/6130 are already present in `chart_of_accounts`
   — no seeding migration needed, only mapping settings that reference them by `account_number`.

## Data model

### Settings

```sql
-- expense_counterparty_mappings: route payroll counterparties into the split flow
alter table expense_counterparty_mappings
  add column routing text not null default 'single_account'
    check (routing in ('single_account', 'payroll_split'));
```

```sql
-- department_name (Gusto's free-text Department field) -> GL account
create table payroll_department_gl_mappings (
  id uuid primary key default gen_random_uuid(),
  department_name text not null unique,
  chart_of_accounts_id uuid not null references chart_of_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

```sql
-- singleton: which account absorbs employer-side payroll taxes (not per-department)
create table payroll_gl_settings (
  id boolean primary key default true check (id),
  payroll_taxes_chart_of_accounts_id uuid not null references chart_of_accounts(id)
);
```

### Gusto upload (mirrors the `tax_task_files` Storage bucket pattern)

```sql
create table payroll_gl_reports (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references pay_periods(id),
  storage_path text not null,
  original_filename text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid not null references auth.users(id),
  superseded_at timestamptz
);

-- raw parsed rows: audit trail + recompute source of truth
create table payroll_gl_report_employees (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references payroll_gl_reports(id) on delete cascade,
  last_name text not null,
  first_name text not null,
  department text not null,
  job text,
  pay_type text,
  gross_amount_cents bigint not null,
  employer_tax_cents bigint not null
);

-- rolled-up totals per GL account, what downstream matching reads
create table payroll_gl_report_totals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references payroll_gl_reports(id) on delete cascade,
  chart_of_accounts_id uuid not null references chart_of_accounts(id),
  amount_cents bigint not null
);
```

### Transaction linking + split

```sql
create table payroll_period_expense_matches (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references pay_periods(id),
  expense_id uuid not null unique references expenses(id),
  matched_at timestamptz not null default now(),
  matched_by uuid not null references auth.users(id)
);

-- generic shape (mirrors invoice_line_items); only payroll writes to it today
create table expense_gl_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses(id) on delete cascade,
  chart_of_accounts_id uuid not null references chart_of_accounts(id),
  amount_cents bigint not null,
  split_source text not null check (split_source in ('payroll_auto', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

RLS follows the existing finance pattern (`finance_reader_roles()` for read, manager/admin for
write) already used by `expenses` and `payroll_config`.

## CSV parsing rules (`lib/payroll/gustoParser.ts`)

Input: the Gusto "Payroll Journal Report" CSV (sample confirmed the exact column layout below).

- Locate the `"Payroll period"` row for period start/end and `"Pay day"` for the pay date;
  cross-check against the `pay_periods` row the file is uploaded to and warn (non-blocking) on
  mismatch.
- An employee block starts at a row with non-empty `Last Name`. From that row, take `Department`
  and the `Regular`/`Bonus`/`Salary`-type `Amount` (gross wage) and `Employer Taxes` (the
  pre-summed column — not the individual SS/Medicare/FUTA/NC-Unemployment sub-columns).
- **Exclude** `Cash Tips` / `Paycheck Tips` sub-rows from the wage total (see Decision 7).
- **Exclude** grand-total rows (`Last Name = "Payroll Totals"`, or blank `Last Name` rows outside
  an employee block) — these are Gusto's own subtotals-by-job-title and would double-count if
  summed alongside individual employee rows.
- Bucket each employee's gross `Amount` via `payroll_department_gl_mappings[Department]`. A
  department with no mapping produces a **blocking warning on the upload UI** (the file still
  saves so the raw data isn't lost, but its dollars sit in an explicit "unmapped" bucket until a
  mapping is added and the report is recomputed) — never silently dropped or defaulted.
- Sum all `Employer Taxes` values (all departments) into `payroll_gl_settings.payroll_taxes_chart_of_accounts_id`.
- Persist one `payroll_gl_report_employees` row per employee and the rolled-up
  `payroll_gl_report_totals` rows (typically ≤4: 6110/6120/5130/6130).

## Matching, auto-fill, and recompute (`lib/finance/payrollMatching.ts`)

**Matching:** an expense whose counterparty mapping has `routing = 'payroll_split'` shows a
"Match payroll period" action instead of a normal account picker. The system suggests the
unmatched pay period whose `pay_day` is closest to the expense's transaction date (±10 day
window); the user confirms or picks a different period. Confirming inserts a
`payroll_period_expense_matches` row. Multiple expenses may match the same period.

**Auto-fill** (runs on match, and on demand via "Recompute split"):
1. If the matched period has no active `payroll_gl_reports` row, no split lines are generated —
   the expense shows an "awaiting Gusto upload" badge in place of a GL badge.
2. If a report exists: for every expense currently matched to the period, compute
   `weight = expense.amount_cents / sum(matched expense.amount_cents for the period)`, then for
   each `payroll_gl_report_totals` row, `line_amount = round(weight * total.amount_cents)`. Assign
   any leftover cent (from rounding across all lines) to the largest bucket so lines sum exactly
   to the expense's own total. Write these as `expense_gl_splits` rows with
   `split_source = 'payroll_auto'`.
3. **Recompute** deletes and regenerates only `'payroll_auto'` rows for that expense. If `'manual'`
   rows exist for the expense, recompute is blocked behind a confirmation dialog rather than
   silently overwritten.
4. **Un-matching** an expense from a period deletes its `'payroll_auto'` split rows, reverting it
   to normal single-account coding eligibility.

**Reconciliation:** both the Payroll period page and the Transactions view show
`sum(matched expenses.amount_cents)` vs. `sum(report totals.amount_cents)` for a period once a
report exists, flagged (not blocked) when the variance exceeds a small tolerance (e.g. $1).

**Alerting:**
- Payroll period page: banner when the period has ≥1 matched expense but no active report
  ("N transaction(s) waiting on a Gusto upload").
- Transactions view: matched-but-unsplit expenses carry the same "awaiting upload" badge, plus a
  filterable count in the list view so it's visible without opening Payroll.

## Component changes (file map)

### Data / business logic — `lib/payroll/`
- `gustoParser.ts` (new) — CSV → `{ employees, totals, warnings }`, per the parsing rules above.
- `gustoUpload.ts` (new) — Storage upload (new bucket, e.g. `payroll-gl-reports`, same
  admin-client-only pattern as `lib/tax/files.ts`), persists `payroll_gl_reports` +
  `payroll_gl_report_employees` + `payroll_gl_report_totals`, marks prior report `superseded_at`.

### Data / business logic — `lib/finance/`
- `payrollMatching.ts` (new) — period suggestion, match/un-match, auto-fill/recompute algorithm
  from the section above.
- `expenseGlLines.ts` (new) — shared resolver: `getExpenseGlLines(expense): { chart_of_accounts_id, amount_cents }[]`.
  Returns `expense_gl_splits` rows if present, else a single synthesized line from the expense's
  own `chart_of_accounts_id`/`amount_cents`. Every Financials aggregation path that currently
  reads an expense's account directly switches to this resolver.
- `autoMap.ts` — `expense_counterparty_mappings` consumers must skip auto-mapping when
  `routing = 'payroll_split'` (route to the matching flow instead of writing a single account).

### API routes — `app/api/`
- `payroll/periods/[id]/gusto-report/route.ts` (new) — upload + parse endpoint, mirrors
  `app/api/tax/tasks/[id]/files/route.ts`.
- `finance/expenses/[id]/payroll-match/route.ts` (new) — match/un-match/recompute actions.
- `finance/settings/payroll-department-mappings/route.ts` (new) — CRUD for
  `payroll_department_gl_mappings` + `payroll_gl_settings`.

### UI — `app/components/payroll/`
- New "Gusto Upload" tab alongside existing `summary | shifts | gusto` on the period view: file
  upload, parsed employee table (audit), GL totals summary, matched-expenses list + variance
  banner, "awaiting upload" alert.

### UI — `app/finance/transactions/expenses/page.tsx`
- Row-level payroll cell: "Match payroll period" (unmatched) / split breakdown on hover-expand
  (matched + split) / "Payroll — awaiting upload" badge (matched, no report yet) — each with a
  "Recompute" icon action.

### UI — `app/finance/settings/`
- `counterparty-accounts/page.tsx` — add the `routing` toggle to existing rows.
- New `payroll-department-mappings/page.tsx` — Department → GL account table, plus the single
  payroll-taxes account setting.

### Types — `lib/payroll/types.ts`, `lib/finance/types.ts`
- New types for `PayrollGlReport`, `PayrollGlReportEmployee`, `PayrollGlReportTotal`,
  `PayrollDepartmentGlMapping`, `ExpenseGlSplit`, `PayrollPeriodExpenseMatch`.

### Schema — new migration(s) under `supabase/migrations/`
One migration, `20260714_payroll_gl_split.sql`, containing all tables/columns above plus RLS
policies following the existing `finance_reader_roles()` pattern.

## Testing

- `lib/payroll/__tests__/gustoParser.test.ts` — using the real sample CSV shape: correct exclusion
  of tip sub-rows and grand-total rows, correct department bucketing, correct employer-tax
  summation, unmapped-department warning path.
- `lib/finance/__tests__/payrollMatching.test.ts` — proportional split computation incl. cent-
  rounding remainder assignment, recompute preserves `'manual'` rows (blocks + confirms), un-match
  reverts auto splits, period-suggestion nearest-`pay_day` logic.
- `lib/finance/__tests__/expenseGlLines.test.ts` — split-rows-present vs. single-synthesized-line
  paths; this resolver feeds Financials directly, so a regression here mis-books real dollars.
- Route handler tests for the upload endpoint (Storage + parse + persistence), mirroring
  `app/api/tax/tasks/[id]/files/route.test.ts`.
- `npm run verify` green (lint + typecheck + tests); keep `lib/` coverage above the vitest floor.

## Out of scope / non-goals

- **Employee benefits (6140)** and **Gusto processing fees** — no source data in the Payroll
  Journal Report; explicitly skipped this version (per Decision 6). Revisit if/when a Gusto
  billing/benefits export is identified.
- **`ramp_bank_ledger`** — confirmed out of scope; payroll withdrawals land in `expenses`
  (bank-sourced operating debits), not `ramp_bank_ledger`, which explicitly excludes payroll.
- **Gusto API integration** — manual CSV upload only, no OAuth/API polling.
- **Generalizing `expense_gl_splits` to non-payroll use cases** — the table shape is generic, but
  no UI/logic outside the payroll flow writes to it in this feature.
- **Auto-matching without confirmation** — period suggestion is always a proposal the user
  confirms, never silent.

## Rollout notes (human-gated, post-merge)

- Apply the migration to prod (per repo policy: orchestrator applies only after explicit user OK
  + backup).
- Create the `payroll-gl-reports` Storage bucket (private, admin-client-only access, matching
  `tax-confirmations`).
- Seed `payroll_department_gl_mappings` for the brewery's actual Gusto department names (e.g.
  "Front of House" → 6110, "Production" → 5130) and set `payroll_gl_settings.payroll_taxes_chart_of_accounts_id`
  → 6130, via the new settings UI.
- Set Gusto's row in `expense_counterparty_mappings` to `routing = 'payroll_split'`.
- First real-world use will surface any Gusto department names not covered by the sample CSV
  (e.g. an actual "Sales & Admin" department) — expect to add mappings after the first live
  upload.
