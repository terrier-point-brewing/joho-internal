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

## The governing invariant

**Attributed card tips always sum to the pool actually collected.**

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

### Guards

Distinguish *user-caused impossibility* (block the save) from a *pre-existing data
condition* (surface, don't block):

| Condition | Response |
|---|---|
| `S > P` | **422** — "Pinned card tips for {label} total ${S}, which exceeds the ${P} pool." |
| `R ≠ 0`, no unpinned cell with hours > 0, **and `S > 0`** | **422** — "No unpinned cell can absorb the remaining ${R}; pins must total exactly ${P}." |
| `R > 0`, no unpinned cell with hours > 0, **and `S == 0`** | **Not an error.** Nobody worked but tips were collected — pre-existing condition (today the pool silently vanishes). Attribute nothing and report `pool_variance`. |

Field validation: `adj_hours >= 0`, `adj_*_cents >= 0` — else **400**.

### Equivalence property

With zero overrides the new model is algebraically identical to the current one. **The
refactor must not move any existing payroll number.** This is a required test.

### Blast radius

Redistribution scope equals the tip-pool bucket, driven by `tip_pool_frequency`. A `daily`
pool contains an edit to that day; the schema-default `biweekly` rebalances the whole
period from a single edit. The UI must name the affected span rather than let this surprise
anyone.

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
`employees.id`. The module normalizes to `employees.id` internally so every consumer works
in employee-id space. Shifts with no matching employee row pass through unmapped and cannot
be overridden — correct, since there is no FK target.

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
- A banner names the span that rebalances, from `tip_buckets`, plus any `pool_variance`.
- New affordances use token utilities only. The existing hour-ramp raw colors
  (`bg-amber-900/30` etc.) stay — sanctioned data-ramp exception per `docs/UI_STANDARD.md`;
  do not token-swap a multi-step ramp.

## 8. Tests

Co-located `lib/payroll/dailyGrid.test.ts` (pure logic; `lib/` coverage floor applies):

1. **Equivalence** — no overrides: output matches current implementation on a fixture.
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
14. Bucket boundaries honored at each `tip_pool_frequency`.

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
- **Biweekly pool blast radius.** Confirm the production `tip_pool_frequency` before rollout;
  under `biweekly`, one edit rebalances the entire period.
