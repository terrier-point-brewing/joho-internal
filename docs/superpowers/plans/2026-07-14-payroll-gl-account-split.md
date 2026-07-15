# Payroll GL Account Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Gusto payroll bank-withdrawal transactions in Finance > Transactions across GL accounts 6110/6120/5130/6130, driven by uploading Gusto's Payroll Journal Report CSV per pay period in the Payroll module.

**Architecture:** A generic `expense_gl_splits` table (mirrors `invoice_line_items`) lets any `expenses` row carry multiple GL lines. Only the payroll flow writes to it: parse the uploaded Gusto CSV into per-department + employer-tax GL totals for a pay period, match one or more bank-withdrawal `expenses` rows to that period, and auto-fill each matched expense's split lines proportionally from the period's totals. Financials reads through one shared resolver (`getExpenseGlLines`) so no other code special-cases payroll.

**Tech Stack:** Next.js 16 App Router + TypeScript, Supabase Postgres (service-role/admin client in all finance/payroll routes), Vitest.

**Design doc:** `docs/superpowers/specs/2026-07-14-payroll-gl-account-split-design.md` (read for full rationale — this plan implements it; do not re-derive design decisions).

## Execution Budget

- **Execution mode:** subagent-driven-development (7 locality groups, well over the 6-file inline threshold).
- **Spawn cap:** 9 (7 locality groups + 2). Dispatch **one agent per Locality Group**, running that group's tasks sequentially in one session — do not spawn one agent per Task.
- **Token target:** ~1.3M tokens (9 spawns × ~150k avg context tax). Stop and report before exceeding the spawn cap.

## Global Constraints

- All money is integer cents (`*_cents` columns / fields) — never floats.
- Every new/modified API route parses query params with `requireDateRange()` and wraps errors with `apiError()` (`lib/utils/api.ts`) where applicable; finance/payroll routes gate with `requireRole([...])` matching existing sibling routes.
- All Supabase access in API routes uses `createSupabaseAdminClient()` (privileged, service-role) — matches every existing finance/payroll route; never the browser client in a route handler.
- New/modified `lib/` business-logic modules ship with co-located `*.test.ts`; don't drop `lib/` coverage below the `vitest.config.ts` threshold floor.
- No raw color utilities (`zinc-*`/`amber-*`/etc.) or hex/rgb literals in any UI task — use token utilities (`bg-surface`, `text-secondary`, `border-line`, etc.) and existing primitives (`.btn-primary`/`.btn-secondary`, `.inp`, `<Card>`, `<Badge>`, `<Modal>`) per `docs/UI_STANDARD.md`. Any UI task in this plan is an Extended Documentation Trigger — read `docs/UI_STANDARD.md` before writing JSX.
- RLS: new payroll-owned tables use `payroll_reader_roles()` (`['manager','admin']`) via the same `"payroll readers"` policy shape as `payroll_config`/`pay_periods`/`employees`. `expense_gl_splits` and `payroll_period_expense_matches` (they reference `expenses`, a finance table) use the same policy shape as `expenses` itself.
- Migration file naming: `YYYYMMDD_description.sql`, `if not exists`/`if exists` guards, human-readable header comment.

---

## Locality Group 1 — Schema (`supabase/migrations/`)

### Task 1: Payroll GL split migration

**Model:** Haiku

**Files:**
- Create: `supabase/migrations/20260714_payroll_gl_split.sql`

**Interfaces:**
- Produces: all tables/columns below, consumed by every later task's Supabase queries.

**Acceptance criteria:**
- Migration applies cleanly against the current schema (no missing FK targets — `chart_of_accounts`, `pay_periods`, `expenses`, `auth.users` all already exist).
- All money columns are `bigint`/`integer` cents, never numeric/float.
- RLS is enabled and a policy exists on every new table, per the Global Constraints RLS rule.

- [ ] **Step 1: Write the migration**

```sql
-- Payroll GL account split: settings, Gusto upload storage, and per-expense
-- GL-line splitting driven by uploaded Gusto payroll reports.
-- See docs/superpowers/specs/2026-07-14-payroll-gl-account-split-design.md

-- ── Settings ─────────────────────────────────────────────────────────────

alter table public.expense_counterparty_mappings
  add column if not exists routing text not null default 'single_account'
    check (routing in ('single_account', 'payroll_split'));

create table if not exists public.payroll_department_gl_mappings (
  id uuid primary key default gen_random_uuid(),
  department_name text not null unique,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_gl_settings (
  id boolean primary key default true check (id),
  payroll_taxes_chart_of_accounts_id uuid not null references public.chart_of_accounts(id)
);

-- ── Gusto upload ─────────────────────────────────────────────────────────

create table if not exists public.payroll_gl_reports (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id),
  storage_path text not null,
  original_filename text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid not null references auth.users(id),
  superseded_at timestamptz
);

create table if not exists public.payroll_gl_report_employees (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.payroll_gl_reports(id) on delete cascade,
  last_name text not null,
  first_name text not null,
  department text not null,
  job text,
  pay_type text,
  gross_amount_cents bigint not null,
  employer_tax_cents bigint not null
);

create table if not exists public.payroll_gl_report_totals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.payroll_gl_reports(id) on delete cascade,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  amount_cents bigint not null
);

-- ── Transaction linking + split ──────────────────────────────────────────

create table if not exists public.payroll_period_expense_matches (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id),
  expense_id uuid not null unique references public.expenses(id),
  matched_at timestamptz not null default now(),
  matched_by uuid not null references auth.users(id)
);

create table if not exists public.expense_gl_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  amount_cents bigint not null,
  split_source text not null check (split_source in ('payroll_auto', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────

alter table public.payroll_department_gl_mappings enable row level security;
alter table public.payroll_gl_settings enable row level security;
alter table public.payroll_gl_reports enable row level security;
alter table public.payroll_gl_report_employees enable row level security;
alter table public.payroll_gl_report_totals enable row level security;
alter table public.payroll_period_expense_matches enable row level security;
alter table public.expense_gl_splits enable row level security;

create policy "payroll readers" on public.payroll_department_gl_mappings
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_settings
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_reports
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_report_employees
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_report_totals
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "finance readers" on public.payroll_period_expense_matches
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

create policy "finance readers" on public.expense_gl_splits
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

-- ── Storage bucket ────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('payroll-gl-reports', 'payroll-gl-reports', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Apply locally and verify**

Run: `supabase db reset` (or the project's equivalent local-apply command — check `package.json`/`supabase/config.toml` for the exact script name used elsewhere in this repo) and confirm no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260714_payroll_gl_split.sql
git commit -m "feat(finance): add payroll GL account split schema"
```

