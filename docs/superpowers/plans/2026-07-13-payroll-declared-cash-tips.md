# Payroll Declared Cash Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the estimated cash-tip model with per-employee Square-declared cash tips (driving the bonus), and add a configurable-ratio "reported cash tips" figure for Gusto with an Actuals/Gusto-reported toggle on the Summary tab.

**Architecture:** Read `Shift.declared_cash_tip_money` from the existing labor shift search; feed it into guarantee buckets as actual cash. Derive `reported_cash_tips_cents = round(actual ÷ divisor)` (divisor configurable, default 10) in the calc layer, overridable per entry. UI toggle switches the Summary cash column/total/$hr between the two bases; bonus always stays actual-derived. Remove the now-dead `cash_tips_rate` + cash-take estimator end to end.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres, Square Labor/Payments API (raw fetch), Vitest, Tailwind v4 token utilities.

**Execution Budget:** Mode = **inline** (executing-plans; single payroll locality, coupled through `types.ts` — parallel subagents would conflict). Spawn cap = 2 (reserved for optional final review only). Token target ≈ 120k. Model = Opus (inline orchestrator) for all tasks.

## Global Constraints

- Money is integer cents everywhere; convert at UI edges only. Divisor is an integer count (N in "N:1").
- Bonus/guarantee math uses **actual** cash tips only — the reporting divisor must never enter the bonus.
- No raw color utilities in feature code (`zinc/amber/red/green/blue/gray`) — use token utilities. Do NOT refactor pre-existing raw colors in `ShiftTimeline.tsx`; only change the legend text.
- New/modified `lib/` modules keep co-located `*.test.ts` green; don't drop `lib/` coverage below the vitest floor.
- Supabase client per context: route handlers use `createSupabaseServerClient` / admin, never the browser client.
- Migrations are additive files under `supabase/migrations/`; never hand-edit existing ones. Do NOT apply to prod — human-gated per repo policy.
- `npm run verify` (lint + typecheck + tests) must be green at the end.

---

## Task 1: Schema migration + shared types

**Files:**
- Create: `supabase/migrations/20260713_payroll_declared_cash_tips.sql`
- Modify: `lib/payroll/types.ts`

**Interfaces:**
- Produces: `PayrollConfig.reported_cash_tips_divisor: number` (replaces `cash_tips_rate`); `PayrollEntry`/`PayrollEntryComputed`/`PayrollEntryMerged` reported-cash fields; `PayrollPreview` without `total_cash_take_cents`; `TipBucketSummary` without `cashTakeCents`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260713_payroll_declared_cash_tips.sql
-- Move to declared-per-person cash tips; add configurable Gusto reporting ratio.

-- Remove the obsolete cash-sales estimator knob.
alter table payroll_config drop column cash_tips_rate;

-- Configurable Gusto reporting ratio (N:1). reported = round(actual / divisor).
alter table payroll_config
  add column reported_cash_tips_divisor integer not null default 10
    check (reported_cash_tips_divisor > 0);

-- Per-entry reported cash tips (computed default + admin override), snapshotted at lock.
alter table payroll_entries
  add column reported_cash_tips_cents     integer,
  add column adj_reported_cash_tips_cents integer;
```

- [ ] **Step 2: Update `lib/payroll/types.ts`**

In `PayrollConfig`: remove `cash_tips_rate: number;`, add `reported_cash_tips_divisor: number;`.

In `PayrollEntry`: after `cash_tips_cents`, add `reported_cash_tips_cents: number | null;`; after `adj_cash_tips_cents`, add `adj_reported_cash_tips_cents: number | null;`.

In `PayrollEntryComputed`: after `cash_tips_cents: number;`, add `reported_cash_tips_cents: number;`.

In `PayrollEntryMerged`: add `adj_reported_cash_tips_cents: number | null;` and `effective_reported_cash_tips_cents: number;`.

In `TipBucketSummary`: remove `cashTakeCents: number;`.

In `PayrollPreview`: remove `total_cash_take_cents: number;`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — errors in `calculations.ts`, `previewService.ts`, config route, settings page referencing removed fields. This is expected; later tasks fix each. (Confirms the type surface changed as intended.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260713_payroll_declared_cash_tips.sql lib/payroll/types.ts
git commit -m "feat(payroll): schema + types for declared cash tips and reporting divisor"
```

