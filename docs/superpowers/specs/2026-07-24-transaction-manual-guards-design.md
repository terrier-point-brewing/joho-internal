# Transaction Manual Guards — Exclude & Split

**Date:** 2026-07-24
**Status:** Design approved, plan not yet written

## Goal

Give Finance > Transactions two manual guards over the Expenses ledger, and fix the
sync defect that motivated them:

1. **Exclude** a transaction that is a duplicate, removing it from every financial statement.
2. **Split** a transaction into components assigned to different GL accounts.
3. **Fix** the `buildBillTotals` double-count that stranded a duplicate Duke Energy row,
   and make sync self-heal so reclassification never strands another.

## Background — the defect that motivated this

Duke Energy is on the P&L twice for the same $4,833.55:

| Row | Source | Vendor | Date | Amount |
|---|---|---|---|---|
| 12 line items (one bill) | Ramp `bill` | `Duke Energy` | 2026-06-29 | −$4,833.55 |
| 1 line | Ramp `bank` | `DUKEENERGY` | 2026-07-16 | −$4,833.55 |

Both map to `COGS:Production / Brewing COGS:Brewery Utilities`. The P&L groups by GL
account, not vendor, so they sum.

The settlement dedup from PR #228 is working in principle — the bank line sits correctly in
`ramp_bank_ledger` as `flow_type='bill_settlement', affects_pl=false`. But a *second* live
row for the same `source_transaction_id` exists in `expenses`, re-written by the daily cron
(confirmed: `synced_at` advancing daily).

**Root cause:** `buildBillTotals` (`lib/finance/bankLedger.ts:56`) accumulates by bill id with
no per-line dedup:

```js
const prior = totalsByBillId.get(billId);
totalsByBillId.set(billId, { cents: (prior?.cents ?? 0) + Math.abs(row.amount_cents), vendorKey });
```