---

## Locality Group 2 — Payroll Gusto ingest (`lib/payroll/`, `app/api/payroll/periods/[id]/gusto-report/`)

**Consumes:** Group 1's tables (`payroll_gl_reports`, `payroll_gl_report_employees`, `payroll_gl_report_totals`, `payroll_department_gl_mappings`, `payroll_gl_settings`).

### Task 2: Gusto CSV parser

**Model:** Sonnet

**Files:**
- Create: `lib/payroll/gustoParser.ts`
- Test: `lib/payroll/gustoParser.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ParsedGustoEmployee {
  lastName: string;
  firstName: string;
  department: string;
  job: string | null;
  payType: string | null;
  grossAmountCents: number;
  employerTaxCents: number;
}

export interface ParsedGustoReport {
  payPeriodStart: string | null; // "YYYY-MM-DD", parsed from "Payroll period" row if present
  payPeriodEnd: string | null;
  payDay: string | null;
  employees: ParsedGustoEmployee[];
  /** departments seen with no entry in payrollDepartmentGlMappings — surfaced, never silently dropped */
  unmappedDepartments: string[];
}

export function parseGustoPayrollJournal(csvText: string): ParsedGustoReport;

export interface GlBucketTotal {
  chartOfAccountsId: string;
  amountCents: number;
}

/**
 * Buckets parsed.employees by department via departmentMap, sums employer
 * tax across ALL employees into payrollTaxesAccountId. Employees whose
 * department isn't in departmentMap contribute to parsed.unmappedDepartments
 * (already populated by parseGustoPayrollJournal) and are excluded from the
 * returned totals.
 */
export function computeGlBucketTotals(
  parsed: ParsedGustoReport,
  departmentMap: Map<string, string>, // department_name -> chart_of_accounts_id
  payrollTaxesAccountId: string,
): GlBucketTotal[];
```

**Parsing rules (from design doc §3, corrected/verified against the real sample export — implement exactly):**
- An employee block starts at a CSV row with non-empty `Last Name`. Take that row's `Department`, its own `Amount` column value (the `Regular`/`Salary` pay-type amount), and its `Employer Taxes` column (the pre-summed total — the individual `Social Security (Employer)`/`Medicare (Employer)`/`FUTA (Employer)`/`NC Unemployment Tax (Employer)` sub-columns are detail and NOT separately summed).
- The employee block continues over any immediately-following blank-`Last Name` sub-rows until the next non-blank-`Last Name` row (or the grand-total section). Each sub-row's `Job` column position instead holds a pay-type label (`"Bonus"`, `"Cash Tips"`, `"Paycheck Tips"`, `"Gross"`, etc.) with an amount in the `Amount` column position:
  - **Include** a `"Bonus"` sub-row's amount in `grossAmountCents` — a bonus is real wage expense, not pass-through, and Gusto reports it as a separate sub-row rather than folding it into the employee's own `Regular` row.
  - **Exclude** `"Cash Tips"` and `"Paycheck Tips"` sub-rows — pass-through, already tracked elsewhere, not wage expense.
  - **Exclude** the `"Gross"` sub-row — it's the sum of the employee's own Regular+Bonus+tip sub-rows and would double-count if added.
