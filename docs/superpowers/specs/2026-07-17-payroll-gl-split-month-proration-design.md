# Payroll GL-split month proration

**Date:** 2026-07-17
**Status:** Approved, not yet implemented

## Problem

Payroll GL splits (`expense_gl_splits`, added in `20260714_payroll_gl_split.sql`) let a Gusto payroll withdrawal be divided across GL accounts (6110/6120/5130/6130). Every split line for an expense carries only an `amount_cents` and a `chart_of_accounts_id` — no date of its own.

Financial statements (P&L, cash flow, balance sheet) attribute every split line to the month of the parent expense's `accounting_date` (`lib/finance/financials/aggregateRows.ts:296-308`, via `resolveExpenseLike`). A biweekly pay period frequently spans two calendar months — e.g. the last 7 days of May plus the first 7 days of June — but the Gusto withdrawal posts on a single date, so today the entire split lands in whichever month that date happens to fall in. This misstates both months' P&Ls.

Pay periods already carry the true date range: `pay_periods.start_date`/`end_date` (`20260628_payroll_schema.sql:46-59`), linked to an expense via `payroll_period_expense_matches` (`20260714_payroll_gl_split.sql:57-63`).

## Scope

- **Payroll expenses only.** Any expense with a `payroll_period_expense_matches` row. Non-payroll manually-split transactions are unaffected and keep using `accounting_date` — no UI change for entering a date range on generic splits.
- **Applies regardless of `split_source`.** Whether a split line is `payroll_auto` or `manual`, month attribution is driven by the matched pay period's dates, not the line's origin. `split_source` governs which GL account a line maps to; it says nothing about which month(s) it belongs to.
- **Once matched, pay-period dates are always the attribution basis** — even for a pay period sitting entirely within one calendar month whose expense happens to post in a different month (processing delay). This replaces `accounting_date` as the attribution source for any matched expense, not just ones that cross a month boundary.
- **No schema changes, no new table, no backfill migration.** Proration is computed at read time from `pay_periods.start_date`/`end_date`, which already exist for every matched pay period — past and future. The fix applies retroactively the moment it ships.

## Algorithm

New pure function, `lib/finance/payrollPeriodProration.ts`:

```ts
export function prorateAcrossMonths(
  amountCents: number,
  periodStart: string, // "YYYY-MM-DD", inclusive
  periodEnd: string,   // "YYYY-MM-DD", inclusive
): Array<{ monthKey: string; amountCents: number }>
```

- Iterate every calendar day from `periodStart` to `periodEnd` inclusive; bucket the day count by month (`"YYYY-MM"`).
- Allocate `amountCents` proportionally to each month's day count, using largest-remainder rounding (same technique as `computeProportionalSplits` in `payrollMatching.ts:85`) so the parts always sum exactly to `amountCents` — no cent drift in P&L totals.
- A single-month period returns a one-element array; the function makes no assumption about how many months a period can span (handles 3+ months, leap years, and variable month lengths for free by iterating real calendar days rather than a fixed day-count model).

## Data flow

No schema or migration changes. Two files change:

### `lib/finance/financials/fetchSources.ts`

Add a batched lookup analogous to `fetchExpenseGlSplitsByExpenseId` (`fetchSources.ts:337-363`):

```ts
async function fetchPayrollPeriodsByExpenseId(
  supabase: SupabaseClient,
  expenseIds: string[],
): Promise<Map<string, { start: string; end: string }>>
```

- One `.in("expense_id", expenseIds)` query joining `payroll_period_expense_matches` → `pay_periods(start_date, end_date)`.
- `fetchExpenses` (`fetchSources.ts:365-399`) calls this alongside the existing splits lookup and attaches the result as a new optional field, `payrollPeriod: { start, end } | null`, on `ExpenseRecord`.
- No change to the `accounting_date`-based query filter itself — confirmed via investigation that the Financials view only ever queries a 12-month trailing window (P&L/cash flow) or an unbounded-from-inception window (balance sheet), never a narrow single-month range, so a payroll expense's `accounting_date` is never outside the fetched range in practice.

### `lib/finance/financials/aggregateRows.ts`

In the `input.expenses` loop (`aggregateRows.ts:296-308`): for each split line (or the fallback single line), if `row.payrollPeriod` is present, call `prorateAcrossMonths(line.amountCents, row.payrollPeriod.start, row.payrollPeriod.end)` and call `resolveExpenseLike` once per resulting `{monthKey, amountCents}` (synthesizing `dateStr = `${monthKey}-01`` for the existing signature) instead of once against `row.accountingDate`. When `row.payrollPeriod` is absent, behavior is byte-for-byte unchanged.

This flows through the same `monthSet.has(r.monthKey)` filter every other row already goes through (`aggregateRows.ts:290,294,306,320`), so it composes correctly with both the 12-month trailing set (P&L/cash flow) and the single-canonical-month set used for balance sheet — no special-casing needed per statement type.

## UI — PayrollSplitPanel

`app/finance/transactions/expenses/PayrollSplitCell.tsx`: for a split line whose expense has a payroll match spanning more than one month, show the computed breakdown inline under the existing GL amount, e.g.:

```
6110 · $420.00 → May $210.00 · Jun $210.00
```

Computed client-side by importing the same `prorateAcrossMonths` pure function (no DB access, safe to share between server and client bundles) — no API round-trip. Single-month matches show no visual change from today.

## Edge cases

- **Rounding:** largest-remainder allocation guarantees the prorated parts always sum to the original `amount_cents`; no leakage across months.
- **3+ month spans:** handled the same as 2-month spans — day-bucketing is not limited to two buckets.
- **Manual splits:** unaffected in which GL account they map to; still prorated by month like any other matched split (see Scope).
- **Unmatched expenses:** fully unchanged, `accounting_date`-based attribution.
- **12-month trailing window boundary:** if a pay period's days fall outside the requested year's trailing 12-month window entirely (only possible at the very first month of the window), those days' worth of amount won't appear in that statement request — this is the same pre-existing boundary limitation every other row type has at the window edge, not a new gap introduced by this feature.

## Testing

- New `lib/finance/payrollPeriodProration.test.ts`: exact 50/50 (7+7 days), uneven split (10+4 days), single-month period (one output entry), 3-month span, odd-cent-amount rounding (verify sum-to-original).
- Extend existing `aggregateRows` test coverage (or add it if none exists) with a payroll-matched expense whose pay period crosses a month boundary, asserting two `FinancialsRow` entries in the correct months that sum to the original split amount.
- Extend `PayrollSplitPanel` component test (if any) to cover the multi-month breakdown display.

## Non-goals

- No change to how a user creates or edits a manual GL split.
- No change to `payrollMatching.ts`'s GL-amount allocation logic (`computeProportionalSplits`) — that's a separate proportion (how much of a Gusto report total goes to each GL account), orthogonal to this one (how much of a GL line's amount goes to each month).
- No generalization to non-payroll splits in this pass (see Scope).
