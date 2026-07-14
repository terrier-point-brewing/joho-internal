# Payroll: declared-per-person cash tips + Gusto-reported ratio

**Date:** 2026-07-13
**Branch:** `claude/andrew-ogden-bonus-2026-d88cbd`
**Status:** Approved (design), pending implementation plan

## Problem

Payroll currently *estimates* cash tips as `cash_sales × cash_tips_rate` (default 3%), pooled
across tipped employees by hours. This estimate is the only consumer of the `cash_tips_rate`
setting and the Square "cash take" fetch. The estimate badly understates reality — for the
6/29–7/12 period, Andrew Ogden's estimated cash tips were **$6.24** while his Square-declared
cash tips were **$84.15**. Because cash tips count against the $15/hr guarantee, the estimate
inflated his top-up bonus.

Square already reports actual cash tips **per employee per shift** via
`Shift.declared_cash_tip_money` (returned by `POST /v2/labor/shifts/search`, the endpoint we
already call). We move to a **declared-per-person** model.

Additionally, TPB reports cash tips to Gusto at a **10:1 ratio** (one tenth of actual). This has
no tax impact (cash tips are untaxed) but employees prefer the lower reported figure. Two cash
figures therefore coexist:

- **Actual cash tips** — from Square. Drives the bonus/guarantee.
- **Reported cash tips** — `round(actual ÷ divisor)`, divisor default 10. Drives Gusto submission.

## Decisions (locked)

1. **Full removal** of the old estimator: delete `cash_tips_rate` (config column + settings UI)
   and the Square cash-take fetch. Declared cash is the sole source.
2. **Missing declaration = $0** (the truth). Managers correct via the existing Override Mode.
3. **10:1 ratio is configurable** — stored in `payroll_config` as `reported_cash_tips_divisor`
   (default 10), editable in payroll settings.
4. **Summary tab uses a toggle** (`Actuals | Gusto-reported`), not a permanent extra column.

## Model

Per tipped employee, per period:

| Field | Meaning | Source | Overridable | Used by |
|---|---|---|---|---|
| `hours_worked` | hours | Square shifts | `adj_hours_worked` | everything |
| `paycheck_tips_cents` | card tips | pooled by hours (unchanged) | `adj_paycheck_tips_cents` | comp, Gusto |
| `cash_tips_cents` | **actual** declared cash | `declared_cash_tip_money` | `adj_cash_tips_cents` | **bonus**, Actuals view |
| `bonus_cents` | guarantee top-up | computed from **actual** cash | `adj_bonus_cents` | comp, Gusto |
| `reported_cash_tips_cents` | **reported** cash (÷ divisor) | `round(effective actual ÷ divisor)` | `adj_reported_cash_tips_cents` (new) | **Gusto**, Gusto view |

Key invariant: **the reporting ratio never touches the bonus.** Bonus is always actual-derived.

`reported_cash_tips_cents` default is derived from the *effective* actual cash (i.e. after any
`adj_cash_tips_cents` override), so overriding actual cash re-derives the reported default —
unless `adj_reported_cash_tips_cents` is itself set, which wins.

## Component changes

### Data layer — `lib/square/labor.ts`
- Add `declared_cash_tip_money?: { amount: number; currency: string }` to `SquareShift`.
- `DailyShift` gains `cash_tips_cents: number` (sum of declared cash across that member's shifts
  on that day). `fetchShiftsByDay` populates it. `fetchShiftHours` (aggregate hours-only variant)
  is untouched.

### Data layer — `lib/square/payroll.ts`
- Drop `cashTakeCents` from `DailyTips` and stop summing cash `total_money`. Keep
  `tipsPooledCents` (card-tip pool still needs it).

### Calc — `lib/payroll/calculations.ts`
- `GuaranteeBucket.cashTipsCents` is now populated from declared cash (same shape, new source).
- `computePayrollEntries` accepts the divisor (via `config.reported_cash_tips_divisor`) and emits
  `reported_cash_tips_cents = round(cash_tips_cents ÷ divisor)`.
- `mergeAdjustments` adds:
  - `effective_reported_cash_tips_cents = adj_reported_cash_tips_cents ?? round(effective_cash_tips_cents ÷ divisor)`
  - Total comp is unchanged in definition (base + card + **actual** cash + bonus). The
    Gusto-view total is a *presentation* recomputation in the UI, not a stored field.

