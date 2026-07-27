# Payroll day-override grid — design

**Date:** 2026-07-27
**Area:** Taproom › Payroll › Shifts
**Status:** approved, ready for planning

## Goal

Let managers and admins override **hours worked, cash tips, and card tips** for a single
employee-day cell in the Shifts grid, with the corrected values feeding the Summary tab,
the bonus calculation, the Gusto export, and the locked snapshot.

## Background — current state

`app/components/payroll/ShiftTimeline.tsx` renders a read-only employee x day grid. Every
value is recomputed from Square on each request; nothing is persisted per day.

- **Hours** and **declared cash tips** come straight off the Square shift record.
- **Card tips** are derived: a fixed pool is split across tipped employees proportional to
  hours, at `payroll_config.tip_pool_frequency` (`daily` | `weekly` | `biweekly`).

The only existing override is period-level: one `payroll_entries.adj_*` value per employee
per period that replaces the whole-period sum. There is no way to correct a single day.

Two pipelines independently reimplement the same Square fetch, day indexing, and pool
attribution — `app/api/payroll/periods/[id]/shifts/route.ts` (lines 63–174) and
`lib/payroll/previewService.ts::buildGuaranteeBuckets` (lines 52–145). They have already
drifted in shape. Once overrides feed totals, any divergence means the Shifts grid and the
Summary tab disagree about the same paycheck.

## Dependency — PR #276 (tip refunds)

`ea47280 fix(payroll): net refunds out of pooled card tips` (PR #276, open) changes
`fetchTipsAndCashTakeByDay` to net refunds out of the pool: Square keeps a payment
`COMPLETED` after refund, so refunded tips were inflating the pool. A refund is attributed
to **its original payment's day**, not the refund's own date, and each payment's net tip is
floored at zero.

This is strictly upstream of this feature — `P_bucket` is built from that function's output
— and touches no file in this spec's file map. But it changes what "the pool" *is*, so:

- **Build this work on top of PR #276.** Rebase onto it (or cherry-pick `ea47280` into the
  worktree) so tests run against net-of-refund pools. If #276 merges first, a plain rebase
  onto main is clean.
- **The equivalence-test fixture must include a refunded payment** (see §8 test 1), or the
  extraction could silently reintroduce the bug it fixed.
- It also introduces `aggregateDailyTips(payments, refunds)` as a pure exported function —
  use it to build `DailyTips[]` fixtures directly instead of mocking Square.

## The governing invariant

**Attributed card tips always sum to the pool actually collected**, where "collected" means
net of refunds per PR #276.

An override never creates or destroys tip money. Increasing one person's share must reduce
another's within the same pool bucket.

## 1. Attribution model

### Reformulation

Today's attribution is two-step: split the bucket pool by bucket hours, then split each
employee's share across their days by day-hour fraction. That composition collapses to a
single day-level split:

```
(bucketHours[e] / Σ bucketHours) × P  ×  (dayHours[e][d] / bucketHours[e])
  ≡  P × dayHours[e][d] / Σ bucketHours
```

Reformulating as that single step makes pinning fall out of one formula.

### Algorithm

For each tip-pool bucket `B` (day set per `tip_pool_frequency`):

```
P     = pool cents collected across B's days            (from Square, never overridden)
cells = { (e,d) : d ∈ B, e tip-eligible, effHours[e][d] > 0 } ∪ { pinned cells }
pins  = cells with a non-null adj_paycheck_tips_cents
S     = Σ pins
R     = P − S

tips[e][d] = pin[e][d]                                     if pinned
           = R × effHours[e][d] / Σ_unpinned effHours       otherwise
```

An **hours** override changes `effHours`, so the denominator moves and every unpinned cell
rebalances. A **card-tip** override pins a cell and pushes the remainder onto the others.
Both requirements, one formula. Pool total is exact by construction.

### Rounding