- **Exclude** grand-total rows: any row where `Last Name` is `"Payroll Totals"`, and the entire trailing summary block after it (rows with blank `Last Name` and a `Job`-position value of `"Totals"` or similar — these summarize by job title, not by employee, and are structurally after the last real employee block).
- A department is "unmapped" if it has zero, empty, or whitespace-only value, or isn't a key in `departmentMap` — push to `unmappedDepartments`, and that employee's gross dollars are excluded from `computeGlBucketTotals`'s returned buckets (never silently defaulted into an existing account).
- **Test fixture: use `.superpowers/sdd/task-2-sample-gusto-payroll-journal.csv`** (a sample Gusto export with the same real structure/numbers the design was based on, employee names replaced with fictional ones — read it directly; it is not reproduced in the design doc). It has 9 employees: Casey Ashford, Riley Bennett, Val Sawyer = `Production`; Morgan Bradford, Coral Carver, Cody Hastings, Camille Mercer, Aaron Osei, Kai Vance, Aria Winters, Drew Winters = `Front of House` (10 Front of House rows total — recount directly from the file, don't trust this list over the actual file). For the unmapped-department test case, take a copy of this fixture and change one employee's `Department` value to something not in your test's `departmentMap`.

**Verified ground-truth totals for the fixture above (hand-computed and cross-checked against the file's own `"Payroll Totals"` row — use these as your test assertions):**
- Production: `grossAmountCents` = `2384.62 + 1600.00 + 1730.77 = 5715.39` → `571539` cents; `employerTaxCents` = `227.74 + 162.40 + 170.92 = 561.06` → `56106` cents.
- Front of House: `grossAmountCents` = `0 (Bradford) + 64.23 (Carver: 56.56 Regular + 7.67 Bonus) + 253.54 (Hastings) + 76.30 (Mercer) + 301.91 (Osei) + 0 (Vance) + 720.00 (Aria Winters) + 0 (Drew Winters) = 1415.98` → `141598` cents; `employerTaxCents` = `12.30 + 65.70 + 23.23 + 72.12 + 73.08 = 246.43` → `24643` cents.
- Grand total employer tax across both departments = `561.06 + 246.43 = 807.49` → `80749` cents — this matches the file's own `"Payroll Totals"` row `Employer Taxes` value exactly (`80749`), confirming the Bonus-included/Tips-excluded rule above is correct.
- Grand total gross (Regular + Bonus, excluding tips) = `5715.39 + 1415.98 = 7131.37` — this matches the file's own `"Totals" "Regular"` row Amount (`7123.70`) plus its `"Bonus"` row Amount (`7.67`) = `7131.37` exactly, independently confirming the same rule from the file's own subtotal rows.

**Test cases:**
- Parses employee gross wages using the real fixture, asserting the exact Production and Front of House totals above (both gross and employer tax), including the Carver Bonus-inclusion case specifically.
- Front of House employees with $0 (Morgan Bradford, Kai Vance, Drew Winters — no shifts that period) are parsed but contribute $0, not excluded from the employee list.
- Unmapped department (fixture copy with one employee's `Department` changed) produces a `unmappedDepartments` entry and its dollars are absent from `computeGlBucketTotals`'s output.
- Employer tax total sums correctly across all departments combined into the one `payrollTaxesAccountId` bucket (assert the `80749`-cent grand total).
- Malformed/empty CSV input throws a clear error (don't silently return empty).

- [ ] **Step 1: Write failing tests** covering the cases above, using `.superpowers/sdd/task-2-sample-gusto-payroll-journal.csv` as the fixture (read it as a file in the test, or inline its contents as a template string — implementer's choice).
- [ ] **Step 2: Run tests, confirm they fail** (`npx vitest run lib/payroll/gustoParser.test.ts`).
- [ ] **Step 3: Implement `gustoParser.ts`** per the interfaces and rules above.
- [ ] **Step 4: Run tests, confirm they pass.**
- [ ] **Step 5: Commit.**

```bash
git add lib/payroll/gustoParser.ts lib/payroll/gustoParser.test.ts
git commit -m "feat(payroll): add Gusto payroll journal CSV parser"
```

### Task 3: Gusto report upload + persistence + route

**Model:** Sonnet

**Files:**
- Create: `lib/payroll/gustoUpload.ts`
- Create: `lib/payroll/gustoUpload.test.ts`
- Create: `app/api/payroll/periods/[id]/gusto-report/route.ts`
- Modify: `lib/payroll/types.ts` — add `PayrollGlReport`, `PayrollGlReportEmployee`, `PayrollGlReportTotal` types matching Group 1's schema.

**Interfaces:**
- Consumes: `parseGustoPayrollJournal`, `computeGlBucketTotals` (Task 2); Group 1's `payroll_gl_reports`/`payroll_gl_report_employees`/`payroll_gl_report_totals`/`payroll_department_gl_mappings`/`payroll_gl_settings` tables.
- Produces:
```ts
export interface UploadGustoReportInput {
  payPeriodId: string;
  file: File | Blob | Buffer;
  fileName: string;
  userId: string;
}

/**
 * Marks any existing active report for payPeriodId as superseded (sets
 * superseded_at), uploads the file to the "payroll-gl-reports" Storage
 * bucket, parses it, persists payroll_gl_reports +
 * payroll_gl_report_employees + payroll_gl_report_totals, and returns the
 * new report row plus computed totals.
 */
export async function uploadGustoReport(
  sb: SupabaseClient,
  input: UploadGustoReportInput,
): Promise<{ report: PayrollGlReport; totals: PayrollGlReportTotal[]; unmappedDepartments: string[] }>;
```
- Storage path shape: `` `${payPeriodId}/${crypto.randomUUID()}-${safeName}` `` — mirror `lib/tax/files.ts`'s exact `safeName` stripping (strip path separators) and bucket-constant pattern (`BUCKET = "payroll-gl-reports"`).

**Acceptance criteria:**
- Bucket is private; all access goes through `createSupabaseAdminClient()`, matching `lib/tax/files.ts`.
- Uploading a new report for a period that already has one marks the prior report `superseded_at` (does not delete it — audit trail preserved).
- Fetching `payroll_department_gl_mappings` and `payroll_gl_settings.payroll_taxes_chart_of_accounts_id` happens inside `uploadGustoReport` before calling `computeGlBucketTotals`.
- Route: `POST app/api/payroll/periods/[id]/gusto-report/route.ts` — gate with `requireRole(["manager"])` (matches `app/api/tax/tasks/[id]/files/route.ts`'s gating), parse `req.formData()`, validate `file instanceof File`, call `uploadGustoReport`, return `NextResponse.json(result, { status: 201 })`, wrap in `try/catch` → `apiError(err)`.
- `GET` on the same route returns the active report + totals + unmapped-department warnings for the period (for the UI in Group 6).
- **`uploadGustoReport` deliberately does NOT recompute already-matched expenses' splits** — that would require importing Group 3's `lib/finance/payrollMatching.ts`, which doesn't exist yet when this task runs and would create a cross-group ordering dependency. Group 6 (Task 11) closes this gap by calling Group 4's period-recompute route (added in Task 8) right after a successful upload — see Task 8 and Task 11.

**Test cases (mirror `lib/tax/files.test.ts`'s hand-rolled stub-`SupabaseClient` pattern — `calls: {kind, args}[]` array, `vi.spyOn(crypto, "randomUUID")`):**
- Upload persists report + employee rows + totals in the correct order (upload → insert report → insert employees → insert totals).
- Re-upload for the same period marks the prior report `superseded_at` before inserting the new one.
- Unmapped department surfaces in the returned `unmappedDepartments` without throwing.

- [ ] **Step 1: Write failing tests** per the cases above.
- [ ] **Step 2: Run tests, confirm failure.**
- [ ] **Step 3: Implement `gustoUpload.ts`, the route, and the `lib/payroll/types.ts` additions.**
- [ ] **Step 4: Run tests, confirm pass.**
- [ ] **Step 5: Commit.**

```bash
git add lib/payroll/gustoUpload.ts lib/payroll/gustoUpload.test.ts app/api/payroll/periods/[id]/gusto-report/route.ts lib/payroll/types.ts
git commit -m "feat(payroll): add Gusto report upload endpoint"
```

---

## Locality Group 3 — Finance GL split logic (`lib/finance/`)

**Consumes:** Group 1's `expense_gl_splits`, `payroll_period_expense_matches`, `payroll_gl_report_totals` tables; Group 2's `PayrollGlReport`/`PayrollGlReportTotal` types.

### Task 4: Expense GL-lines resolver

**Model:** Sonnet

**Files:**
- Create: `lib/finance/expenseGlLines.ts`
- Test: `lib/finance/expenseGlLines.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ExpenseGlLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto" | "manual" | null; // null when synthesized (no split rows exist)
}

/**
 * Returns expense_gl_splits rows for expenseId if any exist; otherwise a
 * single synthesized line from the expense's own account/amount (or [] if
 * the expense has no chart_of_accounts_id at all — unmapped).
 */
export function resolveExpenseGlLines(
  splitRows: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" }[],
  fallback: { chartOfAccountsId: string | null; amountCents: number },
): ExpenseGlLine[];

/** DB-fetching wrapper: queries expense_gl_splits for expenseId, then delegates to resolveExpenseGlLines. */
export async function getExpenseGlLines(sb: SupabaseClient, expenseId: string): Promise<ExpenseGlLine[]>;
```

**Acceptance criteria:**
- `resolveExpenseGlLines` is pure (no I/O) — this is the piece Task 7 (Financials aggregation) and the batch-fetch path both depend on for correctness, so keep it simple and fully covered.
- When split rows exist, they are returned as-is (untouched) — `resolveExpenseGlLines` does not re-derive or re-round anything.
- When no split rows exist and `fallback.chartOfAccountsId` is null, returns `[]` (unmapped expense — no line to attach).

**Test cases:**
- Split rows present → returned verbatim, `splitSource` preserved per row.
- No split rows, `fallback.chartOfAccountsId` set → one synthesized line with `splitSource: null`.
- No split rows, `fallback.chartOfAccountsId` null → `[]`.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit.**

```bash
git add lib/finance/expenseGlLines.ts lib/finance/expenseGlLines.test.ts
git commit -m "feat(finance): add expense GL-lines resolver"
```

### Task 5: Payroll matching + auto-fill + recompute

**Model:** Sonnet

**Files:**
- Create: `lib/finance/payrollMatching.ts`
- Test: `lib/finance/payrollMatching.test.ts`

**Interfaces:**
- Consumes: `payroll_period_expense_matches`, `expense_gl_splits`, `payroll_gl_report_totals` (Group 1); `pay_periods` (`id, start_date, end_date, due_date, status` — no `pay_day` column exists on `pay_periods` itself; use `due_date` or the period's own `payroll_gl_reports.uploaded` report's parsed `payDay` for period-suggestion proximity — confirm against `payroll_gl_reports` since that's where the actual Gusto `Pay day` value lives once uploaded; for periods with no report yet, suggest by `end_date` proximity instead).
- Produces:
```ts
export interface SuggestPeriodInput {
  expenseDate: string; // "YYYY-MM-DD"
  candidatePeriods: { id: string; endDate: string }[]; // unmatched periods only, pre-filtered by caller
}

/** Nearest candidate by |endDate - expenseDate|, within a 10-day window; null if none qualify. */
export function suggestPayPeriod(input: SuggestPeriodInput): string | null;

export interface MatchedExpenseAmount {
  expenseId: string;
  amountCents: number; // absolute value of the expense's signed amount_cents
}

/**
 * Proportionally allocates periodTotals across matchedExpenses by each
 * expense's share of the combined matched total. Rounds down per line, then
 * distributes leftover cents (from rounding) one at a time to the largest
 * lines first, so every expense's lines sum exactly to that expense's own
 * amountCents.
 */
export function computeProportionalSplits(
  matchedExpenses: MatchedExpenseAmount[],
  periodTotals: { chartOfAccountsId: string; amountCents: number }[],
): Map<string, { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" }[]>; // keyed by expenseId

/**
 * DB-orchestration wrapper, the single shared entry point for "regenerate
 * payroll_auto splits for every expense matched to this period" — used by
 * Task 8's "match" action (Group 4) AND by the period-recompute route Task 8
 * exposes for Group 6's post-upload trigger (see Task 3's note above). Reads
 * payroll_period_expense_matches + expenses.amount_cents for payPeriodId,
 * reads the period's active payroll_gl_reports' payroll_gl_report_totals,
 * calls computeProportionalSplits, then per expense: if it has any existing
 * expense_gl_splits row with split_source='manual', skip it entirely (don't
 * touch its rows); otherwise delete its existing 'payroll_auto' rows and
 * insert the freshly computed ones. No-ops (returns immediately) if the
 * period has no active report yet.
 */
export async function recomputePeriodExpenseSplits(sb: SupabaseClient, payPeriodId: string): Promise<void>;
```

**Rounding algorithm (non-obvious — implement exactly):**
```
for each expense e (in matchedExpenses):
  weight = e.amountCents / sum(all matchedExpenses.amountCents)
  for each bucket b (in periodTotals):
    raw = weight * b.amountCents
    line[e][b] = floor(raw)              // cents, rounds down
    remainder[e][b] = raw - floor(raw)
  scale lines for e so sum(line[e][*]) plus a to-be-distributed remainder
  equals e.amountCents exactly: distribute (e.amountCents - sum(floor lines))
  extra cents one-by-one to the buckets with the largest remainder[e][b] first
```

**Acceptance criteria:**
- `computeProportionalSplits` output for each expense always sums exactly to that expense's `amountCents` (no drift from floating-point rounding) — this is the property the tests must assert, not just spot-check a few numbers.
- `suggestPayPeriod` never auto-confirms — it only returns a suggestion; the caller (Task 8's route) is what persists a match.
- `suggestPayPeriod` and `computeProportionalSplits` have no DB I/O — pure functions. `recomputePeriodExpenseSplits` is the one DB-orchestrating function in this file; it composes the two pure functions with actual Supabase reads/writes and is a no-op (no rows touched) when the period has no active report.
- `recomputePeriodExpenseSplits` never touches an expense that has any `'manual'` `expense_gl_splits` row — full skip, not partial overwrite, matching Task 8's `"recompute"` single-expense semantics but applied period-wide.

**Test cases:**
- Two matched expenses ($6852.05 net pay, $807.49 tax debit — from the design doc's sample numbers) against period totals (6110/5130/6130 buckets) — assert per-expense line sums equal each expense's own amount, and combined totals across both expenses equal the period totals.
- Single matched expense — gets 100% of every bucket.
- Rounding: totals that don't divide evenly (e.g. $100.01 split 1/3-2/3) still sum exactly per expense.
- `suggestPayPeriod` picks the closest `endDate` within 10 days; returns null when none qualify.
- `recomputePeriodExpenseSplits`: no-ops when the period has no active report; regenerates `'payroll_auto'` rows for all non-manual matched expenses when a report exists; leaves an expense with a `'manual'` row completely untouched while still recomputing its siblings in the same period.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit.**

```bash
git add lib/finance/payrollMatching.ts lib/finance/payrollMatching.test.ts
git commit -m "feat(finance): add payroll period matching and proportional split logic"
```

### Task 6: Counterparty-mapping routing skip

**Model:** Sonnet

**Files:**
- Modify: `lib/finance/expenses.ts` (specifically `CounterpartyRuleRef` type at lines 98-101 and `resolveExpenseMapping` at lines 108-125 — read this exact range before editing)
- Modify: `lib/finance/rampExpenses.ts` (the `syncExpenseRecords` call site at lines 233-242 — read this exact range)
- Modify: `app/api/finance/expenses/route.ts` (the PATCH clear-override call site at lines 119-124 — read this exact range)
- Modify/create tests for each of the above (extend existing test files if present; check for `lib/finance/expenses.test.ts` and `lib/finance/rampExpenses.test.ts` first — extend rather than duplicate).

**Interfaces:**
- Consumes: `expense_counterparty_mappings.routing` column (Group 1).
- Produces: `CounterpartyRuleRef` gains a `routing: "single_account" | "payroll_split"` field (read from the same query that currently builds `counterpartyRules`, add `routing` to its `select`). `resolveExpenseMapping` gains one new early-return branch: when the matched counterparty rule (before applying it) has `routing === "payroll_split"`, return `{ chart_of_accounts_id: null, mapping_source: "unmapped" }` instead of applying the rule — leaving the expense unmapped for the normal path so it surfaces for payroll matching (Task 8) instead.

**Acceptance criteria:**
- A counterparty rule with `routing: "single_account"` (the default — every existing rule) behaves exactly as today; this is a pure addition, not a behavior change for non-payroll counterparties.
- A counterparty rule with `routing: "payroll_split"` never gets applied by `resolveExpenseMapping` — verify via a test using a Gusto-like counterparty key with `routing: "payroll_split"` set, asserting the expense comes back unmapped rather than coded to the rule's `chart_of_accounts_id`.
- Both call sites (`rampExpenses.ts` ingest, `expenses/route.ts` PATCH) pass the now-required `routing` field through when building `counterpartyRules` — a build/typecheck error should occur if either is missed, since `CounterpartyRuleRef` is no longer satisfiable without it.

- [ ] **Step 1: Read the exact current content of all three files at the line ranges above.**
- [ ] **Step 2: Write/extend failing tests** for the `payroll_split` skip behavior.
- [ ] **Step 3: Run, confirm failure.**
- [ ] **Step 4: Implement the type + resolver + both call-site changes.**
- [ ] **Step 5: Run, confirm pass.** Also run `npm run verify` to catch any other `CounterpartyRuleRef` construction site this change might have missed.
- [ ] **Step 6: Commit.**

```bash
git add lib/finance/expenses.ts lib/finance/rampExpenses.ts app/api/finance/expenses/route.ts
git commit -m "feat(finance): skip counterparty auto-mapping for payroll-routed rules"
```

### Task 7: Financials aggregation — split-aware expense resolution

**Model:** Sonnet

**Files:**
- Modify: `lib/finance/financials/fetchSources.ts` (`fetchExpenses`, lines 354-379 — read this exact range)
- Modify: `lib/finance/financials/aggregateRows.ts` (`ExpenseRecord` interface at lines 75-82, and the `input.expenses` loop at lines 308-320 — read this exact range)
- Modify tests: locate and extend the existing test file(s) for `aggregateRows.ts` and `fetchSources.ts` (search `lib/finance/financials/*.test.ts` first).

**Interfaces:**
- Consumes: `getExpenseGlLines`/`resolveExpenseGlLines` (Task 4).
- Produces: `ExpenseRecord` (in `aggregateRows.ts`) gains an optional field:
```ts
export interface ExpenseRecord {
  id: string;
  chartOfAccountsId: string | null;
  amountCents: number;
  accountingDate: string | null;
  mappingSource: MappingSource;
  /** Populated by fetchExpenses via a join to expense_gl_splits; undefined/[] when the expense has no split. */
  splitLines?: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" }[];
}
```

**`fetchExpenses` change:** after the existing `fetchAllRows` query, batch-fetch `expense_gl_splits` for all returned expense IDs (`.from("expense_gl_splits").select("expense_id, chart_of_accounts_id, amount_cents, split_source").in("expense_id", ids)`), group by `expense_id`, and attach as `splitLines` on the mapped `ExpenseRecord[]`.

**`aggregateRows.ts` loop change (non-obvious — implement exactly):** replace the single `resolveExpenseLike(...)` call per expense row with: if `row.splitLines?.length`, call `resolveExpenseLike` once **per split line** (same `table: "expenses"`, same `id: row.id"` — note: this means `groupKey`'s per-row identity is no longer 1:1 with a resolved row when split; that's fine, `groupKey` already groups by `(table, coaId, channel, ...)` not by row id, so multiple resolved rows sharing a `table`+`id` just group separately by their different `coaId`s), passing that line's own `chartOfAccountsId`/`amountCents`, and mapping `splitSource: "payroll_auto"` → `mappingSource: "rule"`, `splitSource: "manual"` → `mappingSource: "manual"` (matches the existing `MappingSource` semantics: `"rule"` = automatically derived, `"manual"` = user override). Otherwise (no split lines), keep today's single-call behavior unchanged.

```ts
for (const row of input.expenses) {
  const lines = row.splitLines?.length
    ? row.splitLines.map((l) => ({
        coaId: l.chartOfAccountsId,
        amountCents: l.amountCents,
        mappingSource: (l.splitSource === "manual" ? "manual" : "rule") as MappingSource,
      }))
    : [{ coaId: row.chartOfAccountsId, amountCents: row.amountCents, mappingSource: row.mappingSource }];
  for (const line of lines) {
    const r = resolveExpenseLike("expenses", row.id, line.coaId, line.mappingSource, line.amountCents, row.accountingDate, coaMap, "expense");
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }
}
```

**Acceptance criteria:**
- An expense with no split lines produces exactly the same `ResolvedRow` as before this change (regression safety — write this as an explicit test, not just an assumption).
- An expense with split lines produces one `ResolvedRow` per line, each with that line's own `coaId`/`amountCents`, and the sum of those lines' `amountCents` equals the original expense's `amountCents` (this is guaranteed upstream by Task 5's rounding algorithm, but assert it here too since a regression here silently mis-books real dollars per the design doc's testing note).
- `fetchExpenses`'s split-lines join does not N+1 — one batched `.in("expense_id", ids)` query, not one query per expense.

**Test cases:**
- No-split expense: unchanged single `ResolvedRow`.
- Split expense (2-3 lines): N `ResolvedRow`s, amounts sum to the original, `mappingSource` mapped correctly per `splitSource`.
- `fetchExpenses` with a mix of split and non-split expenses in one range: correct `splitLines` attached only to the ones with rows in `expense_gl_splits`.

- [ ] **Step 1: Read the exact current content of both files at the line ranges above, plus their existing test file(s).**
- [ ] **Step 2: Write/extend failing tests.**
- [ ] **Step 3: Run, confirm failure.**
- [ ] **Step 4: Implement both changes.**
- [ ] **Step 5: Run, confirm pass.** Run `npm run verify` — this touches shared Financials aggregation, so a full lint/typecheck/test pass matters more here than on other tasks.
- [ ] **Step 6: Commit.**

```bash
git add lib/finance/financials/fetchSources.ts lib/finance/financials/aggregateRows.ts
git commit -m "feat(finance): make Financials aggregation split-line aware for expenses"
```

---

## Locality Group 4 — Finance API routes (`app/api/finance/`)

**Consumes:** Group 3's `payrollMatching.ts`/`expenseGlLines.ts`; Group 1's tables.

### Task 8: Payroll-match action route + Expenses list enrichment

**Model:** Sonnet

**Files:**
- Create: `app/api/finance/expenses/[id]/payroll-match/route.ts`
- Create: `app/api/finance/expenses/[id]/payroll-match/route.test.ts`
- Create: `app/api/finance/payroll-periods/[periodId]/recompute-splits/route.ts`
- Create: `app/api/finance/payroll-periods/[periodId]/recompute-splits/route.test.ts`
- Modify: `app/api/finance/expenses/route.ts` (the GET handler at lines 24-61 — read this exact range)

**Interfaces:**
- Consumes: `suggestPayPeriod`, `recomputePeriodExpenseSplits` (Task 5); `getExpenseGlLines` (Task 4).
- Produces: `POST /api/finance/expenses/[id]/payroll-match` body `{ action: "suggest" } | { action: "match"; payPeriodId: string } | { action: "unmatch" } | { action: "recompute" }`:
  - `"suggest"` — reads unmatched `pay_periods` (join `payroll_period_expense_matches` to exclude already-matched ones) within the 10-day window of the expense's `accounting_date`/`transaction_time`, calls `suggestPayPeriod`, returns `{ suggestedPeriodId: string | null }`.
  - `"match"` — inserts a `payroll_period_expense_matches` row, then calls `recomputePeriodExpenseSplits(sb, payPeriodId)` (Task 5) to refresh every expense matched to that period, not just this one — matching a new expense changes every other matched expense's proportional weight too.
  - `"unmatch"` — deletes the `payroll_period_expense_matches` row and any `'payroll_auto'` `expense_gl_splits` rows for this expense, then calls `recomputePeriodExpenseSplits` for the period so the remaining matched expenses' weights rebalance.
  - `"recompute"` — if any `expense_gl_splits` row for THIS expense has `split_source: 'manual'`, return `409` with `{ error: "manual_override_exists" }` unless the body sets `confirmOverwriteManual: true`; otherwise calls `recomputePeriodExpenseSplits` for the expense's period (period-wide, same reasoning as `"match"`).
- `POST /api/finance/payroll-periods/[periodId]/recompute-splits` — thin wrapper calling `recomputePeriodExpenseSplits(sb, periodId)` directly, no expense-scoped `:id` needed. This is what Task 11 calls right after a successful Gusto upload (see Task 3's note and Task 11).
- GET `app/api/finance/expenses/route.ts` response gains, per expense row: `payrollMatch: { payPeriodId: string; hasReport: boolean } | null` and `glLines: ExpenseGlLine[]` (from `getExpenseGlLines`), so the Transactions UI (Group 7) can render match/split state without a second round-trip per row.

**Acceptance criteria:**
- All actions on both routes gate with `requireRole(["manager"])`, use `createSupabaseAdminClient()`, wrap in `try/catch` → `apiError(err)`.
- Neither route duplicates Task 5's proportional-split or manual-skip logic inline — both are thin orchestration over `recomputePeriodExpenseSplits`/`suggestPayPeriod`.
- GET enrichment does not N+1 per row — batch the `payroll_period_expense_matches` and `expense_gl_splits` lookups by the full set of expense IDs in the response, same pattern as Task 7's `fetchExpenses` join.

**Test cases:**
- `"suggest"` returns the nearest unmatched period within the window, `null` outside it.
- `"match"` inserts the match row and produces correct proportional splits across all expenses matched to that period (reuse Task 5's fixture numbers).
- `"match"` when the period has no active report: inserts the match row but writes no `expense_gl_splits` rows (awaiting-upload state).
- `"unmatch"` removes both the match row and `'payroll_auto'` splits for that expense, and rebalances the remaining matched expenses' splits.
- `"recompute"` with an existing `'manual'` row → `409` without `confirmOverwriteManual`; succeeds with it `true`.
- GET response includes `payrollMatch`/`glLines` correctly for matched, unmatched, and awaiting-upload expenses.
- `POST .../recompute-splits` regenerates splits for a period's matched expenses (e.g. after a re-upload changed the period's totals).

- [ ] **Step 1: Read `app/api/finance/expenses/route.ts` lines 24-61, and an existing similar action route (e.g. `app/api/tax/tasks/[id]/files/route.ts`) for the gating/error pattern.**
- [ ] **Step 2: Write failing tests for both routes' actions plus the GET enrichment.**
- [ ] **Step 3: Run, confirm failure.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run, confirm pass.**
- [ ] **Step 6: Commit.**

```bash
git add app/api/finance/expenses/[id]/payroll-match/route.ts app/api/finance/expenses/[id]/payroll-match/route.test.ts app/api/finance/payroll-periods/[periodId]/recompute-splits/route.ts app/api/finance/payroll-periods/[periodId]/recompute-splits/route.test.ts app/api/finance/expenses/route.ts
git commit -m "feat(finance): add payroll period matching API"
```

### Task 9: Payroll department mapping settings route

**Model:** Sonnet

**Files:**
- Create: `app/api/finance/settings/payroll-department-mappings/route.ts`
- Create: `app/api/finance/settings/payroll-department-mappings/route.test.ts`

**Interfaces:**
- Produces: `GET` returns `{ mappings: PayrollDepartmentGlMapping[]; payrollTaxesAccountId: string | null }`. `PUT` body `{ mappings: { departmentName: string; chartOfAccountsId: string }[]; payrollTaxesAccountId: string }` — upserts `payroll_department_gl_mappings` (unique on `department_name`) and upserts the singleton `payroll_gl_settings` row.

**Acceptance criteria:**
- Gate with `requireRole(["manager"])`, `createSupabaseAdminClient()`, `apiError()` on failure — same convention as every other route in this plan.
- `PUT` replaces the full mapping set (delete-then-insert or upsert-by-department_name — either is fine, but must not leave stale department mappings that were removed from the submitted list).

**Test cases:**
- GET returns current mappings + tax account setting.
- PUT with a new department adds it; PUT omitting a previously-mapped department removes it.
- PUT upserts the singleton `payroll_gl_settings` row correctly on first save and on update.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Commit.**

```bash
git add app/api/finance/settings/payroll-department-mappings/route.ts app/api/finance/settings/payroll-department-mappings/route.test.ts
git commit -m "feat(finance): add payroll department GL mapping settings API"
```

---

## Locality Group 5 — Settings UI (`app/finance/settings/`)

**Consumes:** Task 6 (`routing` field), Task 9 (department-mappings API).
**Extended Documentation Trigger:** read `docs/UI_STANDARD.md` before this group's UI work.

### Task 10: Counterparty routing toggle + department mapping settings page

**Model:** Sonnet

**Files:**
- Modify: `app/finance/settings/counterparty-accounts/page.tsx` (read in full first — `RuleRow` type at lines 13-20, `handleSetRule` at lines 50-62, table row rendering at lines 109-130)
- Create: `app/finance/settings/payroll-department-mappings/page.tsx`
- Modify: whichever `nav-config.ts` under `app/finance/settings/` lists existing settings sub-pages (find it, add the new page's entry).

**Interfaces:**
- Consumes: Task 9's `GET`/`PUT /api/finance/settings/payroll-department-mappings`; the existing `GET /api/finance/expense-counterparty-mappings` (now also returning `routing` per Task 6) and its `PATCH` (extend body to accept `routing`).

**Acceptance criteria:**
- `counterparty-accounts/page.tsx`: `RuleRow` gains `routing: "single_account" | "payroll_split"`; add a toggle/select next to the existing `AccountSelect` (line ~119-127) that PATCHes `{ id, routing }`; when `routing === "payroll_split"`, visually de-emphasize or hide the `AccountSelect` for that row (a payroll-split rule has no single account to display) using existing token utilities/`<Badge>` — no raw colors.
- `payroll-department-mappings/page.tsx`: a table of `department_name` → `AccountSelect` (reuse the existing `AccountSelect` component, don't reinvent it), plus one `AccountSelect` for the payroll-taxes account setting, an "Add department" row, save via Task 9's `PUT`. Follow `<PageHeader>`/`<Card>`/`.inp`/`.btn-primary` conventions per `docs/UI_STANDARD.md`.
- New page is reachable from the settings nav (verify the nav-config entry renders).

- [ ] **Step 1: Read `docs/UI_STANDARD.md` and the full current content of `counterparty-accounts/page.tsx`.**
- [ ] **Step 2: Implement both UI changes.**
- [ ] **Step 3: Run `npm run dev`, navigate to both settings pages, verify the toggle and the new mapping table render and save correctly (use the Browser tools, not a manual-check request to the user).**
- [ ] **Step 4: Run `npm run verify`.**
- [ ] **Step 5: Commit.**

```bash
git add app/finance/settings/counterparty-accounts/page.tsx app/finance/settings/payroll-department-mappings/page.tsx
git commit -m "feat(finance): add payroll routing toggle and department GL mapping settings UI"
```

---

## Locality Group 6 — Payroll UI (`app/components/payroll/`)

**Consumes:** Task 3's upload route; Task 8's payroll-match route (for the matched-expenses list within the period view).
**Extended Documentation Trigger:** read `docs/UI_STANDARD.md` before this group's UI work.

### Task 11: Gusto Upload tab

**Model:** Sonnet

**Files:**
- Create: `app/components/payroll/GustoUploadPanel.tsx`
- Modify: `app/components/payroll/PayrollPeriodView.tsx` (read in full first — `PayrollTab` union at line 15, `TAB_LABELS` at 17-21, `Props` at 23-28, tab-content switch at 160-282)
- Modify: `app/finance/payroll/[periodId]/page.tsx` (line 32 — add `"gustoUpload"` to the `tabs` array passed in)

**Interfaces:**
- Consumes: `GET`/`POST /api/payroll/periods/[id]/gusto-report` (Task 3); `POST /api/finance/payroll-periods/[periodId]/recompute-splits` (Task 8); `GET /api/finance/expenses/[id]/payroll-match?periodId=...` or equivalent list of expenses matched to this period (extend Task 8's route with a `GET ?payPeriodId=` mode, or add this as a small addition to Task 3's `GET` — implementer's choice, document which was chosen in the commit).

**Acceptance criteria:**
- `PayrollTab` union extends to `"summary" | "shifts" | "gusto" | "gustoUpload"`; `TAB_LABELS` gets a `"Gusto Upload"` entry.
- `GustoUploadPanel`: file upload control, parsed employee table (audit view — last/first name, department, gross, employer tax), GL totals summary (account name/number + amount per bucket), unmapped-department warning banner (from Task 2/3's `unmappedDepartments`), matched-expenses list with a reconciliation line (`sum(matched) vs sum(report totals)`, flagged past $1 variance), and an "N transaction(s) waiting on a Gusto upload" banner when matches exist but no active report — per design doc §4 alerting rules.
- **After a successful upload (Task 3's `POST` resolves), immediately call `POST /api/finance/payroll-periods/[periodId]/recompute-splits`** before refreshing the matched-expenses list — this is what makes a corrected re-upload actually update already-matched expenses' splits (the gap noted in Task 3).
- Uses `<Card>`, `<Banner>`, `.btn-primary`, token color utilities only.

- [ ] **Step 1: Read `docs/UI_STANDARD.md` and the full current content of `PayrollPeriodView.tsx`.**
- [ ] **Step 2: Implement the tab + panel + page wiring.**
- [ ] **Step 3: Run `npm run dev`, upload a test CSV (use the design doc's sample data as a fixture file) on a real pay period, verify parsed table + totals + banners render correctly via the Browser tools.**
- [ ] **Step 4: Run `npm run verify`.**
- [ ] **Step 5: Commit.**

```bash
git add app/components/payroll/GustoUploadPanel.tsx app/components/payroll/PayrollPeriodView.tsx app/finance/payroll/[periodId]/page.tsx
git commit -m "feat(payroll): add Gusto payroll report upload tab"
```

---

## Locality Group 7 — Transactions UI (`app/finance/transactions/expenses/`)

**Consumes:** Task 8's enriched GET response (`payrollMatch`, `glLines`) and payroll-match action route.
**Extended Documentation Trigger:** read `docs/UI_STANDARD.md` before this group's UI work.

### Task 12: Payroll split cell in the Expenses table

**Model:** Sonnet

**Files:**
- Create: `app/finance/transactions/expenses/PayrollSplitCell.tsx`
- Modify: `app/finance/transactions/expenses/page.tsx` (read in full first — `ExpenseRow` type at lines 30-53, `ExpenseRowView` at lines 91-190, main row `<tr>` at 114-144, expanded detail row at 146-189)

**Interfaces:**
- Consumes: Task 8's `POST /api/finance/expenses/[id]/payroll-match` (`"suggest"`/`"match"`/`"unmatch"`/`"recompute"` actions) and the enriched GET fields.
- Produces: `ExpenseRow` gains `payrollMatch: { payPeriodId: string; hasReport: boolean } | null` and `glLines: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" | null }[]`.

```tsx
interface PayrollSplitCellProps {
  expenseId: string;
  routing: "single_account" | "payroll_split"; // from the expense's counterparty mapping — gate rendering on this
  payrollMatch: { payPeriodId: string; hasReport: boolean } | null;
  glLines: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" | null }[];
  accounts: CoARef[]; // for rendering account_number/name from chartOfAccountsId
  onChanged: () => void; // triggers the page's loadAll() refetch after any action
}
export function PayrollSplitCell(props: PayrollSplitCellProps): JSX.Element;
```

**Acceptance criteria:**
- Only rendered for expenses whose counterparty mapping has `routing === "payroll_split"` (gate in the parent, per the `ramp_object === "bank"` condition already noted in the survey — combine both conditions).
- Three visual states per design doc §4/§5: unmatched → "Match payroll period" button (calls `"suggest"` then confirms via `"match"`); matched + `hasReport` false → "Payroll — awaiting Gusto upload" badge; matched + split lines present → expandable breakdown showing each `glLines` entry's account + amount, plus a "Recompute" icon action (`"recompute"`).
- Uses `<Badge tone>`, `.btn-xxs` (dense table-action row, per the UI standard's explicit exemption for this case), token colors only.

**Test cases (component-level, if this repo has component tests — otherwise cover via the manual Browser verification step):**
- N/A if no existing component-test precedent in `app/finance/transactions/expenses/` — check for one before deciding; if none exists, rely on Step 3's Browser verification instead of inventing a new test pattern for this one component.

- [ ] **Step 1: Read `docs/UI_STANDARD.md` and the full current content of `page.tsx`.**
- [ ] **Step 2: Implement `PayrollSplitCell` and wire it into `ExpenseRowView`/`ExpenseRow`.**
- [ ] **Step 3: Run `npm run dev`, verify all three states render correctly for a manually-flagged Gusto expense via the Browser tools (match, awaiting-upload, split-with-breakdown).**
- [ ] **Step 4: Run `npm run verify`.**
- [ ] **Step 5: Commit.**

```bash
git add app/finance/transactions/expenses/PayrollSplitCell.tsx app/finance/transactions/expenses/page.tsx
git commit -m "feat(finance): show payroll GL split in the Transactions expenses table"
```

---

## Final Review

After all 7 locality groups land: one whole-branch Opus review per CLAUDE.md's "Final whole-branch review → Opus, once per feature" rule, covering the full diff — particularly Task 7 (Financials aggregation correctness, since a bug there silently mis-books real dollars) and Task 5's rounding-exactness property.