---

## Task 2: Declared cash on shift fetch — `lib/square/labor.ts`

**Files:**
- Modify: `lib/square/labor.ts`
- Test: `lib/square/__tests__/labor.test.ts` (create if absent)

**Interfaces:**
- Consumes: Square shift objects with optional `declared_cash_tip_money`.
- Produces: `DailyShift.cash_tips_cents: number` (sum of declared cash for that member on that date). `fetchShiftHours` unchanged.

- [ ] **Step 1: Write the failing test**

Check whether `lib/square/__tests__/labor.test.ts` exists. If Square calls are network-bound and not already mocked in this repo's tests, instead extract the pure aggregation into a testable helper. Add to `labor.ts`:

```ts
export function aggregateDailyShifts(
  shifts: Array<{ employee_id: string; start_at: string; end_at: string | null; declared_cash_tip_money?: { amount: number } }>
): DailyShift[] {
  const acc = new Map<string, Map<string, { hours: number; cash: number }>>();
  for (const shift of shifts) {
    if (!shift.end_at) continue;
    const date = shift.start_at.split("T")[0];
    const ms = new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime();
    const hours = ms / (1000 * 60 * 60);
    const cash = shift.declared_cash_tip_money?.amount ?? 0;
    if (!acc.has(shift.employee_id)) acc.set(shift.employee_id, new Map());
    const dayMap = acc.get(shift.employee_id)!;
    const cur = dayMap.get(date) ?? { hours: 0, cash: 0 };
    cur.hours += hours;
    cur.cash += cash;
    dayMap.set(date, cur);
  }
  const result: DailyShift[] = [];
  for (const [tid, dayMap] of acc)
    for (const [date, { hours, cash }] of dayMap)
      result.push({ team_member_id: tid, date, hours, cash_tips_cents: cash });
  return result;
}
```