Per-cell `Math.round` (today's approach) can drift several cents. Since the total is now an
asserted invariant, use **largest-remainder**:

1. `exact[i] = R × w[i] / Σw`; take `floor(exact[i])`.
2. Distribute the `R − Σfloor` leftover cents one at a time to the largest fractional
   remainders.
3. Break ties deterministically by `(employee_id, work_date)` so output is stable across runs.

### Guards — write path rejects, read path degrades

A pool can shrink **after** pins are stored: a refund syncs later and retroactively reduces
its original payment's day (PR #276). Stored pins that were valid can therefore become
invalid with no user action. So the same condition must reject on write but never throw on
read — the page has to render regardless.

**`buildDailyGrid` never throws on pool imbalance.** It computes best-effort and reports per
bucket. The write route calls it with the *proposed* override set and rejects on any reported
imbalance, so a write can never create an invalid state; a read tolerates a state that
*became* invalid upstream and surfaces it loudly.

| Condition | `buildDailyGrid` (read) | `PUT` route (write) |
|---|---|---|
| `S > P` | Pinned cells keep their pinned values; **unpinned cells get 0** (never negative). `attributed = S`. | **422** — "Pinned card tips for {label} total ${S}, which exceeds the ${P} pool." |
| `R ≠ 0`, no unpinned cell with hours > 0, **and `S > 0`** | Attribute pins only. `attributed = S`. | **422** — "No unpinned cell can absorb the remaining ${R}; pins must total exactly ${P}." |
| `R > 0`, no unpinned cell with hours > 0, **and `S == 0`** | Attribute nothing. `attributed = 0`. | **Accepted** — nobody worked but tips were collected. Pre-existing condition (today the pool silently vanishes); now surfaced. |

Each bucket reports `attributed_cents` against `pool_cents`. A single signed variance
(`attributed − pool`) covers all three: `0` healthy, positive = pins exceed pool,
negative = unattributable pool. The UI banners any non-zero variance, and treats the
positive case as blocking-severity ("your pins now exceed the pool — revise them").

Field validation: `adj_hours >= 0`, `adj_*_cents >= 0` — else **400**.

### Equivalence property

With zero overrides the new model is algebraically identical to the current one. **The
refactor must not move any existing payroll number.** This is a required test.

### All three pool frequencies are first-class

The algorithm is bucket-generic — it never assumes a bucket is one day. `daily`, `weekly`,
and `biweekly` are equally supported, with no preferred configuration, and all three are
covered by tests (§8 case 14). Bucket construction reuses the existing `dayGroups()` shape
from `previewService.ts:20-26`.

Redistribution scope equals the bucket, so the span an edit rebalances differs per setting:

| `tip_pool_frequency` | Bucket | Rebalance span | Grid alignment |
|---|---|---|---|
| `daily` | one day | that day's column | one cell column |
| `weekly` | 7-day chunk | that week | **already delimited** — the grid's week subtotal columns use the same `slice(i, i+7)` chunking |
| `biweekly` (schema default) | whole period | every cell in the grid | the full row |

`weekly` aligns exactly with the week boundaries `ShiftTimeline` already draws, so keep the
two chunkings identical — do not let them diverge.

The UI names the affected span for whichever setting is active (§7) rather than assuming a
narrow one. Under `daily`, a late refund retroactively changes a *past* day's bucket, so
pins are most likely to be invalidated after the fact at this setting.

## 2. Shared module — `lib/payroll/dailyGrid.ts`

Single owner of day-level payroll computation. Both pipelines consume it.

```ts
export interface DayOverride {
  employee_id: string;
  work_date: string;                        // YYYY-MM-DD
  adj_hours: number | null;                 // null = use Square
  adj_paycheck_tips_cents: number | null;   // null = use pool attribution
  adj_cash_tips_cents: number | null;       // null = use Square declared
  note: string | null;
}

export interface TipBucket {
  label: string;
  days: string[];
  pool_cents: number;
  attributed_cents: number;                 // === pool_cents unless unattributable
}

export interface DailyGrid {
  days: string[];
  /** date -> employeeId -> value, all post-override */
  hoursByDate:    Map<string, Map<string, number>>;
  cashByDate:     Map<string, Map<string, number>>;
  cardTipsByDate: Map<string, Map<string, number>>;
  buckets: TipBucket[];
  totalPooledTipsCents: number;
}

export async function buildDailyGrid(
  period: PayPeriod,
  employees: Employee[],
  tipPoolFrequency: TipPoolFrequency,
  overrides: DayOverride[],
): Promise<DailyGrid>;
```

**ID space:** the Square pipeline keys on `square_team_member_id`; overrides key on
`employees.id`. The module keys its maps on **`square_team_member_id`** and translates
override rows employee-id → square-id once at entry, using the passed `employees` list.

Rationale (revised during planning — an earlier draft normalized to `employees.id`):
square-id keying is the minimal-blast-radius choice. `GuaranteeBucket` in `calculations.ts`
is already square-id keyed, so `previewService` needs **no translation at all** and
`calculations.ts` + `calculations.test.ts` stay untouched — which matters because the whole
safety argument rests on golden tests staying frozen (§8 case 1). It also preserves today's
grid behavior of showing shifts from team members with no `employees` row. Unifying the two
ID spaces is a legitimate follow-up, but must not ride along with a behavior-preserving
refactor.

An employee with no `square_team_member_id` cannot be overridden — they are already excluded
from payroll entirely by `computePayrollEntries`, so override mode lists only employees that
have one.

**Baseline pass.** To render struck-through originals, callers need pre-override values.
Card tips are derived and rebalance, so the "original" is only meaningful as *what this cell
would have been with no overrides in the bucket*. Compute the grid twice — once with
`overrides`, once with `[]`. This is pure computation over already-fetched data; no extra
Square calls.

**Consumers after the refactor:**
- `shifts/route.ts` — thin shaper: fetch overrides, call `buildDailyGrid` twice, shape rows.
- `previewService.buildGuaranteeBuckets` — re-aggregates grid output into guarantee buckets.
  Its own Square fetch and step-1 attribution (lines 65–119) are deleted.

## 3. Override layering

```
Layer 0  Square raw
Layer 1  day overrides (this feature)  -> hours_worked / paycheck_tips_cents / cash_tips_cents
Layer 2  period adj_* (existing)       -> effective_*
```

Day overrides feed the **computed** layer. Consequences:

- `mergeAdjustments` is untouched; period-level overrides still win.
- `lock/route.ts` snapshots `effective_*` — day overrides reach the locked snapshot with no
  change to the lock route.
- Where a period-level override masks day overrides on the same field, the Summary row shows
  a conflict marker so the masking is visible.

## 4. Data model

New migration. Check `supabase/migrations/` for prefix collisions before naming — same-day
`YYYYMMDD` prefixes collide and the CLI keys on digits before the first `_`.

```sql
create table payroll_shift_overrides (
  id            uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references pay_periods(id) on delete cascade,
  employee_id   uuid not null references employees(id)   on delete cascade,
  work_date     date not null,
  adj_hours               numeric(8,4),
  adj_paycheck_tips_cents integer,
  adj_cash_tips_cents     integer,
  note          text,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (pay_period_id, employee_id, work_date)
);
create index on payroll_shift_overrides (pay_period_id);
```

- `pay_period_id` is denormalized against `work_date` deliberately — it scopes every query
  and gives clean cascade-on-period-delete. Range containment is validated in the route.
- Rows **persist after lock**: audit trail, and the preview route recomputes live even for
  locked periods, so deleting them would change locked history.
- **RLS:** reuse the existing `payroll_reader_roles()` helper and the `"payroll readers"`
  policy shape from `20260709_rls_phase3_tighten_sensitive.sql`.
- `created_by` / `updated_by` because this is the first feature putting money edits in a
  non-admin's hands.

## 5. API

### `GET /api/payroll/periods/[id]/shifts`

**Gate change (bug fix):** `CAP.payrollManage` → `CAP.payrollRead`. Today the route is
admin-only while `app/taproom/payroll/layout.tsx` gates the page at `payrollRead`, so a
manager sees the Shifts tab and gets a 403. Accepted consequence: the grid becomes visible
to anyone with payroll read.

Response gains, per row:

```ts
overrides: Record<string, {                               // work_date -> stored override
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}>;
source_hours:           Record<string, number>;           // baseline pass (pre-override)
source_tips_cents:      Record<string, number> | null;
source_cash_tips_cents: Record<string, number> | null;
```

and top-level:

```ts
tip_buckets:   TipBucket[];                               // label, days, pool, attributed
pool_variance: Array<{ label: string; pool_cents: number; attributed_cents: number }>;  // only when non-zero
```

### `PUT /api/payroll/periods/[id]/shift-overrides/[employeeId]` — new

Mirrors the existing `entries/[employeeId]` route shape. Gated on `CAP.payrollDayOverride`.

```ts
body: {
  cells: Array<{
    work_date: string;
    adj_hours: number | null;
    adj_paycheck_tips_cents: number | null;
    adj_cash_tips_cents: number | null;
    note?: string | null;
  }>
}
```

**Semantics: full replace** of that employee's override rows for the period — idempotent.
A cell whose three `adj_*` values are all null is deleted (that is how you clear an
override). Rows absent from `cells` are deleted.

**Validation order:** period open (**409**) → `work_date ∈ [start_date, end_date]` (**400**)
→ non-negative values (**400**) → run `buildDailyGrid` with the proposed override set and
apply the pool guards (**422**). Validating by running the real computation guarantees
stored state is always internally valid.

## 6. Auth

`CAP.payrollOperate` already resolves to exactly manager + admin (manager's bundle grants
`payroll: "operate"`; admin holds `ROOT: "admin"`). `capabilities.ts` states that several
names may intentionally share a coordinate because capabilities name the *intent*. So add a
named intent, not a new coordinate:

```ts
payrollDayOverride: { scope: "payroll", level: "operate" },
```

- **No change to `ROLE_BUNDLES`.**
- Manager still cannot lock a period or use the Summary-tab override — both `payrollManage`.

## 7. UI

Layout **Option B** (click-to-edit one field at a time), validated against a mockup.

- **Override Mode** button appears on the Shifts tab, gated by
  `usePermissions().can(CAP.payrollDayOverride)` — decoupled from the `editable` prop, which
  means "Finance-level editable" and is `false` in Taproom.
  **Import `CAP` from `@/lib/auth/capabilities` directly**; the `@/lib/auth` barrel pulls
  server-only code into the client bundle — breaks `npm run build` while `npm run verify`
  still passes (enforced by `scripts/check-permissions.mjs`).
- A cell stays read-only text until a line is clicked; that line becomes an input, the other
  two remain text.
- An overridden value renders in `text-accent` with the original struck through beneath —
  the `ValueCell` idiom already used in `PayrollEntryRow.tsx:54-61`.
- **Empty cells are clickable in override mode.** A missing punch is the likeliest reason to
  override; today a zero-hour day is an inert placeholder div.
- **Override mode lists every active hourly-tipped employee**, including those with zero
  shifts — otherwise someone who never clocked in has no row to fix. The read-only view is
  unchanged.
- **Per-row Save**, invalidating both `queryKeys.payroll.shifts(id)` and
  `queryKeys.payroll.preview(id)`. (The existing row save invalidates only `preview`.)
- **Notes:** the schema and API carry a note per cell. v1 exposes a single note input per
  row — mirroring the Notes field in `PayrollEntryRow.tsx:197-203` — whose value is written
  to every cell edited in that save. Per-cell note editing is not in v1.
- **Rebalance span, per active frequency.** A banner names the span from `tip_buckets` —
  "Card tips rebalance within {label}" — worded from the live config, never assuming daily.
  When a card-tip cell is focused for editing, highlight the cells that will move: the day
  column (`daily`), the week block (`weekly`), or the whole grid (`biweekly`).
- **Variance banner.** Any non-zero `attributed − pool`. A positive variance (pins exceed
  the pool — reachable without user action when a refund lands late) renders at
  blocking severity with the affected bucket and the amount to reconcile.
- New affordances use token utilities only. The existing hour-ramp raw colors
  (`bg-amber-900/30` etc.) stay — sanctioned data-ramp exception per `docs/UI_STANDARD.md`;
  do not token-swap a multi-step ramp.

## 8. Tests

Co-located `lib/payroll/dailyGrid.test.ts` (pure logic; `lib/` coverage floor applies):

1. **Equivalence** — the existing `lib/payroll/__tests__/previewService.test.ts` must pass
   **unmodified**. It already mocks exactly the two Square fetchers and asserts real computed
   output across employee filtering, attribution, guarantee bucketing at every frequency,
   adjustment merge, labels, and totals — it *is* the equivalence harness, stronger than a
   hand-built fixture. Treat the file as frozen: editing it to accommodate the refactor
   voids the equivalence claim. `lib/payroll/__tests__/calculations.test.ts` is likewise
   untouched. Add one case there covering a refunded payment so the extraction provably
   preserves PR #276's netting (build it via `aggregateDailyTips`).
2. Hours override — pool total preserved, other cells rebalance.
3. Card-tip pin — pinned cell exact, remainder redistributed, `Σ == pool`.
4. Multiple pins in one bucket.
5. `S > P` → guard fires.
6. All cells pinned, `S ≠ P` → guard fires.
7. All cells pinned, `S == P` → accepted.
8. Rounding — pool that does not divide evenly still sums exactly to the pool.
9. Zero eligible hours, pool > 0, no pins → variance reported, no throw.
10. Hours override to 0 → employee drops out of the split.
11. Card-tip pin on a zero-hour cell → allowed.
12. Cash override → no effect on hours or card tips.
13. Day override + period-level `adj_*` → period value wins in `effective_*`.
14. **Bucket boundaries honored at each `tip_pool_frequency`** — run cases 2–8 under all
    three of `daily`, `weekly`, `biweekly`; no setting is privileged. Assert `weekly`
    bucketing matches `ShiftTimeline`'s week chunking exactly.
15. **Refund shrinks a pool below stored pins** — `buildDailyGrid` does **not** throw,
    unpinned cells clamp to 0, and a positive variance is reported for that bucket.
16. **Refund lands on a day after its original payment** — the pool reduction lands on the
    payment's day, and under `daily` pooling that past day's attribution rebalances.
17. Write path rejects (422) the exact conditions the read path degrades on — same
    override set, opposite outcomes.

## 9. Out of scope

- Overriding the tip pool total itself.
- Editing a locked period.
- Day-level *reported* cash tips — a period-level divisor concept; stays period-level.
- Backfilling or migrating existing periods.

## 10. File map

| Group | Files |
|---|---|
| Schema | `supabase/migrations/<new>.sql` |
| Core logic | `lib/payroll/dailyGrid.ts`, `lib/payroll/dailyGrid.test.ts`, `lib/payroll/previewService.ts`, `lib/payroll/types.ts` |
| API | `app/api/payroll/periods/[id]/shifts/route.ts`, `app/api/payroll/periods/[id]/shift-overrides/[employeeId]/route.ts` |
| Auth | `lib/auth/capabilities.ts` |
| UI | `app/components/payroll/ShiftTimeline.tsx`, `app/components/payroll/PayrollPeriodView.tsx`, `lib/query-keys.ts` |

~11 files, 4 locality groups.

## 11. Risks

- **Rewriting a live paycheck path.** Mitigated by the equivalence test (#1) — no-override
  output must be byte-identical to today's.
- **Migration is human-gated.** Per project convention the migration is applied to prod by
  the orchestrator only, after explicit approval. The feature 500s until it is applied.
- **PR #276 merge order.** No file overlap, but it redefines the pool. Rebase onto it before
  building fixtures; do not develop against gross tips.
- **Pins can be invalidated by later data, not by users.** A refund syncing after a pin is
  stored can push a bucket into positive variance with nobody having touched anything. The
  read-path degradation rule and the blocking variance banner are what keep that visible
  instead of silently wrong — they are not optional polish.
