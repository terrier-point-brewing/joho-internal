# PR A — Manual Entries in Finance > Transactions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move manual financial entries out of Taproom > Targets into an auditable `Finance > Transactions > Manual Entries` subtab on a new `manual_entries` table that supports both prorated flows (P&L) and point-in-time balances (Balance Sheet).

**Execution Budget:** subagent-driven-development · **Spawn cap = 7** (5 locality groups + 2) · target ≈ 220k tokens. STOP and report before exceeding the cap.

**Architecture:** One new table replaces `manual_net_sales_entries`, discriminated by `entry_kind` — `flow` rows carry a date range and prorate by day overlap (today's behavior), `balance` rows carry a month-end `as_of_date` and are consumed by PR B's snapshot layer. Auditability comes from the existing generic `audit_trigger_fn()`. The P&L consumer (`injectManualNetSales`) is rewired to the new table with its proration math unchanged.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-balance-sheet-gl-mapping-design.md` §3

## Global Constraints

- **No full implementation bodies in this plan.** Per `CLAUDE.md`, plans specify file maps, interfaces, signatures, acceptance criteria and test cases. Inline code appears only for genuinely non-obvious logic, capped at ~20 lines per task. This overrides the writing-plans skill's "complete code in every step" default — the plan is not under-specified, it is deliberately scoped.
- **Every new/modified `lib/` module ships a co-located `*.test.ts`.** Do not drop `lib/` coverage below the `vitest.config.ts` threshold floor.
- **DoD command:** `npm run verify` (lint + typecheck + tests) must pass before each commit.
- **UI:** `docs/UI_STANDARD.md` is binding. Token utilities only — no `zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*`, no hex/rgb literals. Primitives only — `.btn-primary`/`.btn-secondary`/`.btn-danger`, `.inp`/`.inp-sm`, `<Card>`, `<Modal>`/`<ModalActions>`/`<Field>`, `<Banner>`, `<Badge tone>`, `<PageHeader>`, `<SubNav>`/`<TabBar>`. No hand-rolled buttons or local `inputCls`.
- **Auth:** reads `CAP.financeTransactionsRead`, writes `CAP.financeTransactionsManage`. Never roll your own role logic — use `lib/auth`.
- **Supabase client per context:** `lib/supabase/server.ts` in route handlers, `browser.ts` in client components, `admin.ts` only for privileged ops.
- **API routes:** wrap errors with `apiError()` from `lib/utils/api.ts`.
- **Migrations:** never hand-edit an existing migration. `scripts/check-migrations.mjs` fails CI on duplicate numeric prefixes — this PR owns prefix `20260902` exclusively.
- **Subagents never apply migrations.** Authoring the `.sql` file is in scope; running it against any database is orchestrator-only, after explicit user approval and a backup.

## Task Table

| # | Task | Files | Model | Locality group |
|---|---|---|---|---|
| 1 | Migration + pure validators | 3 | **Opus** | data layer |
| 2 | API route | 2 | Sonnet | api |
| 3 | Rewire the P&L consumer | 5 | Sonnet | financials |
| 4 | Manual Entries subtab UI | 2 | Sonnet | ui |
| 5 | Remove Manual Entries from Taproom | 4 | Haiku | taproom |

Task 1 is **Opus** because its migration performs an irreversible data operation — it copies rows out of `manual_net_sales_entries` and then drops that table. Task 5 is **Haiku** because it is pure deletion plus a one-line nav edit, fully specified.

---

### Task 1: Migration + pure validators

**Files:**
- Create: `supabase/migrations/20260902_manual_entries.sql`
- Create: `lib/finance/manualEntries.ts`
- Create: `lib/finance/manualEntries.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces — every later task depends on these exact names:

```ts
export type ManualEntryKind = "flow" | "balance";

export interface ManualEntryRecord {
  id: string;
  entryKind: ManualEntryKind;
  chartOfAccountsId: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  amountCents: number;
  label: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type ManualEntryInput =
  | { entryKind: "flow";    chartOfAccountsId: string; startDate: string; endDate: string; amountCents: number; label?: string | null; note?: string | null }
  | { entryKind: "balance"; chartOfAccountsId: string; asOfDate: string;                    amountCents: number; label?: string | null; note?: string | null };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateManualEntry(input: ManualEntryInput): ValidationResult;
export function monthEnd(date: string): string;
```

**Schema produced** (route and UI tasks read these column names):

`manual_entries` — `id`, `entry_kind`, `chart_of_accounts_id`, `start_date`, `end_date`, `as_of_date`, `amount_cents`, `label`, `note`, `mapping_source`, `qb_remote_id`, `qb_sync_status`, `qb_synced_at`, `created_at`, `created_by`, `updated_at`, `updated_by`.

- [ ] **Step 1: Write the failing validator tests**

Create `lib/finance/manualEntries.test.ts` covering, at minimum:

*`validateManualEntry` rejects:* a `flow` missing `endDate`; a `flow` whose `startDate > endDate`; a `flow` carrying `asOfDate`; a `balance` carrying `startDate`/`endDate`; a `balance` whose `asOfDate` is not a month end (`"2026-07-15"`); `amountCents` that is zero, negative-zero, or non-integer.

*`validateManualEntry` accepts:* a well-formed `flow` spanning one day (`startDate === endDate`); a well-formed `balance` on `"2026-07-31"`; a `balance` with a **negative** `amountCents` (contra-accounts and credit-side accounts are legitimately negative — see spec §2.2; a positivity check here would be a bug).

*`monthEnd`:* `"2026-01-15"` → `"2026-01-31"`; `"2024-02-01"` → `"2024-02-29"` (leap); `"2026-02-10"` → `"2026-02-28"` (non-leap); `"2026-12-05"` → `"2026-12-31"`; an already-month-end date is idempotent.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/finance/manualEntries.test.ts
```

Expected: FAIL — `manualEntries.ts` does not exist / exports not found.

- [ ] **Step 3: Implement `lib/finance/manualEntries.ts`**

Types and both functions per the Interfaces block. `validateManualEntry` must mirror the DB CHECK exactly so the API returns a readable 400 before Postgres raises `23514`. Return the *first* failure with a message naming the offending field.

`monthEnd` takes and returns `"YYYY-MM-DD"`. Compute in UTC (`Date.UTC(y, m, 0)` gives the last day of month `m`) — the codebase's date helpers are UTC-based throughout and a local-time implementation drifts by a day for negative-offset zones.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/finance/manualEntries.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Author the migration**

Create `supabase/migrations/20260902_manual_entries.sql` with these sections, in this order:

1. `create table manual_entries (...)` — columns per the Interfaces block. `amount_cents bigint not null` (signed). `mapping_source text not null default 'manual'`. Timestamps default `now()`. `created_by`/`updated_by` reference `auth.users(id)`.

2. The kind/date CHECK constraint. This is the non-obvious part, so it is given in full:

```sql
constraint manual_entries_kind_dates check (
  (entry_kind = 'flow'
     and start_date is not null and end_date is not null
     and as_of_date is null and start_date <= end_date)
  or
  (entry_kind = 'balance'
     and as_of_date is not null
     and start_date is null and end_date is null
     and as_of_date = (date_trunc('month', as_of_date) + interval '1 month - 1 day')::date)
)
```

The month-end clause is load-bearing: PR B's snapshot layer only ever reads balances keyed to a month end, so a mid-month value would be silently invisible. The database rejects it instead of the app discovering it later.

3. The partial unique index — one balance per account per period, so a correction is an `UPDATE` with history in `audit_log`, never a duplicate row:

```sql
create unique index manual_entries_one_balance_per_period
  on manual_entries (chart_of_accounts_id, as_of_date)
  where entry_kind = 'balance';
```

4. `create index manual_entries_coa_kind on manual_entries (chart_of_accounts_id, entry_kind);`

5. Audit trigger, reusing the existing generic function defined at
   `supabase/migrations/20260609_baseline.sql:408` (do not write a new one —
   this function already backs 16 production tables):

```sql
create trigger manual_entries_audit
  after insert or update or delete on manual_entries
  for each row execute function audit_trigger_fn();
```

6. `alter table manual_entries enable row level security;` then the one-line applicator from `20260822_rls_grant_aware_policies.sql`:

```sql
select public.apply_grant_policies('manual_entries', 'finance.transactions');
```

Note: that helper grants write at `operate` level while the app layer gates on `manage`. The app is deliberately the stricter of the two; do not loosen the app guard to match.

7. **Data migration.** Copy every `manual_net_sales_entries` row in as `entry_kind = 'flow'`, with `chart_of_accounts_id` resolved by subquery from `chart_of_accounts` where `account_number = '4100'` (`BREWERY REVENUE:Taproom Revenue`). Preserve `start_date`, `end_date`, `amount_cents`, `label`, and the original `created_at`. Leave `created_by` null — the source table never recorded it and backfilling a guess would be worse than an honest null.

   Guard the resolve: if `4100` is absent, `raise exception` rather than inserting nulls. A silent null `chart_of_accounts_id` would violate `not null` anyway, but an explicit message names the cause.

8. `drop table manual_net_sales_entries;`

- [ ] **Step 6: Verify migration prefix uniqueness**

```bash
node scripts/check-migrations.mjs --strict
```

Expected: exit 0, no duplicate-version report for `20260902`.

- [ ] **Step 7: Full verify and commit**

```bash
npm run verify
```

```bash
git add supabase/migrations/20260902_manual_entries.sql lib/finance/manualEntries.ts lib/finance/manualEntries.test.ts
git commit -m "feat(finance): manual_entries table and validators"
```

**Acceptance criteria:**
- All validator tests pass.
- `check-migrations.mjs --strict` reports no collision.
- The migration is authored but **not applied** — application is an orchestrator step gated on user approval and a backup.

---

### Task 2: API route

**Files:**
- Create: `app/api/finance/manual-entries/route.ts`
- Modify: `lib/query-keys.ts`

**Interfaces:**
- Consumes: `validateManualEntry`, `monthEnd`, `ManualEntryInput`, `ManualEntryRecord` from Task 1.
- Produces:
  - `GET /api/finance/manual-entries?kind=flow|balance&year=YYYY` → `ManualEntryRecord[]`, newest first. Both params optional; absent `kind` returns both kinds.
  - `POST` body `ManualEntryInput` → the created `ManualEntryRecord` (201).
  - `PATCH` body `{ id: string } & Partial<ManualEntryInput>` → the updated record.
  - `DELETE` body `{ id: string }` → `{ ok: true }`.
  - `queryKeys.finance.manualEntries(kind: string, year: number)` in `lib/query-keys.ts`.

- [ ] **Step 1: Add the query key**

In `lib/query-keys.ts`, inside the existing `finance` block (around line 91-102), add:

```ts
manualEntries: (kind: string, year: number) => ["finance", "manual-entries", kind, year] as const,
```

Leave `taproom.manualEntries` (line 109) alone for now — Task 5 removes it.

- [ ] **Step 2: Implement the route**

`export const dynamic = "force-dynamic";`

Use `createSupabaseServerClient()` from `lib/supabase/server` (a route handler must never use the browser client). Wrap every catch with `apiError(err)` from `lib/utils/api.ts`.

Guards: `GET` → `requirePermission(CAP.financeTransactionsRead)`; `POST`/`PATCH`/`DELETE` → `requirePermission(CAP.financeTransactionsManage)`. Follow the existing `try { await requirePermission(...) } catch (res) { return res as Response }` idiom used in the route this replaces.

On `POST`/`PATCH`, call `validateManualEntry` **before** touching the database and return `400` with the returned `error` string on failure.

Set `created_by`/`updated_by` from the session user (`getSessionUser` via `lib/auth`), not from the request body — a client-supplied author would make the audit trail worthless.

Map the partial-unique-index violation (Postgres `23505` on `manual_entries_one_balance_per_period`) to a `409` with a message telling the caller a balance already exists for that account and period and to edit it instead. Any other error falls through to `apiError`.

- [ ] **Step 3: Verify the route compiles and typechecks**

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/finance/manual-entries/route.ts lib/query-keys.ts
git commit -m "feat(finance): manual entries API route"
```

**Acceptance criteria:**
- All four verbs implemented with the correct capability on each.
- Invalid input returns 400 with a field-naming message, never a 500.
- A duplicate balance for the same (account, period) returns 409, not 500.
- `created_by` comes from the session, never the request body.

---

### Task 3: Rewire the P&L consumer

**Files:**
- Modify: `lib/finance/financials/fetchSources.ts`
- Modify: `lib/finance/financials/manualNetSales.ts`
- Modify: `lib/finance/financials/manualNetSales.test.ts`
- Modify: `lib/finance/financials/summaries.ts`
- Modify: `lib/finance/financials/summaries.test.ts`

**Interfaces:**
- Consumes: the `manual_entries` schema from Task 1.
- Produces: `ManualNetSalesEntryRecord` gains a `chartOfAccountsId: string` field. `injectManualNetSales`'s signature is otherwise unchanged.

**Context — what exists today.** `manualNetSales.ts:103-116` synthesizes one `FinancialsRow` with `coaId: null`, `statementSection: "revenue"` hardcoded, and `sourceRef.table === "manual_net_sales_entries"`. `summaries.ts`'s `buildDataQuality` special-cases that table name to keep the row out of the unmapped bucket. Both workarounds exist only because the row had no account. It has one now.

- [ ] **Step 1: Update the failing tests first**

In `manualNetSales.test.ts`: add `chartOfAccountsId` to every `ManualNetSalesEntryRecord` fixture. Add a new case asserting the synthesized row carries that real `coaId` (not null) and a `statementSection` derived from the account rather than the hardcoded `"revenue"`.

**Do not change any existing proration assertion.** `proratedManualAdjustment`'s math does not move in this task; its frozen expected values are the equivalence gate proving the rewire did not alter P&L figures. If a proration expectation needs editing to pass, that is a defect in the change, not in the test.

In `summaries.test.ts`: add a case asserting a manual flow entry with a real `coaId` is **not** counted in the unmapped bucket, now that it is genuinely mapped.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/finance/financials/manualNetSales.test.ts lib/finance/financials/summaries.test.ts
```

Expected: FAIL on the new assertions; existing proration cases still pass.

- [ ] **Step 3: Rewire the fetch**

In `fetchSources.ts`, change the manual-net-sales fetch to read `manual_entries` filtered to `entry_kind = 'flow'`, selecting `id, start_date, end_date, amount_cents, chart_of_accounts_id`, and map `chart_of_accounts_id` onto the new `chartOfAccountsId` field.

The existing balance-sheet guard stays: this source remains `[]` for `statement === "balance_sheet"`.

- [ ] **Step 4: Use the real account**

In `manualNetSales.ts`, set the synthesized row's `coaId` from `chartOfAccountsId` and derive `statementSection` via `aggregateRows.ts`'s exported `coaSection()` rather than the hardcoded `"revenue"`, so a manual entry coded to a non-revenue account lands in the right section instead of being mis-filed.

Keep `channel: "taproom"` — these are taproom plugs and the channel is not account-derived.

Remove the now-dead `MANUAL_TABLE` special case from `summaries.ts`'s `buildDataQuality`, and update `MANUAL_TABLE`'s value in `manualNetSales.ts` to `"manual_entries"` so `sourceRef` stays truthful.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run lib/finance/financials/
```

Expected: PASS — including every untouched proration assertion.

- [ ] **Step 6: Full verify and commit**

```bash
npm run verify
```

```bash
git add lib/finance/financials/
git commit -m "feat(finance): read manual net-sales plugs from manual_entries"
```

**Acceptance criteria:**
- Every pre-existing proration expectation passes **unmodified**.
- The synthesized row carries a real `coaId` and a `coaSection`-derived `statementSection`.
- `buildDataQuality` no longer special-cases a table name.

---

### Task 4: Manual Entries subtab UI

**Files:**
- Create: `app/finance/transactions/manual-entries/page.tsx`
- Modify: `app/finance/transactions/TransactionsNav.tsx`

**Interfaces:**
- Consumes: the API from Task 2, `queryKeys.finance.manualEntries`, and `ManualEntryRecord`/`ManualEntryKind` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the nav entry**

In `TransactionsNav.tsx`, append to `TABS`:

```ts
{ href: "/finance/transactions/manual-entries", label: "Manual Entries" },
```

The parent `layout.tsx` already gates on `CAP.financeTransactionsRead` and supplies `<PageHeader>` — do not re-add either. Update the layout's `<PageHeader description>` to mention manual entries alongside orders, invoices, expenses and bank lines.

- [ ] **Step 2: Build the page**

Client component using TanStack Query against the Task 2 route.

*Controls row:* an entry-kind filter (All / Flows / Balances), a `<YearSelect>`, and a GL-account filter — reuse `app/finance/transactions/components/YearSelect.tsx` and `GlAccountFilter.tsx` rather than rebuilding either.

*Table columns:* Kind (`<Badge tone>`), Account (name + number), Date (a single `as_of_date`, or a `start – end` range), Amount, Per-Day (flows only — mirrors what the taproom tab shows today), Label, Last updated (who + when), and a row-action cell.

*Add / edit form:* a `<Modal>` with `<Field>` wrappers and `<ModalActions>`. The kind selector switches the date inputs between a range (flow) and a single month-end picker (balance). For the balance kind, snap the picked date to its month end via `monthEnd()` before submitting, and show the snapped value so the user sees what will be saved — the DB CHECK rejects anything else and a silent rejection would read as a broken form.

Amount input accepts negatives. Balance-sheet credit-side accounts are legitimately negative in the stored convention (spec §2.2); show a hint on the amount field when the selected account is a liability or equity account so the sign is not a surprise.

*Write gating:* `usePermissions()` + `can(CAP.financeTransactionsManage)` controls whether add/edit/delete render — same pattern as the component Task 5 deletes.

*Errors:* `<Banner>`. Surface the 409 from Task 2 as "a balance already exists for this account and period — edit it instead".

- [ ] **Step 3: Verify**

```bash
npm run verify
```

- [ ] **Step 4: Grep for UI standard violations**

```bash
grep -nE "zinc-|amber-|red-|green-|blue-|gray-|#[0-9a-fA-F]{3,6}|inputCls" app/finance/transactions/manual-entries/page.tsx
```

Expected: no matches. Note the grep does not cover `orange`/`yellow`; do not introduce those either.

- [ ] **Step 5: Commit**

```bash
git add app/finance/transactions/manual-entries/ app/finance/transactions/TransactionsNav.tsx app/finance/transactions/layout.tsx
git commit -m "feat(finance): Manual Entries transactions subtab"
```

**Acceptance criteria:**
- Both entry kinds are creatable, editable and deletable by a manager.
- A viewer sees the list and no write controls.
- Balance dates snap visibly to month end before submit.
- Negative amounts are accepted.
- The UI-standard grep is clean.

---

### Task 5: Remove Manual Entries from Taproom

**Files:**
- Delete: `app/taproom/targets/manual-entries/` (whole directory)
- Delete: `app/taproom/components/ManualEntriesTab.tsx`
- Delete: `app/api/manual-entries/route.ts`
- Modify: `app/taproom/nav-config.ts`

**Interfaces:**
- Consumes: nothing. This task is pure removal and must run **after** Task 4, so the replacement exists before the original disappears.
- Produces: nothing.

Manual entries are finance records and belong under Finance. This is a deliberate removal, not a redirect — Taproom > Targets keeps Achievement and Target Setting only.

- [ ] **Step 1: Delete the three paths**

```bash
git rm -r app/taproom/targets/manual-entries app/taproom/components/ManualEntriesTab.tsx app/api/manual-entries/route.ts
```

- [ ] **Step 2: Remove the nav entry**

In `app/taproom/nav-config.ts`, delete line 25:

```ts
{ href: "/taproom/targets/manual-entries", label: "Manual Entries" },
```

- [ ] **Step 3: Remove the orphaned query key**

In `lib/query-keys.ts`, delete `taproom.manualEntries` (line 109). Task 2 added the finance-scoped replacement.

- [ ] **Step 4: Confirm nothing still references the removed code**

```bash
grep -rn "ManualEntriesTab\|taproom/targets/manual-entries\|api/manual-entries\|taproom.manualEntries\|manual_net_sales_entries" app/ lib/ --include=*.ts --include=*.tsx
```

Expected: **no matches.** A hit on `manual_net_sales_entries` means Task 3 missed a read path and the table is about to be dropped out from under live code — stop and fix it before committing.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
```

```bash
git add -A app/taproom lib/query-keys.ts app/api
git commit -m "refactor(taproom): remove Manual Entries, now under Finance > Transactions"
```

**Acceptance criteria:**
- The grep in Step 4 returns nothing.
- Taproom > Targets renders with exactly two subtabs.
- `npm run verify` passes.

---

## Post-Implementation

**Orchestrator-only, after all five tasks are reviewed and merged:**

1. Back up `manual_net_sales_entries` before applying `20260902` — the migration drops it.
2. Apply the migration with explicit user approval. Verify the row count copied across matches the source count, and that every copied row resolved to GL 4100.
3. Confirm the P&L for a month containing a migrated entry reports the same net sales as before the migration. A drift here means the account resolution or the proration rewire is wrong.

**Known follow-up:** PR B modifies `app/api/finance/manual-entries/route.ts` to call `reconcileCloseTasks` after a balance write. That hook does not exist yet and is deliberately out of scope here.
