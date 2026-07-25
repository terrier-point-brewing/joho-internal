# GL Account Filter Across Transactions Subtabs

**Date:** 2026-07-24
**Status:** Design approved

## Goal

Let an operator filter the Finance > Transactions ledgers by chart-of-accounts account, on all four subtabs (Orders, Invoices, Expenses, Bank Ledger).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope of the selection | **Independent per subtab**, resets on navigation | Matches how the existing `mapping` / `qbsync` filters already behave. |
| Match grain | **Narrow to matching lines only** | Answers "what exactly hit this account", rather than showing unrelated sibling lines. |
| Row totals under narrowing | **Matching subtotal, with the full row total as secondary context** | Required by the narrowing choice — see below. |
| Control | Reuse `AccountSelect` | 126 accounts in prod; a plain `<select>` (`FilterSelect`) is unusable at that size. `AccountSelect` is already searchable and grouped. |
| Branch | Stacked on `claude/dukeenergy-duplicate-pl-check-c039a5` (PR #266) | Both edit `expenses/page.tsx`'s controls config and FilterBar; branching from main guarantees a conflict. |

## Non-goals

- `square-transactions/page.tsx` — a 5-line stub, skipped.
- Server-side filtering. These pages already filter client-side over a date-ranged fetch; this follows suit.
- Filtering the Financials statements themselves. This is a ledger-browsing aid only and changes no aggregation.

---

## 1. The control

New `app/finance/transactions/components/GlAccountFilter.tsx` — wraps `AccountSelect` with a "GL account" label and a clear affordance, sized for a `FilterBar` row. No new UI primitive; `AccountSelect` already consolidates the searchable CoA picker used elsewhere in Finance.

State rides the existing `useTableControls` machinery under param `gl`, whose value is a `chart_of_accounts.id`. Because `useTableControls` already syncs to the URL, the filtered view is shareable and back-button safe.

## 2. Matching

GL lives at a different grain per subtab:

| Subtab | GL source | GL per row |
|---|---|---|
| Bank Ledger | `chart_of_accounts_id` on the row | exactly 1 |
| Expenses | `glLines[]` (own account, or `expense_gl_splits`) | 1..N |
| Invoices | `lineItems[].chart_of_accounts_id` | 1..N |
| Orders | `lineItems[].effective_chart_of_accounts_id` | 1..N |

`applyControls` (`lib/table/applyControls.ts:52-56`) supports a custom `matches(row, selected)` predicate per filter, so multi-GL rows need no change to the table machinery.

Shared predicate in `lib/finance/glLineMatch.ts` rather than four copies:

```ts
/** True when any of `lineCoaIds` is in `selected`. Empty selection matches everything. */
export function matchesGlFilter(lineCoaIds: (string | null | undefined)[], selected: string[]): boolean
/** The subset of `lines` whose GL id is in `selected`; all of `lines` when the selection is empty. */
export function narrowToGl<T>(lines: T[], coaIdOf: (line: T) => string | null | undefined, selected: string[]): T[]
```

Bank Ledger has exactly one GL per row, so it uses a plain `accessor` and needs no narrowing.

## 3. Totals under narrowing

Narrowing creates a real misreading hazard: an invoice totalling $1,000 with one $200 line coded to the selected account would otherwise render as a $1,000 row showing only $200 of visible lines.

**When a GL filter is active**, on Invoices, Orders, and Expenses:

- The row's amount column shows the **matching subtotal**, with the full row total beneath it as `text-faint` secondary context (`of $1,000.00`).
- `SummaryStatBar` totals reflect matching amounts only.
- Expanded rows list only the matching line items.

When no GL filter is active, every one of these renders exactly as it does today. The filtered presentation is strictly additive and reachable only by selecting an account.

Bank Ledger is unaffected — one GL per row means the matching subtotal always equals the row total.

## 4. Files

| File | Responsibility |
|---|---|
| `lib/finance/glLineMatch.ts` | Create: shared match + narrow helpers |
| `lib/finance/glLineMatch.test.ts` | Create: pure-logic tests |
| `app/finance/transactions/components/GlAccountFilter.tsx` | Create: the FilterBar control |
| `app/finance/transactions/orders/page.tsx` | Modify: filter, narrowing, subtotal |
| `app/finance/transactions/invoices/page.tsx` | Modify: filter, narrowing, subtotal |
| `app/finance/transactions/expenses/page.tsx` | Modify: filter, narrowing, subtotal |
| `app/finance/transactions/bank-ledger/page.tsx` | Modify: filter only (no narrowing) |

## Testing

- `matchesGlFilter`: empty selection matches everything; single match; no match; null/undefined line ids ignored.
- `narrowToGl`: empty selection returns all; narrows to matching; returns `[]` when none match; preserves order.
- Subtotal arithmetic is exercised through `narrowToGl` plus a plain sum in each page — no new money logic beyond the helper.
- `npm run verify` is the definition of done.

## Rollout

**No migration.** No schema change, no API change — every field the filter reads is already returned by the existing endpoints. Safe to deploy independently of migration `20260816`.