### Calc — `lib/payroll/previewService.ts`
- Build guarantee buckets' `cashTipsCents` directly from `fetchShiftsByDay`'s per-day declared
  cash (sum member's days in each guarantee bucket). Remove the `share × cash_tips_rate ×
  groupCash` path and `total_cash_take_cents` from the returned preview.
- Card-tip pooling (step 1/step 2 for paycheck tips) is unchanged.

### API — `app/api/payroll/periods/[id]/shifts/route.ts`
- Per-employee-per-day cash = declared cash from `fetchShiftsByDay` directly. Remove the
  cash-take bucket math (`cashTipsRate`, `cashTakeMap`, `empBucketCashTips`). Card-tip pooling
  stays. `daily_cash_tips_cents` / `total_cash_tips_cents` now reflect actual declared cash.

### API — `app/api/payroll/periods/[id]/entries/[employeeId]/route.ts`
- Add `adj_reported_cash_tips_cents` to the `allowed` list.

### API — `app/api/payroll/periods/[id]/lock/route.ts`
- Snapshot `reported_cash_tips_cents` and `adj_reported_cash_tips_cents` in the upsert.

### API — `app/api/payroll/config/route.ts`
- Remove `cash_tips_rate` from validation + insert; add `reported_cash_tips_divisor` (integer,
  default 10, `> 0`).

### UI — `app/components/payroll/PayrollPeriodView.tsx`
- Add view-local state `cashView: "actual" | "reported"` with an `Actuals | Gusto-reported`
  segmented switch (only meaningful on the Summary tab; hidden on Shifts/Gusto tabs).
- Footer totals for Cash Tips / Total / $/hr recompute from the active view. Bonus/Base/Card/Hours
  totals are view-independent.
- Pass `cashView` down to `PayrollEntryRow`.

### UI — `app/components/payroll/PayrollEntryRow.tsx`
- Cash Tips cell is view-aware:
  - `actual` view → shows `effective_cash_tips_cents`; override edits `adj_cash_tips_cents`.
  - `reported` view → shows `effective_reported_cash_tips_cents`; override edits
    `adj_reported_cash_tips_cents`.
- Row Total / $/hr follow the active view: `reported` view substitutes reported cash for actual
  cash in the total. Bonus column identical in both views.

### UI — `app/components/payroll/GustoSummaryPanel.tsx`
- Cash Tips column uses `effective_reported_cash_tips_cents` (always the reported figure) with a
  "(reported N:1)" caption. Bonus stays actual-derived. This is the authoritative copy-to-Gusto view.

### UI — `app/components/payroll/ShiftTimeline.tsx`
- Legend: "Cash tips from {frequency} pool" → "Declared cash tips (Square)". Shift tab shows
  **actual** declared cash only (the 10:1 is a payroll construct, not a per-shift fact). No
  structural table change — rollups already work off `daily_cash_tips_cents`.

### UI — `app/finance/settings/payroll/page.tsx`
- Remove the Cash Tips Rate input; add "Reported cash tips ratio (N:1)" bound to
  `reported_cash_tips_divisor`. Update the formula box:
  - `cash_tips = Σ declared cash per shift (Square)`
  - `reported_cash = round(cash_tips ÷ N)`
  - bonus/base/guaranteed_min formulas unchanged (bonus still uses actual `cash_tips`).

### Types — `lib/payroll/types.ts`
- `PayrollConfig`: remove `cash_tips_rate`, add `reported_cash_tips_divisor: number`.
- `PayrollEntry`: add `reported_cash_tips_cents`, `adj_reported_cash_tips_cents` (nullable).
- `PayrollEntryComputed`: add `reported_cash_tips_cents`.
- `PayrollEntryMerged`: add `adj_reported_cash_tips_cents`, `effective_reported_cash_tips_cents`.
- `PayrollPreview`: remove `total_cash_take_cents`. `TipBucketSummary` drops `cashTakeCents`.

### Schema — new migration(s) under `supabase/migrations/`
```sql
-- payroll_config
alter table payroll_config drop column cash_tips_rate;
alter table payroll_config
  add column reported_cash_tips_divisor integer not null default 10
    check (reported_cash_tips_divisor > 0);

-- payroll_entries
alter table payroll_entries
  add column reported_cash_tips_cents     integer,
  add column adj_reported_cash_tips_cents integer;
```
(One combined migration file is fine; both tables, one timestamp.)

## Testing

- `lib/payroll/__tests__/calculations.test.ts`
  - Bonus uses **actual** cash (declared), independent of divisor.
  - `reported_cash_tips_cents = round(cash ÷ divisor)`; rounding at half-cent boundaries.
  - `adj_reported_cash_tips_cents` override wins over the derived default.
  - Overriding `adj_cash_tips_cents` re-derives the reported default (when reported not overridden)
    and changes the bonus.
- `lib/payroll/__tests__/previewService.test.ts`
  - Declared cash flows from shift fixtures into guarantee buckets (no rate, no pooling).
  - Card-tip pooling still behaves as before.
  - `total_cash_take_cents` no longer present.
- `npm run verify` green (lint + typecheck + tests); keep `lib/` coverage above the vitest floor.

## Out of scope / non-goals

- Card (paycheck) tip pooling logic — untouched (this is cash-only).
- Editing declared cash on the Shifts tab — Shifts remains read-only display; corrections happen
  via Summary Override Mode.
- Backfilling or altering already-locked periods — their snapshots are frozen by design.

## Rollout notes (human-gated, post-merge)

- Apply the migration to prod (per repo policy: orchestrator applies after explicit OK + backup).
- Set `reported_cash_tips_divisor` = 10 in payroll settings (migration default already does this).
- **Behavioral change on the current open period:** actual declared cash now drives the guarantee,
  so in-flight bonuses (e.g. Andrew's $14.84) will shrink toward $0. Expected and intended.