`rampSync.ts:37` feeds it two overlapping lists — bill lines already persisted in `expenses`
(120-day lookback) **plus** bills freshly fetched from the Ramp API (caller's window). A bill
present in both is counted twice, so its total comes out at exactly 2×.

Verified against the real numbers: seen once → set holds `483355`, matches the bank debit →
`bill_settlement`. Seen twice → set holds `966710`, no match → `operating_expense`.

This also explains the timeline exactly. The **webhook** resync uses a 2-day API window, so
the 6/29 bill is absent from `bills`, counted once, and matches — that is the correct ledger
row from 7/18. The **daily cron** uses a 45-day window that *does* include the bill, so it
double-counts and the match fails. The wider window is what breaks it, the precise opposite
of the intent documented at `rampSync.ts:15-19`.

Duke Energy is currently the only affected vendor (verified by matching every bank-sourced
expense against every bill total).

## Non-goals

- Exclude/split on the Orders, Invoices, or Bank Ledger sub-tabs. Bank Ledger already has
  `flow_type` as its manual lever; Orders and Invoices have no observed duplicate class.
- Automatic duplicate *detection*. These are deliberate manual guards.
- A generic dropdown/menu UI primitive. None exists in this codebase and none is introduced.

---

## 1. Exclusion

### Storage

Three new columns on `expenses`:

| Column | Type | Notes |
|---|---|---|
| `excluded_at` | `timestamptz null` | Null = not excluded. Presence is the flag. |
| `excluded_reason` | `text null` | Required at the API layer whenever excluding. |
| `excluded_by` | `uuid null` | Session user id, for audit. |

**Sync-safety is the binding constraint.** These columns MUST NOT be added to the
`ExpenseRecord` interface (`lib/finance/expenses.ts:21-50`). `syncExpenseRecords`
(`lib/finance/rampExpenses.ts:252-263`) upserts exactly the keys of that interface plus
`chart_of_accounts_id`, `mapping_source`, `synced_at`; PostgREST emits
`ON CONFLICT DO UPDATE SET <supplied columns only>`, so absent columns survive re-sync. This
is the proven `unmapped_accepted` / `inventory_alert_dismissed` pattern
(`20260722_expenses_inventory_alert_dismissed.sql:8-9`).

**Rejected alternatives:**

- *Separate `expense_exclusions` table* (the `recipe_square_link_ignores` precedent). Its
  extensibility to other ledgers is speculative given the expenses-only scope, and it costs a
  batched join in two read paths.
- *Reusing `state='DECLINED'`*. Ramp owns `state` and clobbers it every sync.

### Semantics

Excluded rows are removed from **every** financial statement — P&L, cash flow, and balance
sheet. An excluded row is treated as a data artifact that should never have existed.

This is deliberately stricter than the `affects_pl` precedent on `ramp_bank_ledger`, which is
skipped for `statement === "balance_sheet"` so cumulative cash balance stays correct
(`fetchSources.ts:477-488`). That distinction is safe here because in the motivating case the
real cash movement is already carried by the `ramp_bank_ledger` row; the `expenses` copy is
purely fictional.

### Enforcement point

A single filter in `fetchSources.ts` (the expenses query at ~line 429):

```ts
q = q.is("excluded_at", null);
```

That query has no per-statement branching, so one line covers all three statements.

`scripts/financials-parity.ts` (~lines 208-214) replicates the existing expense filters and
MUST mirror this one, or it reports a false discrepancy.

Excluded rows remain visible in the Transactions list — badged, reason shown — so exclusion
is reversible and auditable. Only aggregation drops them.

### API

`POST /api/finance/expenses/[id]/exclude` — body `{ reason: string }`, sets all three columns.
`DELETE` on the same route un-excludes, clearing all three back to null. Gated
`requireRole(["manager"])`, matching the payroll-match route
(`app/api/finance/expenses/[id]/payroll-match/route.ts:32`). Uses the service-role admin client.

A blank or whitespace-only reason is rejected with 400. Reason is required because exclusion
silently removes money from reports; this follows the shipment channel billing exception
precedent.

The list route (`app/api/finance/expenses/route.ts`) must select and return `excluded_at` and
`excluded_reason` so the UI can badge rows; it must NOT filter them out.

---

## 2. Splitting

### Reuse

`expense_gl_splits` (`20260714_payroll_gl_split.sql:65-74`) already exists and is **not**
payroll-specific — it is keyed on `expense_id` alone, and `'manual'` is already a permitted
`split_source` value that nothing currently writes.

`aggregateRows.ts:305-312` already consumes it correctly: if `splitLines` is non-empty the
parent's own `chart_of_accounts_id`/`amount_cents` are never read, and each child line becomes
its own resolved row. `'manual'` already maps to `mappingSource: "manual"` in the P&L
(`aggregateRows.ts:310`).

So this feature is UI + API + validation. No aggregation changes.

### Schema addition

One nullable column on `expense_gl_splits`:

| Column | Type | Notes |
|---|---|---|
| `memo` | `text null` | Labels a component, e.g. "Sales Tax For Utility". |

No `sort_order` — order by `created_at`.

### Invariants

**Strict balance.** Split lines must sum exactly to the parent's `amount_cents`. Enforced in a
pure validator in `lib/` and re-checked server-side before write. This matters because
aggregation *replaces* the parent with its children, so an unbalanced split silently changes
the reported expense total. There is no DB-level constraint expressing this; the validator is
the guard.

**Sign convention.** Lines are stored signed to match the parent's cash direction (outflow
negative), following `payrollMatching.ts:213-231`. A validator working in magnitudes must
re-sign before write or `normalizeSign.ts` reads every line as a credit.

**Parent pinning.** Creating a manual split also sets the parent's `mapping_source='manual'`.
This single change pins the parent against both `resolveExpenseMapping` re-resolution on sync
(`rampExpenses.ts:240-247`, which honors `mapping_source === 'manual'`) and `autoMap`'s bulk
update (`lib/finance/autoMap.ts:225-234`, guarded by `.neq("mapping_source", "manual")`),
instead of adding a separate guard in each.

**Mutual exclusion with exclude.** An excluded expense cannot be split; the split action is
disabled while excluded, and excluding requires clearing splits first (or the API rejects with
409).

**Payroll interaction** already works and needs no change: `recomputePeriodExpenseSplits`
skips any expense carrying a `manual` row (`payrollMatching.ts:205`), and the recompute route
returns `409 manual_override_exists` unless `confirmOverwriteManual`
(`payroll-match/route.ts:120-128`).

### API

`PUT /api/finance/expenses/[id]/splits` — body `{ lines: [{ chart_of_accounts_id, amount_cents, memo? }] }`,
replacing the manual split set atomically and setting the parent's `mapping_source='manual'`.
`DELETE` clears manual splits and unpins the parent by resetting `mapping_source` to
`'unmapped'`, leaving `chart_of_accounts_id` as-is so the next sync or `autoMap` run
re-resolves it by rule. Gated `requireRole(["manager"])`. Only ever touches
`split_source='manual'` rows, never `payroll_auto`.

