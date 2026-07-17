# Finance → Payroll: periods table upgrade

**Date:** 2026-07-16
**Status:** Approved (design)

## Problem

The Finance → Payroll periods list ([app/finance/payroll/page.tsx](../../../app/finance/payroll/page.tsx))
is a hand-rolled 2-column table (Period, Status) that hits `GET /api/payroll/periods`, which returns
bare `pay_periods.*`. It doesn't use the app's standard table kit and surfaces none of the data that
already exists: payroll totals, whether a Gusto GL report was uploaded, whether the period is mapped
to its bank withdrawal(s), split status, or drift between what the app computed and what Gusto returned.

## Goal

Rewrite the periods list as a standard table (LedgerTable + SortableTh + useTableControls + FilterSelect
+ Badge) with useful, cheaply-derivable columns — including **two payroll totals side by side** (the app's
computed basis vs. the Gusto result) plus their **drift**, so submission drift is catchable at a glance.

## Key data-model finding (no migration needed)

The app-side payroll basis (`total_compensation`) is normally computed live from Square via
`buildPayrollPreview` — too expensive to run per row. BUT the **lock route already snapshots it**:
[lock/route.ts](../../../app/api/payroll/periods/[id]/lock/route.ts) runs the preview once at lock time
and writes the effective `hours_worked` / `paycheck_tips_cents` / `cash_tips_cents` / `bonus_cents` into
`payroll_entries`. So for **locked** periods the snapshot is already in the DB and the basis is computable
cheaply (no Square, no migration). **Open** periods have no finalized snapshot → basis shows `—`
("pending lock"), which is semantically correct — the "submitted basis" only exists once locked.

Confirmed in prod: the two locked periods carry 7-employee snapshots; open periods have 0 entries.

## Column set

| Column | Source | Sort/Filter |
|---|---|---|
| Period (start–end, link) | `pay_periods` | sort (start_date, default desc) |
| Due | `due_date` | sort |
| Status | `status` — `Badge` Open/Locked | filter |
| Employees | count `payroll_entries` | — |
| App basis | Σ over snapshot entries: `round(hours×base_rate) + paycheck_tips + cash_tips + bonus`; `—` if open | sort |
| Gusto result | Σ `payroll_gl_report_totals` (active report); `—` if none | sort |
| Drift | app **wages** vs Gusto **wages** (both exclude taxes); `Badge` OK / ±$X; `—` if either missing | — |
| Matched txns | count + Σ|amount| of `payroll_period_expense_matches`→`expenses` | — |
| Reconciliation | matched Σ vs Gusto total; `Badge` OK / ±$X; `—` if no report | — |
| Splits | `expense_gl_splits` on matched expenses; `Badge` Split / Awaiting / — | — |

Definitions:
- **app wages** = `round(hours×base_rate) + paycheck_tips + bonus` (excludes cash tips — Gusto doesn't disburse cash tips).
- **Gusto wages** = Σ report totals for GL accounts **other than** `payroll_gl_settings.payroll_taxes_chart_of_accounts_id`.
- **Drift** = app wages − Gusto wages. `success` when |drift| ≤ $1 tolerance, else `danger`.
- **base_rate** = `payroll_config` effective at the period's `start_date` (fallback: earliest config). Per-entry base-pay rounding matches the lock snapshot to within cents (immaterial vs. the drift tolerance).
- Expense `amount_cents` is negative for outflows; matched sum uses magnitudes.

## Files

1. `lib/payroll/periodSummary.ts` (new) + `periodSummary.test.ts` — pure `computePeriodBasis(entries, baseRateCents)` and `classifyVariance(diff, tolCents)`; IO wrapper `getPeriodSummaries(sb)` that batch-fetches (all `.in()`/grouped, no Square) and composes `PayPeriodSummary[]`.
2. `lib/payroll/types.ts` — add `PayPeriodSummary`.
3. `app/api/payroll/periods/route.ts` — `GET` returns `getPeriodSummaries(sb)`; `POST` unchanged.
4. `app/finance/payroll/PeriodsTable.tsx` (new) — presentational table (LedgerTable shell, Th/SortableTh, Badge/money cells).
5. `app/finance/payroll/page.tsx` — rewrite: `PageHeader`, `FilterBar` + `FilterSelect` (status), `useTableControls` (sort), renders `PeriodsTable`. Keep the "+ New Period" create form.

## Testing

- `periodSummary.test.ts`: basis from snapshot rows (incl. per-entry rounding), null-basis for empty entries, wage vs total split, Gusto-wages excludes taxes account, drift/reconciliation classification + tolerance, matched-sum magnitude, split-status derivation.
- `npm run verify` green; keep `lib/` coverage above the vitest floor.

## Out of scope

- No schema change / migration / lock-route change / backfill.
- No live Square recompute in the list (open-period basis is intentionally `—`).
- No change to period creation flow beyond restyling.