Test (`lib/square/__tests__/labor.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { aggregateDailyShifts } from "../labor";

describe("aggregateDailyShifts", () => {
  it("sums declared cash tips per member per day across shifts", () => {
    const rows = aggregateDailyShifts([
      { employee_id: "A", start_at: "2026-07-01T11:00:00-04:00", end_at: "2026-07-01T15:00:00-04:00", declared_cash_tip_money: { amount: 500 } },
      { employee_id: "A", start_at: "2026-07-01T17:00:00-04:00", end_at: "2026-07-01T20:00:00-04:00", declared_cash_tip_money: { amount: 300 } },
      { employee_id: "A", start_at: "2026-07-02T11:00:00-04:00", end_at: "2026-07-02T15:00:00-04:00" }, // no declaration → 0
    ]);
    const jul1 = rows.find(r => r.team_member_id === "A" && r.date === "2026-07-01")!;
    const jul2 = rows.find(r => r.team_member_id === "A" && r.date === "2026-07-02")!;
    expect(jul1.cash_tips_cents).toBe(800);
    expect(jul1.hours).toBeCloseTo(7);
    expect(jul2.cash_tips_cents).toBe(0);
  });

  it("skips open shifts (no end_at)", () => {
    const rows = aggregateDailyShifts([
      { employee_id: "B", start_at: "2026-07-01T11:00:00-04:00", end_at: null, declared_cash_tip_money: { amount: 999 } },
    ]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/square/__tests__/labor.test.ts`
Expected: FAIL — `aggregateDailyShifts` not exported / `cash_tips_cents` missing on `DailyShift`.

- [ ] **Step 3: Implement**

- Add `declared_cash_tip_money?: { amount: number; currency: string };` to the `SquareShift` interface.
- Add `cash_tips_cents: number;` to the `DailyShift` interface.
- Add the `aggregateDailyShifts` helper above.
- Rewrite `fetchShiftsByDay`'s body after the `squarePostAll` call to `return aggregateDailyShifts(shifts);` (shifts already typed as `SquareShift[]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/square/__tests__/labor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/square/labor.ts lib/square/__tests__/labor.test.ts
git commit -m "feat(payroll): read declared_cash_tip_money per shift/day"
```

---

## Task 3: Drop cash-take from tips fetch — `lib/square/payroll.ts`

**Files:**
- Modify: `lib/square/payroll.ts`

**Interfaces:**
- Produces: `DailyTips { date; tipsPooledCents }` (no `cashTakeCents`).

- [ ] **Step 1: Check for other consumers**

Run: `grep -rn "fetchTipsAndCashTake\b\|totalCashTakeCents\|cashTakeCents" app lib --include="*.ts" | grep -v __tests__`
If `fetchTipsAndCashTake` (the non-`ByDay` variant) has no consumers, delete it in this task; otherwise leave it but drop its cash-take field only if unused. Record what you find.

- [ ] **Step 2: Edit `fetchTipsAndCashTakeByDay`**

- Remove `cashTakeCents` from the `DailyTips` interface.
- In the accumulator, drop the `cash` field and the `if (p.source_type === "CASH") ...` line.
- Return `{ date, tipsPooledCents: tips }` only.
- If Step 1 showed `fetchTipsAndCashTake` is unused, remove it and its `SquarePayment.total_money`/`source_type` usages that become dead; otherwise leave that function as-is.

- [ ] **Step 3: Typecheck the module**

Run: `npx tsc --noEmit 2>&1 | grep "lib/square/payroll"`
Expected: no errors originating in `payroll.ts` (downstream files still error until later tasks).

- [ ] **Step 4: Commit**

```bash
git add lib/square/payroll.ts
git commit -m "refactor(payroll): stop fetching cash-take (dead after declared model)"
```

---

## Task 4: Reported cash + divisor in calc — `lib/payroll/calculations.ts`

**Files:**
- Modify: `lib/payroll/calculations.ts`
- Test: `lib/payroll/__tests__/calculations.test.ts`

**Interfaces:**
- Consumes: `config.reported_cash_tips_divisor`.
- Produces: `computePayrollEntries` emits `reported_cash_tips_cents`; `mergeAdjustments(computed, adjustments, divisor)` emits `effective_reported_cash_tips_cents`. `AdjustmentSource` gains `adj_reported_cash_tips_cents: number | null`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/payroll/__tests__/calculations.test.ts` (reuse existing fixtures/config builder in that file; `divisor` = `config.reported_cash_tips_divisor`):

```ts
it("derives reported cash tips = round(actual / divisor); bonus ignores divisor", () => {
  // one bucket, one employee, actual cash = $84.15 (8415c), divisor 10
  const [entry] = computePayrollEntries(employees, buckets, { ...config, reported_cash_tips_divisor: 10 });
  expect(entry.cash_tips_cents).toBe(8415);
  expect(entry.reported_cash_tips_cents).toBe(842); // round(8415/10)
  // bonus computed from actual (8415), unchanged by divisor:
  const [entry5] = computePayrollEntries(employees, buckets, { ...config, reported_cash_tips_divisor: 5 });
  expect(entry5.bonus_cents).toBe(entry.bonus_cents);
  expect(entry5.reported_cash_tips_cents).toBe(1683); // round(8415/5)
});

it("mergeAdjustments: adj_reported override wins; else re-derives from effective actual", () => {
  const computed = { employee_id: "e", hours_worked: 10, paycheck_tips_cents: 0,
    cash_tips_cents: 8415, reported_cash_tips_cents: 842, bonus_cents: 0,
    base_pay_cents: 7000, total_compensation_cents: 15415 };
  // no overrides → reported tracks actual/divisor
  const m1 = mergeAdjustments(computed, {
    adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null,
    adj_bonus_cents: null, adj_reported_cash_tips_cents: null, admin_notes: null }, 10);
  expect(m1.effective_reported_cash_tips_cents).toBe(842);
  // override actual cash → reported default re-derives from effective actual
  const m2 = mergeAdjustments(computed, {
    adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: 5000,
    adj_bonus_cents: null, adj_reported_cash_tips_cents: null, admin_notes: null }, 10);
  expect(m2.effective_reported_cash_tips_cents).toBe(500);
  // explicit reported override wins
  const m3 = mergeAdjustments(computed, {
    adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null,
    adj_bonus_cents: null, adj_reported_cash_tips_cents: 111, admin_notes: null }, 10);
  expect(m3.effective_reported_cash_tips_cents).toBe(111);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/payroll/__tests__/calculations.test.ts`
Expected: FAIL — `reported_cash_tips_cents` missing / `mergeAdjustments` arity.

- [ ] **Step 3: Implement**

In `computePayrollEntries`, inside the final `.map`, add to the returned object (after `cash_tips_cents`):
```ts
reported_cash_tips_cents: Math.round(a.cashTips / config.reported_cash_tips_divisor),
```
(Leave the `bonus` accumulation untouched — it already uses actual `cashTips`.)

Extend `AdjustmentSource` with `adj_reported_cash_tips_cents: number | null;`.

Change `mergeAdjustments` signature to `(computed, adjustments, divisor: number)` and add:
```ts
const effectiveReportedCashTips =
  adjustments.adj_reported_cash_tips_cents ?? Math.round(effectiveCashTips / divisor);
```
Add to the returned object: `effective_reported_cash_tips_cents: effectiveReportedCashTips,`. (`...adjustments` already spreads `adj_reported_cash_tips_cents` into the result.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/payroll/__tests__/calculations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payroll/calculations.ts lib/payroll/__tests__/calculations.test.ts
git commit -m "feat(payroll): compute reported cash tips (round actual/divisor) + override"
```

---

## Task 5: Declared cash into buckets — `lib/payroll/previewService.ts`

**Files:**
- Modify: `lib/payroll/previewService.ts`
- Test: `lib/payroll/__tests__/previewService.test.ts`

**Interfaces:**
- Consumes: `fetchShiftsByDay` (now with `cash_tips_cents`), `fetchTipsAndCashTakeByDay` (no cash take), `mergeAdjustments(..., divisor)`.
- Produces: `PayrollPreview` without `total_cash_take_cents`; guarantee buckets' `cashTipsCents` = summed declared cash.

- [ ] **Step 1: Update the test fixtures/assertions**

In `previewService.test.ts`: give shift fixtures `cash_tips_cents`; assert an employee's `effective_cash_tips_cents` equals the sum of their declared cash across the period (no rate, no pooling), that `effective_reported_cash_tips_cents = round(that / divisor)`, and that the returned preview has no `total_cash_take_cents`. Keep/adjust existing card-tip pooling assertions (unchanged behavior).

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run lib/payroll/__tests__/previewService.test.ts`
Expected: FAIL against old estimate/`total_cash_take_cents`.

- [ ] **Step 3: Implement in `buildGuaranteeBuckets`**

- Build a cash index alongside hours: `cashByDate: Map<string, Map<string, number>>` from `dailyShifts` (`s.cash_tips_cents`).
- Remove the `cashTipsRate`/`config.cash_tips_rate` usage, `groupCash`/`totalCashTakeCents` accumulation, and the `dailyCashTips` pooling map entirely.
- In Step-2 guarantee-bucket assembly, populate `cashTipsCents` for each member by summing `cashByDate.get(day)?.get(id)` over the bucket's days (gate on `tippedTeamIds`).
- `tip_buckets.push({ label, tipsPooledCents: groupTips })` (drop `cashTakeCents`).
- Return object drops `totalCashTakeCents`; keep `totalPooledTipsCents`.

In `buildPayrollPreview`:
- Remove `total_cash_take_cents` from the returned preview.
- In the `entries` map, add `adj_reported_cash_tips_cents: stored?.adj_reported_cash_tips_cents ?? null` to the adjustments object and pass `config.reported_cash_tips_divisor` as the third arg to `mergeAdjustments`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/payroll/__tests__/previewService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payroll/previewService.ts lib/payroll/__tests__/previewService.test.ts
git commit -m "feat(payroll): feed declared cash into guarantee buckets; drop cash-take"
```

---

## Task 6: Config route — divisor in, rate out — `app/api/payroll/config/route.ts`

**Files:**
- Modify: `app/api/payroll/config/route.ts`

- [ ] **Step 1: Edit**

Read the file. In the PATCH body destructure/validation: remove `cash_tips_rate`; add `reported_cash_tips_divisor`. In the insert object, replace `cash_tips_rate: cash_tips_rate ?? 0.01` with `reported_cash_tips_divisor: reported_cash_tips_divisor ?? 10`. Add a guard rejecting non-integer or `< 1` divisor, mirroring the existing validation style (e.g. `if (reported_cash_tips_divisor != null && (!Number.isInteger(reported_cash_tips_divisor) || reported_cash_tips_divisor < 1)) return NextResponse.json({ error: "Invalid reported_cash_tips_divisor" }, { status: 400 });`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "api/payroll/config"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/payroll/config/route.ts
git commit -m "feat(payroll): config route accepts reported_cash_tips_divisor"
```

---

## Task 7: Allow reported override — `entries/[employeeId]/route.ts`

**Files:**
- Modify: `app/api/payroll/periods/[id]/entries/[employeeId]/route.ts`

- [ ] **Step 1: Edit**

Add `"adj_reported_cash_tips_cents"` to the `allowed` array.

- [ ] **Step 2: Commit**

```bash
git add "app/api/payroll/periods/[id]/entries/[employeeId]/route.ts"
git commit -m "feat(payroll): accept adj_reported_cash_tips_cents override"
```

---

## Task 8: Shifts route — declared cash direct — `shifts/route.ts`

**Files:**
- Modify: `app/api/payroll/periods/[id]/shifts/route.ts`

- [ ] **Step 1: Edit**

- Drop `cash_tips_rate` from the `payroll_config` select and the `cashTipsRate` const.
- `rawShifts` (now `DailyShift[]` with `cash_tips_cents`): when building `rowMap`, set `daily_cash_tips_cents[shift.date] += shift.cash_tips_cents` and accumulate `total_cash_tips_cents` directly, only for members in `tippedTeamIds` (non-tipped stay `null`).
- Remove the cash portion of the bucket math: delete `cashTakeMap`, `bucket.cashTakeCents`, `empBucketCashTips`, and the `dailyCashTipsCents` pooling loop + its populate block. **Keep** the card-tip pooling (`dailyTipsCents` / `tipsPooledCents`) intact.
- `fetchTipsAndCashTakeByDay` result is still used for card tips (`tipsMap`); keep it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "api/payroll/periods"`
Expected: no errors in `shifts/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add "app/api/payroll/periods/[id]/shifts/route.ts"
git commit -m "feat(payroll): shifts tab uses declared cash tips directly"
```

---

## Task 9: Lock snapshot — `lock/route.ts`

**Files:**
- Modify: `app/api/payroll/periods/[id]/lock/route.ts`

- [ ] **Step 1: Edit**

In the `upserts` map object add:
```ts
reported_cash_tips_cents: entry.effective_reported_cash_tips_cents,
adj_reported_cash_tips_cents: entry.adj_reported_cash_tips_cents,
```

- [ ] **Step 2: Commit**

```bash
git add "app/api/payroll/periods/[id]/lock/route.ts"
git commit -m "feat(payroll): snapshot reported cash tips at lock"
```

---

## Task 10: Summary toggle + view-aware totals — `PayrollPeriodView.tsx`

**Files:**
- Modify: `app/components/payroll/PayrollPeriodView.tsx`

**Interfaces:**
- Produces: `cashView: "actual" | "reported"` passed to `PayrollEntryRow`.

- [ ] **Step 1: Edit**

- Add state: `const [cashView, setCashView] = useState<"actual" | "reported">("actual");`
- Render an `Actuals | Gusto-reported` segmented control (reuse `TabBar`/`SubNav` primitive or a token-styled 2-button group with `.btn-secondary`/`.btn-primary` active state) shown only when `activeTab === "summary"`, placed near the existing Override button.
- Totals: compute `totRCTips = entries.reduce((s,e)=>s+e.effective_reported_cash_tips_cents,0)`. Define `viewCash = cashView === "actual" ? totCTips : totRCTips` and `viewComp = totBase + totPTips + viewCash + totBonus`. Use `viewCash` in the Cash Tips footer cell, `viewComp` in the Total footer cell, and `viewComp/totHours` for the footer $/hr. Bonus/Base/Card/Hours totals unchanged.
- Rename the Cash Tips `<th>` to show the active basis, e.g. `Cash Tips{cashView === "reported" ? " (reported)" : ""}`.
- Pass `cashView={cashView}` to each `<PayrollEntryRow>`.
- When switching `activeTab` away from summary, leave `cashView` as-is (harmless); keep resetting `overrideMode` as today.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep PayrollPeriodView`
Expected: only the "cashView prop unknown" error from `PayrollEntryRow` until Task 11.

- [ ] **Step 3: Commit**

```bash
git add app/components/payroll/PayrollPeriodView.tsx
git commit -m "feat(payroll): Actuals/Gusto-reported toggle on summary"
```

---

## Task 11: View-aware cash cell + reported override — `PayrollEntryRow.tsx`

**Files:**
- Modify: `app/components/payroll/PayrollEntryRow.tsx`

**Interfaces:**
- Consumes: `cashView: "actual" | "reported"` prop.

- [ ] **Step 1: Edit**

- Add `cashView: "actual" | "reported"` to `Props`.
- Add state `const [adjReportedCashTips, setAdjReportedCashTips] = useState<string>(entry.adj_reported_cash_tips_cents != null ? String(entry.adj_reported_cash_tips_cents / 100) : "");`
- Include `adj_reported_cash_tips_cents` in `hasAnyOverride`.
- In `save()`'s body add `adj_reported_cash_tips_cents: adjReportedCashTips !== "" ? Math.round(parseFloat(adjReportedCashTips) * 100) : null,`.
- Replace the single Cash Tips `<ValueCell>` with a view-driven one:
  - `actual`: `effectiveVal=fmt(entry.effective_cash_tips_cents)`, `computedVal=fmt(entry.cash_tips_cents)`, `adjIsSet={entry.adj_cash_tips_cents != null}`, `adjState={adjCashTips}`, `setAdj={setAdjCashTips}`.
  - `reported`: `effectiveVal=fmt(entry.effective_reported_cash_tips_cents)`, `computedVal=fmt(entry.reported_cash_tips_cents)`, `adjIsSet={entry.adj_reported_cash_tips_cents != null}`, `adjState={adjReportedCashTips}`, `setAdj={setAdjReportedCashTips}`.
- Row Total + $/hr become view-aware: `const rowCash = cashView === "actual" ? entry.effective_cash_tips_cents : entry.effective_reported_cash_tips_cents; const rowTotal = entry.base_pay_cents + entry.effective_paycheck_tips_cents + rowCash + entry.effective_bonus_cents;` Use `rowTotal` in the Total cell and `rowTotal / effective_hours / 100` for $/hr. Bonus cell unchanged.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep PayrollEntryRow`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/payroll/PayrollEntryRow.tsx
git commit -m "feat(payroll): view-aware cash cell + reported override editing"
```

---

## Task 12: Gusto panel uses reported cash — `GustoSummaryPanel.tsx`

**Files:**
- Modify: `app/components/payroll/GustoSummaryPanel.tsx`

- [ ] **Step 1: Edit**

- Change the Cash Tips cell to `fmtCents(entry.effective_reported_cash_tips_cents)`.
- Update the `<th>` to `Cash Tips` with a caption/subtext noting it's the reported figure, e.g. add under the intro `<p>`: "Cash tips are the payroll-reported figure (reduced ratio); bonus and paycheck tips are actuals." (No divisor value needed inline; keep copy token-styled.)

- [ ] **Step 2: Commit**

```bash
git add app/components/payroll/GustoSummaryPanel.tsx
git commit -m "feat(payroll): Gusto summary reports cash at configured ratio"
```

---

## Task 13: Shift legend copy — `ShiftTimeline.tsx`

**Files:**
- Modify: `app/components/payroll/ShiftTimeline.tsx`

- [ ] **Step 1: Edit**

Change the cash legend line text from `Cash tips from {FREQ_LABELS[tip_pool_frequency]} pool` to `Declared cash tips (Square)`. Do not touch the card-tip legend or any (pre-existing) raw color classes.

- [ ] **Step 2: Commit**

```bash
git add app/components/payroll/ShiftTimeline.tsx
git commit -m "chore(payroll): shift legend reflects declared cash tips"
```

---

## Task 14: Settings — divisor field + formula — `settings/payroll/page.tsx`

**Files:**
- Modify: `app/finance/settings/payroll/page.tsx`

- [ ] **Step 1: Edit**

- Replace the `cashTipsRate` state + its input with `reportedDivisor` (string). In the `useEffect` seed: `setReportedDivisor(String(config.reported_cash_tips_divisor ?? 10));`.
- In `buildConfigBody`, replace `cash_tips_rate: ... parseFloat(cashTipsRate)` with `reported_cash_tips_divisor: overrides?.reported_cash_tips_divisor ?? parseInt(reportedDivisor, 10)`, and update the overrides type.
- Replace the input UI: a number field `min=1 step=1` labelled "Reported cash tips ratio (N:1)".
- Update the formula box lines: `cash_tips = Σ declared cash per shift (Square)`, add `reported_cash = round(cash_tips ÷ {reportedDivisor || "10"})`, and keep `bonus = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)` (bonus uses actual cash — unchanged). Remove the old `cash_tips = hour_share × rate × total_cash_take` line.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "settings/payroll"`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/finance/settings/payroll/page.tsx
git commit -m "feat(payroll): settings expose reported cash tips ratio"
```

---

## Task 15: Full verify + live check

**Files:** none (verification)

- [ ] **Step 1: Full verify**

Run: `npm run verify`
Expected: lint + typecheck + tests all PASS. Fix any residual references to removed fields (`cash_tips_rate`, `total_cash_take_cents`, `cashTakeCents`) surfaced here.

- [ ] **Step 2: Live sanity check (dev server)**

Start the payroll dev server (preview_start), open the current pay period. Verify on the Summary tab: the `Actuals | Gusto-reported` toggle flips the Cash Tips column, Total, and $/hr; Bonus is identical across views; Andrew Ogden's actual cash reflects ~declared value and his bonus has shrunk vs the prior $14.84. On the Shifts tab confirm per-day cash matches declared amounts and the legend reads "Declared cash tips (Square)". On the Gusto Summary tab confirm cash = round(actual ÷ 10). In Override Mode, confirm the reported cell is editable in Gusto view and persists.

- [ ] **Step 3: Final commit (if fixes were needed)**

```bash
git add -A && git commit -m "test(payroll): green verify for declared cash tips"
```

---

## Self-Review

- **Spec coverage:** declared source (T2), drop estimator/cash-take (T3,T5,T6,T14), reported=round(actual/divisor) + override (T4,T7,T11), bonus uses actual only (T4 test), toggle (T10,T11), Gusto reported (T12), shifts declared (T8,T13), lock snapshot (T9), schema+config (T1,T6,T14), types (T1). All spec sections mapped.
- **Placeholder scan:** none — code shown for all logic steps.
- **Type consistency:** `reported_cash_tips_cents` / `adj_reported_cash_tips_cents` / `effective_reported_cash_tips_cents` and `reported_cash_tips_divisor` used identically across T1/T4/T5/T9/T11; `mergeAdjustments` 3-arg signature consistent T4↔T5; `DailyShift.cash_tips_cents` consistent T2↔T8.