Rejects with 400 when lines do not balance, when fewer than 2 lines are supplied, or when any
`chart_of_accounts_id` is unknown. Rejects with 409 when the expense is excluded.

The list route already enriches each expense with `glLines` via `resolveExpenseGlLines`
(`app/api/finance/expenses/route.ts:76-134`); it must additionally expose each line's
`split_source` and `memo` so the UI can tell manual splits from payroll ones and populate the
editor.

---

## 3. UI

Both guards live in the existing click-to-expand drawer in
`app/finance/transactions/expenses/page.tsx` (`ExpenseRowView`, lines 123-263), mirroring the
`PayrollSplitPanel` pattern (`expenses/PayrollSplitCell.tsx`).

The drawer's mutually-exclusive branch becomes three-way:

1. `PayrollSplitPanel` — when `isPayrollSplit` (page.tsx:477)
2. **`ManualSplitPanel`** — when the expense has `split_source='manual'` lines, or the user
   opens the split editor
3. `AccountSelect` — the existing single-account case

`ManualSplitPanel` (new component, `expenses/ManualSplitPanel.tsx`): add/remove rows, each with
an `AccountSelect`, an amount input, and an optional memo. Shows a live running total against
the parent amount with the remainder called out; Save is disabled until balanced. Updates the
row in place via an `onUpdated` callback, following `handlePayrollUpdated` (page.tsx:345-347) —
no full reload.

**Exclude** is a `btn-xxs` action in the drawer opening a `ConfirmDialog` that captures the
required reason. When excluded, the GL Account column shows `<Badge tone="danger">Excluded</Badge>`
with the reason as title text, and the drawer offers "Restore".

`EXPENSE_CONTROLS` (page.tsx:90-105) gains a filter entry so excluded rows can be found.

`isExpenseMapped` (page.tsx:86-88) already keys off `glLines.length > 0`, so a manual split
automatically reads as "mapped" with no further work.

All UI uses existing primitives — `Badge`, `ConfirmDialog`, `SaveHint`, `AccountSelect`,
`btn-*` classes, `inp-sm`. No new primitive is introduced.

---

## 4. Sync fixes

### 4a. `buildBillTotals` dedup

Dedup lines by `source_transaction_id` before summing, so a bill arriving from both the DB
history and the API batch is counted once. Keep the existing `billId → Set<total>` output shape
so `classifyBankLine` is unchanged.

### 4b. Sync self-heal

After `partitionBankLines` in `rampSync.ts`, delete `expenses` rows whose
`source_transaction_id` now appears in `ledgerRecords` (scoped `source='ramp'`,
`ramp_object='bank'`). A bank line classified as a ledger flow must not also exist as an
expense.

**Guard:** skip deletion for any row that has `expense_gl_splits` rows or a non-null
`excluded_at`, so reclassification never silently destroys manual work. Such rows are left in
place; because `expense_gl_splits` has `on delete cascade` on `expense_id`, an unguarded delete
would take the splits with it.

Batched via the existing `chunk` util. This clears the stranded Duke Energy row on the next
sync and prevents recurrence for any vendor.

---

## Testing

Pure-logic tests, co-located per the repo rule that new/modified `lib/` modules ship with
`*.test.ts`:

- `buildBillTotals` — regression using the real Duke Energy figures (12 lines summing to
  483355): matches when the bill is supplied once, and **still** matches when supplied twice.
- Split validator — balanced set passes; off-by-one-cent fails; single-line set fails; sign
  convention preserved for outflows.
- Exclusion filter — an excluded expense is absent from P&L, cash-flow, and balance-sheet
  aggregation; a restored one reappears.
- Self-heal guard — a reclassified bank line with manual splits or an exclusion is NOT deleted.

`npm run verify` (lint + typecheck + tests) is the definition of done.

## Rollout

One migration, `20260816_expense_manual_guards.sql` (next free number; `20260814` and
`20260815` are still unapplied):

- `alter table expenses add column excluded_at / excluded_reason / excluded_by`
- `alter table expense_gl_splits add column memo text`
- index on `expenses(excluded_at) where excluded_at is not null`

Migrations are human-gated for prod per project policy. The code is safe to deploy **before**
the migration only if the new filter and columns are additive-tolerant — they are not
(`fetchSources` would query a missing column), so **this migration is a hard deploy gate**,
matching the `20260814` situation.

No backfill. The stranded Duke Energy row is cleared by 4b on the first post-deploy sync, not
by a data migration.
