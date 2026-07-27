# Payroll Day-Override Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let managers and admins override hours, cash tips, and card tips for a single employee-day cell in the Taproom › Payroll › Shifts grid, with corrections feeding Summary totals, bonus, Gusto export, and the locked snapshot.

**Architecture:** Extract day-level payroll computation into one module, `lib/payroll/dailyGrid.ts`, that both the Shifts route and `previewService` consume — they currently duplicate it. Card-tip attribution is reformulated from a two-step split into a single day-level split so that overrides fall out of one formula: an hours override moves the pool denominator, a card-tip override pins a cell and pushes the remainder onto unpinned cells. Attributed tips always equal the pool collected.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, TanStack Query, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-payroll-day-override-grid-design.md` — read §1 (attribution model) before Task 2.

## Execution Budget

- **Mode:** subagent-driven-development (4 locality groups: schema+auth / lib.payroll / api / ui).
- **Spawn cap = 6.** STOP and report before exceeding it.
- Route implementation spawns to the `impl` agent type. Models are per-task below.

## Global Constraints

- `lib/payroll/__tests__/previewService.test.ts` and `lib/payroll/__tests__/calculations.test.ts` are **FROZEN**. They are the equivalence gate for the refactor. If a change makes them fail, the change is wrong — fix the change, never the test. Adding new cases is allowed; modifying or deleting existing ones is not.
- `lib/payroll/calculations.ts` is **not modified by this plan**. `GuaranteeBucket` stays keyed by `square_team_member_id`.
- `dailyGrid.ts` keys all maps on `square_team_member_id`; override rows are translated employee-id → square-id once at entry.
- `buildDailyGrid` **never throws** on pool imbalance. Writes reject; reads degrade.
- No raw color utilities (`zinc/amber/red/green/blue/gray`) in new UI code — token utilities only. The existing hour-ramp raw colors in `ShiftTimeline.tsx:26-31` are a sanctioned data-ramp exception; leave them alone.
- Client components import `CAP` from `@/lib/auth/capabilities`, never from `@/lib/auth` (the barrel pulls server-only code into the client bundle; breaks `npm run build` while `npm run verify` still passes).
- Every task ends green on `npm run verify`.
- Migration is **not** applied to prod by any subagent. Orchestrator only, after explicit approval.
- Baseline at plan time: `npx vitest run lib/payroll lib/square` → 20 files, 198 tests passing. `ea47280` (PR #276, refund netting) is already cherry-picked onto this branch.

---

### Task 1: Migration + capability

**Model:** Haiku (mechanical — brief fully specifies the code)

**Files:**
- Create: `supabase/migrations/20260821_payroll_shift_overrides.sql`
- Modify: `lib/auth/capabilities.ts:51-53`

**Interfaces:**
- Consumes: nothing.
- Produces: table `payroll_shift_overrides`; `CAP.payrollDayOverride: { scope: "payroll", level: "operate" }`.

- [ ] **Step 1: Create the migration**

`20260820_user_permission_grants.sql` is the current highest prefix; `20260821` is free. Do not renumber existing files.

```sql
-- Per-day payroll overrides for the Shifts grid.
-- adj_* null = fall through to the Square-derived / pool-attributed value.
create table if not exists public.payroll_shift_overrides (
  id            uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  employee_id   uuid not null references public.employees(id)   on delete cascade,
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

create index if not exists payroll_shift_overrides_period_idx
  on public.payroll_shift_overrides (pay_period_id);

comment on table public.payroll_shift_overrides is
  'Manager/admin per-employee-per-day payroll corrections. Rows persist after a period locks (audit trail, and preview recomputes live even for locked periods).';

-- RLS: same shape as the payroll group in 20260709_rls_phase3_tighten_sensitive.sql
alter table public.payroll_shift_overrides enable row level security;

drop policy if exists "payroll readers" on public.payroll_shift_overrides;
create policy "payroll readers" on public.payroll_shift_overrides
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );
```

- [ ] **Step 2: Add the capability**

In `lib/auth/capabilities.ts`, the payroll block currently reads:

```ts
  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },
```

Replace with:

```ts
  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },
  // Named intent for the Shifts-grid day override. Deliberately shares the
  // `operate` coordinate, which manager and admin already hold — so no
  // ROLE_BUNDLES change, and manager still cannot lock a period or use the
  // Summary-tab period override (both `payrollManage`).
  payrollDayOverride: { scope: "payroll", level: "operate" },
```

Do **not** touch `lib/auth/roleGrants.ts`.

- [ ] **Step 3: Verify**

Run: `npm run verify`
Expected: PASS. No test asserts on the capability list; this is a type-level addition.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260821_payroll_shift_overrides.sql lib/auth/capabilities.ts
git commit -m "feat(payroll): payroll_shift_overrides table + payrollDayOverride capability"
```

---

### Task 2: Attribution core (pure functions)

**Model:** Opus (novel algorithmic logic — largest-remainder + pin redistribution)

**Files:**
- Create: `lib/payroll/dailyGrid.ts`
- Create: `lib/payroll/dailyGrid.test.ts`

**Interfaces:**
- Consumes: `TipPoolFrequency` from `./types`.
- Produces (Task 3 and Task 5 depend on these exact signatures):
  - `getDays(startDate: string, endDate: string): string[]`
  - `dayGroups(days: string[], frequency: TipPoolFrequency): string[][]`
  - `bucketLabels(frequency: TipPoolFrequency, startDate: string, endDate: string): string[]`
  - `distributeByWeight(total: number, weights: Array<{ key: string; weight: number }>): Map<string, number>`
  - `cellKey(sqId: string, date: string): string`
  - `attributeBucket(poolCents: number, cells: CellHours[], pins: CellPin[]): BucketAttribution`
  - `bucketViolations(buckets: TipBucket[]): BucketViolation[]`
  - types `DayOverride`, `TipBucket`, `DailyGrid`, `CellHours`, `CellPin`, `BucketAttribution`, `BucketViolation`

Read spec §1 before starting. The three guard rows in the spec's write/read table are the contract for `attributeBucket` + `bucketViolations`.

- [ ] **Step 1: Write the failing tests**

Create `lib/payroll/dailyGrid.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  distributeByWeight, attributeBucket, bucketViolations, cellKey,
  getDays, dayGroups,
} from "./dailyGrid";

const cell = (sq: string, date: string, hours: number) => ({ employeeId: sq, date, hours });
const pin  = (sq: string, date: string, cents: number) => ({ employeeId: sq, date, cents });
const sum  = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

describe("distributeByWeight", () => {
  it("splits proportionally", () => {
    const out = distributeByWeight(1000, [{ key: "a", weight: 3 }, { key: "b", weight: 1 }]);
    expect(out.get("a")).toBe(750);
    expect(out.get("b")).toBe(250);
  });

  it("sums exactly to the total when the split does not divide evenly", () => {
    const out = distributeByWeight(1000, [
      { key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 1 },
    ]);
    expect(sum(out)).toBe(1000);
  });

  it("is deterministic under tied remainders", () => {
    const w = [{ key: "b", weight: 1 }, { key: "a", weight: 1 }, { key: "c", weight: 1 }];
    expect([...distributeByWeight(100, w)]).toEqual([...distributeByWeight(100, w)]);
  });

  it("gives every key zero when no weight is positive", () => {
    const out = distributeByWeight(500, [{ key: "a", weight: 0 }]);
    expect(out.get("a")).toBe(0);
  });
});

describe("attributeBucket", () => {
  const cells = [cell("s1", "2026-07-01", 6), cell("s2", "2026-07-01", 2)];

  it("splits the pool by hours when nothing is pinned", () => {
    const r = attributeBucket(8000, cells, []);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(6000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(2000);
    expect(r.attributedCents).toBe(8000);
    expect(r.pinnedCents).toBe(0);
  });

  it("honors a pin exactly and pushes the remainder onto unpinned cells", () => {
    const r = attributeBucket(8000, cells, [pin("s1", "2026-07-01", 5000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(5000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(3000);
    expect(r.attributedCents).toBe(8000);
  });

  it("keeps the pool exact with multiple pins", () => {
    const three = [...cells, cell("s3", "2026-07-01", 4)];
    const r = attributeBucket(9000, three, [
      pin("s1", "2026-07-01", 1000), pin("s2", "2026-07-01", 2000),
    ]);
    expect(r.attributedCents).toBe(9000);
    expect(r.tips.get(cellKey("s3", "2026-07-01"))).toBe(6000);
  });

  it("does not throw and never goes negative when pins exceed the pool", () => {
    const r = attributeBucket(1000, cells, [pin("s1", "2026-07-01", 5000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(5000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(0);
    expect(r.attributedCents).toBe(5000);
    expect(r.pinnedCents).toBe(5000);
  });

  it("attributes pins only when no unpinned cell can absorb the remainder", () => {
    const r = attributeBucket(8000, [cell("s1", "2026-07-01", 6)], [pin("s1", "2026-07-01", 5000)]);
    expect(r.attributedCents).toBe(5000);
  });

  it("attributes nothing when nobody worked and nothing is pinned", () => {
    const r = attributeBucket(8000, [], []);
    expect(r.attributedCents).toBe(0);
  });

  it("drops a cell whose hours were overridden to zero", () => {
    const r = attributeBucket(8000, [cell("s1", "2026-07-01", 0), cell("s2", "2026-07-01", 2)], []);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(8000);
  });

  it("allows a pin on a zero-hour cell", () => {
    const r = attributeBucket(8000, [cell("s2", "2026-07-01", 2)], [pin("s1", "2026-07-01", 3000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(3000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(5000);
    expect(r.attributedCents).toBe(8000);
  });
});

describe("bucketViolations", () => {
  const base = { label: "7/1", days: ["2026-07-01"] };

  it("reports nothing when the bucket balances", () => {
    expect(bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 5000, attributed_cents: 8000 }])).toEqual([]);
  });

  it("reports pins_exceed_pool", () => {
    const v = bucketViolations([{ ...base, pool_cents: 1000, pinned_cents: 5000, attributed_cents: 5000 }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("pins_exceed_pool");
  });

  it("reports no_absorber when pins exist and the pool is under-attributed", () => {
    const v = bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 5000, attributed_cents: 5000 }]);
    expect(v[0].kind).toBe("no_absorber");
  });

  it("does not report an unattributable pool when nothing is pinned", () => {
    expect(bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 0, attributed_cents: 0 }])).toEqual([]);
  });
});

describe("dayGroups", () => {
  const days = getDays("2026-07-01", "2026-07-14");

  it("returns one group per day when daily", () => {
    expect(dayGroups(days, "daily")).toHaveLength(14);
  });

  it("returns 7-day chunks when weekly, matching ShiftTimeline's chunking", () => {
    const g = dayGroups(days, "weekly");
    expect(g).toHaveLength(2);
    expect(g[0]).toHaveLength(7);
  });

  it("returns a single group when biweekly", () => {
    expect(dayGroups(days, "biweekly")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/payroll/dailyGrid.test.ts`
Expected: FAIL — `Failed to resolve import "./dailyGrid"`.

- [ ] **Step 3: Implement the pure core**

Create `lib/payroll/dailyGrid.ts`. `getDays`, `dayGroups`, `bucketLabels` are moved verbatim from `lib/payroll/previewService.ts:9-43` (they are module-private there today) and exported here; Task 3 deletes them from `previewService.ts` and imports them from here.

```ts
import type { TipPoolFrequency } from "./types";

export interface DayOverride {
  employee_id: string;
  work_date: string;
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}

export interface TipBucket {
  label: string;
  days: string[];
  pool_cents: number;
  pinned_cents: number;
  attributed_cents: number;
}

export interface CellHours { employeeId: string; date: string; hours: number }
export interface CellPin   { employeeId: string; date: string; cents: number }

export interface BucketAttribution {
  /** cellKey(sqId, date) -> cents */
  tips: Map<string, number>;
  attributedCents: number;
  pinnedCents: number;
}

export interface BucketViolation {
  label: string;
  kind: "pins_exceed_pool" | "no_absorber";
  poolCents: number;
  pinnedCents: number;
}

/** Maps are keyed by square_team_member_id — see spec §2 "ID space". */
export const cellKey = (sqId: string, date: string) => `${sqId}|${date}`;

export function getDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const cursor = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function dayGroups(days: string[], frequency: TipPoolFrequency): string[][] {
  if (frequency === "biweekly") return [days];
  if (frequency === "daily") return days.map(d => [d]);
  const groups: string[][] = [];
  for (let i = 0; i < days.length; i += 7) groups.push(days.slice(i, i + 7));
  return groups;
}

function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

export function bucketLabels(
  frequency: TipPoolFrequency, startDate: string, endDate: string
): string[] {
  const days = getDays(startDate, endDate);
  if (frequency === "biweekly") return [`${fmtDate(startDate)} – ${fmtDate(endDate)}`];
  if (frequency === "daily") return days.map(fmtDate);
  const labels: string[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    labels.push(`${fmtDate(w[0])} – ${fmtDate(w[w.length - 1])}`);
  }
  return labels;
}

/**
 * Largest-remainder distribution: floor every exact share, then hand the
 * leftover cents to the largest fractional remainders. Guarantees the result
 * sums to `total` exactly — per-cell Math.round drifts, and the pool total is
 * an asserted invariant. Ties break on key so output is stable across runs.
 */
export function distributeByWeight(
  total: number,
  weights: Array<{ key: string; weight: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of weights) out.set(w.key, 0);

  const positive = weights.filter(w => w.weight > 0);
  const sumW = positive.reduce((s, w) => s + w.weight, 0);
  if (sumW <= 0 || total <= 0) return out;

  const exact = positive.map(w => ({ key: w.key, v: (total * w.weight) / sumW }));
  let assigned = 0;
  for (const e of exact) {
    const floored = Math.floor(e.v);
    out.set(e.key, floored);
    assigned += floored;
  }

  const byRemainder = exact
    .map(e => ({ key: e.key, rem: e.v - Math.floor(e.v) }))
    .sort((a, b) => b.rem - a.rem || (a.key < b.key ? -1 : 1));

  let leftover = total - assigned;
  let i = 0;
  while (leftover > 0 && byRemainder.length > 0) {
    const k = byRemainder[i % byRemainder.length].key;
    out.set(k, (out.get(k) ?? 0) + 1);
    leftover--;
    i++;
  }
  return out;
}

/**
 * Single-step day-level split of one tip-pool bucket.
 *   tips[cell] = pin[cell]                            if pinned
 *              = (P - Σpins) x hours / Σ unpinned hours  otherwise
 *
 * Never throws: a pool can shrink below stored pins when a refund syncs late
 * (PR #276 attributes a refund to its original payment's day), so an already
 * stored, previously valid pin set can become invalid with no user action.
 * Read path degrades — unpinned cells clamp to 0, never negative — and the
 * caller surfaces the variance. The write path rejects via bucketViolations.
 */
export function attributeBucket(
  poolCents: number,
  cells: CellHours[],
  pins: CellPin[],
): BucketAttribution {
  const tips = new Map<string, number>();
  const pinKeys = new Set(pins.map(p => cellKey(p.employeeId, p.date)));

  let pinnedCents = 0;
  for (const p of pins) {
    tips.set(cellKey(p.employeeId, p.date), p.cents);
    pinnedCents += p.cents;
  }

  const unpinned = cells.filter(
    c => c.hours > 0 && !pinKeys.has(cellKey(c.employeeId, c.date))
  );
  for (const c of unpinned) tips.set(cellKey(c.employeeId, c.date), 0);

  const remainder = poolCents - pinnedCents;
  if (remainder > 0 && unpinned.length > 0) {
    const dist = distributeByWeight(
      remainder,
      unpinned.map(c => ({ key: cellKey(c.employeeId, c.date), weight: c.hours })),
    );
    for (const [k, v] of dist) tips.set(k, v);
  }

  let attributedCents = 0;
  for (const v of tips.values()) attributedCents += v;
  return { tips, attributedCents, pinnedCents };
}

/** Write-path guard. Conditions a save must never create; see spec §1. */
export function bucketViolations(buckets: TipBucket[]): BucketViolation[] {
  const out: BucketViolation[] = [];
  for (const b of buckets) {
    if (b.pinned_cents > b.pool_cents) {
      out.push({ label: b.label, kind: "pins_exceed_pool", poolCents: b.pool_cents, pinnedCents: b.pinned_cents });
    } else if (b.pinned_cents > 0 && b.attributed_cents < b.pool_cents) {
      out.push({ label: b.label, kind: "no_absorber", poolCents: b.pool_cents, pinnedCents: b.pinned_cents });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/payroll/dailyGrid.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/payroll/dailyGrid.ts lib/payroll/dailyGrid.test.ts
git commit -m "feat(payroll): pool-balanced day-level tip attribution core"
```

---

### Task 3: buildDailyGrid + previewService refactor

**Model:** Opus (this is where "did the extraction preserve behavior" is decided)

**Files:**
- Modify: `lib/payroll/dailyGrid.ts` (add `buildDailyGrid`)
- Modify: `lib/payroll/dailyGrid.test.ts` (add orchestration cases)
- Modify: `lib/payroll/previewService.ts:1-145` (delete duplicated logic, consume the module)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `buildDailyGrid(period, employees, tipPoolFrequency, overrides): Promise<DailyGrid>` where

```ts
export interface DailyGrid {
  days: string[];
  /** date -> square_team_member_id -> value */
  hoursByDate: Map<string, Map<string, number>>;
  cashByDate: Map<string, Map<string, number>>;
  cardTipsByDate: Map<string, Map<string, number>>;
  buckets: TipBucket[];
  totalPooledTipsCents: number;
}
```

**The equivalence gate:** `lib/payroll/__tests__/previewService.test.ts` must pass **unmodified** at the end of this task. Do not edit it. If it fails, the refactor changed behavior and the refactor is wrong.

- [ ] **Step 1: Write the failing orchestration tests**

Append to `lib/payroll/dailyGrid.test.ts`. Mock only the Square boundary, mirroring the convention in `previewService.test.ts:24-30`:

```ts
import { vi } from "vitest";
import type { DailyShift } from "@/lib/square/labor";
import type { DailyTips } from "@/lib/square/payroll";
import type { Employee, PayPeriod } from "./types";

const mockShifts = vi.fn<(s: string, e: string) => Promise<DailyShift[]>>();
const mockTips   = vi.fn<(s: string, e: string) => Promise<DailyTips[]>>();
vi.mock("@/lib/square/labor",   () => ({ fetchShiftsByDay: (s: string, e: string) => mockShifts(s, e) }));
vi.mock("@/lib/square/payroll", () => ({ fetchTipsAndCashTakeByDay: (s: string, e: string) => mockTips(s, e) }));

const { buildDailyGrid } = await import("./dailyGrid");

const PERIOD = { id: "p1", start_date: "2026-07-01", end_date: "2026-07-02" } as PayPeriod;
const EMPS = [
  { id: "e1", square_team_member_id: "s1", receives_tips: true,  employment_type: "hourly", active: true },
  { id: "e2", square_team_member_id: "s2", receives_tips: true,  employment_type: "hourly", active: true },
] as Employee[];
const noOv = { adj_hours: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, note: null };

describe("buildDailyGrid", () => {
  beforeEach(() => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 1000 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 500 },
    ]);
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 8000 }]);
  });

  it("splits the pool by hours with no overrides", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", []);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.buckets.find(b => b.days.includes("2026-07-01"))!.attributed_cents).toBe(8000);
  });

  it("rebalances card tips when hours are overridden", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e2", work_date: "2026-07-01", adj_hours: 6 },
    ]);
    expect(g.hoursByDate.get("2026-07-01")!.get("s2")).toBe(6);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(4000);
  });

  it("creates a cell for a day with no Square shift (missed punch)", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-02", adj_hours: 8 },
    ]);
    expect(g.hoursByDate.get("2026-07-02")!.get("s1")).toBe(8);
  });

  it("replaces declared cash tips without touching hours or card tips", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_cash_tips_cents: 4200 },
    ]);
    expect(g.cashByDate.get("2026-07-01")!.get("s1")).toBe(4200);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
  });

  it("does not throw when a shrunken pool leaves stored pins over-committed", async () => {
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 1000 }]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_paycheck_tips_cents: 5000 },
    ]);
    const b = g.buckets.find(x => x.days.includes("2026-07-01"))!;
    expect(b.attributed_cents - b.pool_cents).toBeGreaterThan(0);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(0);
  });

  it("pools across the whole period when biweekly", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-02", hours: 2, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 4000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "biweekly", []);
    expect(g.buckets).toHaveLength(1);
    // One 8000c pool split 6:2 across days — not two independent 4000c pools.
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(2000);
  });

  it("keeps each day independent when daily", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-02", hours: 2, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 4000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", []);
    expect(g.buckets).toHaveLength(2);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(4000);
  });

  it("confines a pin's rebalance to its own bucket when daily", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 0 },
      { team_member_id: "s1", date: "2026-07-02", hours: 4, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 8000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_paycheck_tips_cents: 7000 },
    ]);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(1000);  // rebalanced
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s1")).toBe(4000);  // untouched
  });

  it("ignores overrides for an employee with no square_team_member_id", async () => {
    const emps = [...EMPS, { id: "e3", square_team_member_id: null, receives_tips: true, employment_type: "hourly", active: true } as unknown as Employee];
    const g = await buildDailyGrid(PERIOD, emps, "daily", [
      { ...noOv, employee_id: "e3", work_date: "2026-07-01", adj_hours: 5 },
    ]);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/payroll/dailyGrid.test.ts`
Expected: FAIL — `buildDailyGrid is not a function`.

- [ ] **Step 3: Implement buildDailyGrid**

Append to `lib/payroll/dailyGrid.ts`. **Merge the type import into the existing
`import type { TipPoolFrequency } from "./types";`** from Task 2 rather than adding a second
import from the same module — the lint rule flags duplicates.

```ts
import { fetchShiftsByDay } from "@/lib/square/labor";
import { fetchTipsAndCashTakeByDay } from "@/lib/square/payroll";
// merged: import type { Employee, PayPeriod, TipPoolFrequency } from "./types";

export interface DailyGrid {
  days: string[];
  hoursByDate: Map<string, Map<string, number>>;
  cashByDate: Map<string, Map<string, number>>;
  cardTipsByDate: Map<string, Map<string, number>>;
  buckets: TipBucket[];
  totalPooledTipsCents: number;
}

function setCell(m: Map<string, Map<string, number>>, date: string, sqId: string, v: number) {
  if (!m.has(date)) m.set(date, new Map());
  m.get(date)!.set(sqId, v);
}
function addCell(m: Map<string, Map<string, number>>, date: string, sqId: string, v: number) {
  if (!m.has(date)) m.set(date, new Map());
  const inner = m.get(date)!;
  inner.set(sqId, (inner.get(sqId) ?? 0) + v);
}

/**
 * Single owner of day-level payroll computation. Both the Shifts route and
 * previewService consume this; they used to duplicate it and had drifted.
 * Maps key on square_team_member_id (spec §2 "ID space"); override rows are
 * translated employee-id -> square-id once here.
 */
export async function buildDailyGrid(
  period: PayPeriod,
  employees: Employee[],
  tipPoolFrequency: TipPoolFrequency,
  overrides: DayOverride[],
): Promise<DailyGrid> {
  const days = getDays(period.start_date, period.end_date);

  const sqByEmployeeId = new Map(
    employees.filter(e => e.square_team_member_id).map(e => [e.id, e.square_team_member_id!])
  );
  const tippedSqIds = new Set(
    employees.filter(e => e.receives_tips && e.square_team_member_id).map(e => e.square_team_member_id!)
  );

  const [rawShifts, dailyTips] = await Promise.all([
    fetchShiftsByDay(period.start_date, period.end_date),
    fetchTipsAndCashTakeByDay(period.start_date, period.end_date),
  ]);

  const hoursByDate = new Map<string, Map<string, number>>();
  const cashByDate  = new Map<string, Map<string, number>>();
  for (const s of rawShifts) {
    addCell(hoursByDate, s.date, s.team_member_id, s.hours);
    addCell(cashByDate,  s.date, s.team_member_id, s.cash_tips_cents);
  }

  // Layer 1: day overrides replace the Square-derived value outright. An
  // override may create a cell that has no underlying shift (missed punch).
  const pinsByDate = new Map<string, Map<string, number>>();
  for (const o of overrides) {
    const sqId = sqByEmployeeId.get(o.employee_id);
    if (!sqId) continue;
    if (o.adj_hours != null) setCell(hoursByDate, o.work_date, sqId, o.adj_hours);
    if (o.adj_cash_tips_cents != null) setCell(cashByDate, o.work_date, sqId, o.adj_cash_tips_cents);
    if (o.adj_paycheck_tips_cents != null) setCell(pinsByDate, o.work_date, sqId, o.adj_paycheck_tips_cents);
  }

  const poolByDay = new Map(dailyTips.map(t => [t.date, t.tipsPooledCents]));
  const groups = dayGroups(days, tipPoolFrequency);
  const labels = bucketLabels(tipPoolFrequency, period.start_date, period.end_date);

  const cardTipsByDate = new Map<string, Map<string, number>>();
  const buckets: TipBucket[] = [];
  let totalPooledTipsCents = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let poolCents = 0;
    const cells: CellHours[] = [];
    const pins: CellPin[] = [];

    for (const day of group) {
      poolCents += poolByDay.get(day) ?? 0;
      for (const [sqId, hours] of hoursByDate.get(day) ?? []) {
        if (tippedSqIds.has(sqId)) cells.push({ employeeId: sqId, date: day, hours });
      }
      for (const [sqId, cents] of pinsByDate.get(day) ?? []) {
        if (tippedSqIds.has(sqId)) pins.push({ employeeId: sqId, date: day, cents });
      }
    }
    totalPooledTipsCents += poolCents;

    const { tips, attributedCents, pinnedCents } = attributeBucket(poolCents, cells, pins);
    for (const [key, cents] of tips) {
      const [sqId, day] = key.split("|");
      setCell(cardTipsByDate, day, sqId, cents);
    }

    buckets.push({
      label: labels[gi] ?? `Bucket ${gi + 1}`,
      days: group,
      pool_cents: poolCents,
      pinned_cents: pinnedCents,
      attributed_cents: attributedCents,
    });
  }

  return { days, hoursByDate, cashByDate, cardTipsByDate, buckets, totalPooledTipsCents };
}
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run lib/payroll/dailyGrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor previewService to consume the module**

In `lib/payroll/previewService.ts`: delete the module-private `getDays`, `dayGroups`, `fmtDate`, `bucketLabels` (lines 9-43) and the whole body of `buildGuaranteeBuckets` (lines 52-145). Import from `./dailyGrid` instead. `buildPayrollPreview` (lines 147-194) keeps its signature and body except for the `buildGuaranteeBuckets` call.

```ts
import { buildDailyGrid, dayGroups } from "./dailyGrid";
import type { DayOverride } from "./dailyGrid";

async function buildGuaranteeBuckets(
  period: PayPeriod,
  employees: Employee[],
  config: PayrollConfig,
  overrides: DayOverride[],
): Promise<{ buckets: GuaranteeBucket[]; tip_buckets: TipBucketSummary[]; totalPooledTipsCents: number }> {
  const grid = await buildDailyGrid(
    period, employees, config.tip_pool_frequency ?? "biweekly", overrides
  );

  // Guarantee bucketing is independent of tip-pool bucketing: re-aggregate the
  // day-level maps at guaranteed_min_frequency. Keys stay square_team_member_id,
  // which is what GuaranteeBucket and computePayrollEntries already expect.
  const buckets: GuaranteeBucket[] = dayGroups(
    grid.days, config.guaranteed_min_frequency ?? "biweekly"
  ).map(group => {
    const shifts = new Map<string, number>();
    const paycheckTipsCents = new Map<string, number>();
    const cashTipsCents = new Map<string, number>();
    for (const day of group) {
      for (const [sqId, h] of grid.hoursByDate.get(day) ?? []) {
        shifts.set(sqId, (shifts.get(sqId) ?? 0) + h);
      }
      for (const [sqId, t] of grid.cardTipsByDate.get(day) ?? []) {
        paycheckTipsCents.set(sqId, (paycheckTipsCents.get(sqId) ?? 0) + t);
      }
      for (const [sqId, c] of grid.cashByDate.get(day) ?? []) {
        cashTipsCents.set(sqId, (cashTipsCents.get(sqId) ?? 0) + c);
      }
    }
    return { shifts, paycheckTipsCents, cashTipsCents };
  });

  return {
    buckets,
    tip_buckets: grid.buckets.map(b => ({ label: b.label, tipsPooledCents: b.pool_cents })),
    totalPooledTipsCents: grid.totalPooledTipsCents,
  };
}
```

`buildPayrollPreview` must now filter the buckets to tipped employees the same way the old code did. The old `buildGuaranteeBuckets` received `tippedTeamIds` and skipped non-tipped members when summing `shifts` and `cashTipsCents`. `buildDailyGrid` already restricts card tips to tipped members, but `hoursByDate`/`cashByDate` contain every member. `computePayrollEntries` only ever looks up `emp.square_team_member_id` for employees that pass its own `receives_tips` filter, so untipped entries in those maps are never read — behavior is preserved. **Confirm this by running the frozen test, not by reasoning alone.**

Update the call site in `buildPayrollPreview` (was line 164-165):

```ts
  const { buckets, tip_buckets, totalPooledTipsCents } =
    await buildGuaranteeBuckets(period, allEmployees, config, overrides);
```

Add `overrides: DayOverride[] = []` as a trailing parameter on `buildPayrollPreview` so callers that do not yet pass overrides (the lock route) keep compiling.

- [ ] **Step 6: Run the equivalence gate**

Run: `npx vitest run lib/payroll lib/square`
Expected: PASS — 20 files, 198+ tests. `previewService.test.ts` and `calculations.test.ts` must be **unmodified**. Confirm with:

```bash
git diff --stat lib/payroll/__tests__/previewService.test.ts lib/payroll/__tests__/calculations.test.ts
```

Expected: empty output. Non-empty means the equivalence claim is void — revert those files and fix the implementation.

- [ ] **Step 7: Wire overrides into the preview route**

`app/api/payroll/periods/[id]/preview/route.ts` and `app/api/payroll/periods/[id]/lock/route.ts` both call `buildPayrollPreview`. Add the override fetch to both so day overrides reach Summary and the locked snapshot:

```ts
const { data: dayOverrides } = await supabase
  .from("payroll_shift_overrides")
  .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
  .eq("pay_period_id", id);
```

and pass `(dayOverrides ?? []) as DayOverride[]` as the new trailing argument.

- [ ] **Step 8: Verify and commit**

Run: `npm run verify`
Expected: PASS.

```bash
git add lib/payroll/dailyGrid.ts lib/payroll/dailyGrid.test.ts lib/payroll/previewService.ts app/api/payroll/periods/
git commit -m "refactor(payroll): single owner for day-level computation, day overrides feed totals"
```

---

### Task 4: Shifts GET route

**Model:** Sonnet

**Files:**
- Modify: `app/api/payroll/periods/[id]/shifts/route.ts` (whole file — replaces lines 15-181)

**Interfaces:**
- Consumes: `buildDailyGrid`, `DayOverride`, `TipBucket` from Task 3.
- Produces: the JSON contract Task 6 renders.

- [ ] **Step 1: Rewrite the route**

Two changes beyond thinning: the permission gate drops to `payrollRead` (it is `payrollManage` today, which is admin-only — managers currently get a 403 on a tab the page grants them at `payrollRead`), and the response gains override + baseline + variance data. Delete lines 63-174 entirely; that logic now lives in `dailyGrid.ts`.

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildDailyGrid, type DayOverride } from "@/lib/payroll/dailyGrid";
import type { Employee, PayPeriod, TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // payrollRead, not payrollManage: the Taproom payroll page gates at
  // payrollRead, so an admin-only gate here 403s managers on a visible tab.
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const [{ data: period, error: pErr }, { data: employees }, { data: config }] = await Promise.all([
    supabase.from("pay_periods").select("start_date, end_date").eq("id", id).single(),
    supabase.from("employees")
      .select("id, first_name, last_name, square_team_member_id, receives_tips, employment_type, active")
      .not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency")
      .order("effective_from", { ascending: false }).limit(1).single(),
  ]);

  if (pErr || !period) return apiError("Period not found", 404);

  const { data: overrideRows } = await supabase
    .from("payroll_shift_overrides")
    .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
    .eq("pay_period_id", id);

  const overrides = (overrideRows ?? []) as DayOverride[];
  const emps = (employees ?? []) as Employee[];
  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency
    ?? "biweekly") as TipPoolFrequency;

  let grid, baseline;
  try {
    // Two passes over already-fetched data: `baseline` (no overrides) gives the
    // struck-through original. Card tips rebalance, so a cell's "original" is
    // only meaningful as what it would have been with no pins in the bucket.
    [grid, baseline] = await Promise.all([
      buildDailyGrid(period as PayPeriod, emps, frequency, overrides),
      buildDailyGrid(period as PayPeriod, emps, frequency, []),
    ]);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  const empBySq = new Map(emps.map(e => [e.square_team_member_id!, e]));
  const ovByEmpDate = new Map(overrides.map(o => [`${o.employee_id}|${o.work_date}`, o]));

  // Every square id that has any hours, cash, or card tips in either pass.
  const sqIds = new Set<string>();
  for (const m of [grid.hoursByDate, grid.cashByDate, grid.cardTipsByDate]) {
    for (const inner of m.values()) for (const sq of inner.keys()) sqIds.add(sq);
  }
  // Override mode must be able to fix someone with no shifts at all.
  for (const e of emps) {
    if (e.active && e.employment_type === "hourly" && e.receives_tips) sqIds.add(e.square_team_member_id!);
  }

  const pick = (m: Map<string, Map<string, number>>, sq: string) => {
    const out: Record<string, number> = {};
    for (const day of grid.days) {
      const v = m.get(day)?.get(sq);
      if (v != null) out[day] = v;
    }
    return out;
  };
  const total = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);

  const rows = [...sqIds].map(sq => {
    const emp = empBySq.get(sq);
    const isTipped = !!emp?.receives_tips;
    const daily_hours = pick(grid.hoursByDate, sq);
    const overridesForRow: Record<string, {
      adj_hours: number | null;
      adj_paycheck_tips_cents: number | null;
      adj_cash_tips_cents: number | null;
      note: string | null;
    }> = {};
    if (emp) {
      for (const day of grid.days) {
        const o = ovByEmpDate.get(`${emp.id}|${day}`);
        if (o) overridesForRow[day] = {
          adj_hours: o.adj_hours,
          adj_paycheck_tips_cents: o.adj_paycheck_tips_cents,
          adj_cash_tips_cents: o.adj_cash_tips_cents,
          note: o.note,
        };
      }
    }
    return {
      employee_id: emp?.id ?? sq,
      name: emp ? `${emp.first_name} ${emp.last_name}` : sq,
      overridable: !!emp,
      daily_hours,
      total_hours: total(daily_hours),
      daily_tips_cents: isTipped ? pick(grid.cardTipsByDate, sq) : null,
      total_tips_cents: isTipped ? total(pick(grid.cardTipsByDate, sq)) : null,
      daily_cash_tips_cents: isTipped ? pick(grid.cashByDate, sq) : null,
      total_cash_tips_cents: isTipped ? total(pick(grid.cashByDate, sq)) : null,
      overrides: overridesForRow,
      source_hours: pick(baseline.hoursByDate, sq),
      source_tips_cents: isTipped ? pick(baseline.cardTipsByDate, sq) : null,
      source_cash_tips_cents: isTipped ? pick(baseline.cashByDate, sq) : null,
    };
  }).sort((a, b) => b.total_hours - a.total_hours);

  return NextResponse.json({
    days: grid.days,
    tip_pool_frequency: frequency,
    tip_buckets: grid.buckets,
    pool_variance: grid.buckets
      .filter(b => b.attributed_cents !== b.pool_cents)
      .map(b => ({ label: b.label, pool_cents: b.pool_cents, attributed_cents: b.attributed_cents })),
    rows,
  });
}
```

- [ ] **Step 2: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/payroll/periods/
git commit -m "feat(payroll): shifts route serves overrides + variance; fix manager 403"
```

---

### Task 5: Override write route

**Model:** Sonnet

**Files:**
- Create: `app/api/payroll/periods/[id]/shift-overrides/[employeeId]/route.ts`

**Interfaces:**
- Consumes: `buildDailyGrid`, `bucketViolations`, `DayOverride` from Tasks 2-3.
- Produces: `PUT` endpoint Task 6 calls.

- [ ] **Step 1: Implement the route**

Full-replace semantics: rows absent from `cells`, and cells whose three `adj_*` are all null, are deleted. Validation order is period-open → date range → non-negative → pool guards, and the pool guard runs the *real* computation with the proposed set so stored state is always valid.

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildDailyGrid, bucketViolations, type DayOverride } from "@/lib/payroll/dailyGrid";
import type { Employee, PayPeriod, TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

interface CellInput {
  work_date: string;
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note?: string | null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  try { await requirePermission(CAP.payrollDayOverride); } catch (res) { return res as Response; }

  const session = await getSessionUser();
  const supabase = await createSupabaseServerClient();
  const { id, employeeId } = await params;

  const { data: period, error: pErr } = await supabase
    .from("pay_periods").select("id, start_date, end_date, status").eq("id", id).single();
  if (pErr || !period) return apiError("Period not found", 404);
  if (period.status !== "open") {
    return NextResponse.json({ error: "Period is locked" }, { status: 409 });
  }

  const body = await req.json().catch(() => null) as { cells?: CellInput[] } | null;
  if (!body || !Array.isArray(body.cells)) return apiError("Expected { cells: [] }", 400);

  for (const c of body.cells) {
    if (c.work_date < period.start_date || c.work_date > period.end_date) {
      return apiError(`${c.work_date} is outside this pay period`, 400);
    }
    for (const v of [c.adj_hours, c.adj_paycheck_tips_cents, c.adj_cash_tips_cents]) {
      if (v != null && (!Number.isFinite(v) || v < 0)) {
        return apiError("Override values must be zero or greater", 400);
      }
    }
  }

  const kept = body.cells.filter(
    c => c.adj_hours != null || c.adj_paycheck_tips_cents != null || c.adj_cash_tips_cents != null
  );

  // Validate by running the real computation with the proposed override set,
  // so a write can never persist a state the read path would have to degrade.
  const [{ data: employees }, { data: config }, { data: otherRows }] = await Promise.all([
    supabase.from("employees")
      .select("id, first_name, last_name, square_team_member_id, receives_tips, employment_type, active")
      .not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency")
      .order("effective_from", { ascending: false }).limit(1).single(),
    supabase.from("payroll_shift_overrides")
      .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
      .eq("pay_period_id", id).neq("employee_id", employeeId),
  ]);

  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency
    ?? "biweekly") as TipPoolFrequency;

  const proposed: DayOverride[] = [
    ...((otherRows ?? []) as DayOverride[]),
    ...kept.map(c => ({
      employee_id: employeeId,
      work_date: c.work_date,
      adj_hours: c.adj_hours,
      adj_paycheck_tips_cents: c.adj_paycheck_tips_cents,
      adj_cash_tips_cents: c.adj_cash_tips_cents,
      note: c.note ?? null,
    })),
  ];

  let grid;
  try {
    grid = await buildDailyGrid(period as PayPeriod, (employees ?? []) as Employee[], frequency, proposed);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  const violations = bucketViolations(grid.buckets);
  if (violations.length > 0) {
    const v = violations[0];
    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
    const message = v.kind === "pins_exceed_pool"
      ? `Pinned card tips for ${v.label} total ${usd(v.pinnedCents)}, which exceeds the ${usd(v.poolCents)} pool.`
      : `No unpinned cell can absorb the remainder for ${v.label}; pins must total exactly ${usd(v.poolCents)}.`;
    return NextResponse.json({ error: message, violations }, { status: 422 });
  }

  const { error: dErr } = await supabase
    .from("payroll_shift_overrides").delete()
    .eq("pay_period_id", id).eq("employee_id", employeeId);
  if (dErr) return apiError(dErr.message);

  if (kept.length > 0) {
    const { error: uErr } = await supabase.from("payroll_shift_overrides").insert(
      kept.map(c => ({
        pay_period_id: id,
        employee_id: employeeId,
        work_date: c.work_date,
        adj_hours: c.adj_hours,
        adj_paycheck_tips_cents: c.adj_paycheck_tips_cents,
        adj_cash_tips_cents: c.adj_cash_tips_cents,
        note: c.note ?? null,
        created_by: session!.user.id,
        updated_by: session!.user.id,
      }))
    );
    if (uErr) return apiError(uErr.message);
  }

  return NextResponse.json({ ok: true, saved: kept.length });
}
```

- [ ] **Step 2: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/payroll/periods/
git commit -m "feat(payroll): PUT shift-overrides with pool-balance guards"
```

---

### Task 6: Shifts grid override mode

**Model:** Sonnet

**Files:**
- Modify: `app/components/payroll/ShiftTimeline.tsx` (whole component)
- Modify: `app/components/payroll/PayrollPeriodView.tsx:97-122`
- Modify: `lib/query-keys.ts:110-118` (only if a new key is needed; `payroll.shifts(id)` already exists)

**Interfaces:**
- Consumes: the `GET .../shifts` contract from Task 4 and the `PUT` from Task 5.
- Produces: nothing downstream.

Read `docs/UI_STANDARD.md` before starting.

- [ ] **Step 1: Surface Override Mode on the Shifts tab**

In `PayrollPeriodView.tsx` the button is currently gated on `editable && isOpen` and `activeTab === "summary"` (lines 97-106), and Taproom passes `editable={false}` — so it never appears there. Decouple: Summary keeps the `editable` gate, Shifts uses the capability.

```tsx
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities"; // NOT "@/lib/auth" — barrel pulls server-only code
```

```tsx
  const { can } = usePermissions();
  const canDayOverride = can(CAP.payrollDayOverride);
```

Replace the header action block (lines 97-111) with:

```tsx
      {isOpen && (
        <div className="flex items-center gap-2">
          {((activeTab === "summary" && editable) || (activeTab === "shifts" && canDayOverride)) && (
            <button
              onClick={() => setOverrideMode(v => !v)}
              className={overrideMode ? "btn-primary" : "btn-secondary"}
            >
              {overrideMode ? "Exit Override" : "Override Mode"}
            </button>
          )}
          {editable && (
            <button onClick={() => setShowLockConfirm(true)} className="btn-primary">
              Lock Period
            </button>
          )}
        </div>
      )}
```

The tab `onSelect` currently clears override mode for any non-summary tab (line 120). Change it to clear only when leaving both editable tabs:

```tsx
        onSelect={(tab) => {
          setActiveTab(tab);
          if (tab !== "summary" && tab !== "shifts") setOverrideMode(false);
        }}
```

Pass it down: `<ShiftTimeline periodId={periodId} overrideMode={overrideMode && canDayOverride} />`.

- [ ] **Step 2: Extend the ShiftTimeline data types**

Add to the `ShiftRow` interface and `ShiftData` in `ShiftTimeline.tsx:9-24`:

```ts
interface DayOverrideCell {
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}

interface ShiftRow {
  employee_id: string;
  name: string;
  overridable: boolean;
  daily_hours: Record<string, number>;
  total_hours: number;
  daily_tips_cents: Record<string, number> | null;
  total_tips_cents: number | null;
  daily_cash_tips_cents: Record<string, number> | null;
  total_cash_tips_cents: number | null;
  overrides: Record<string, DayOverrideCell>;
  source_hours: Record<string, number>;
  source_tips_cents: Record<string, number> | null;
  source_cash_tips_cents: Record<string, number> | null;
}

interface TipBucket {
  label: string; days: string[];
  pool_cents: number; pinned_cents: number; attributed_cents: number;
}

interface ShiftData {
  days: string[];
  tip_pool_frequency: TipPoolFrequency;
  tip_buckets: TipBucket[];
  pool_variance: Array<{ label: string; pool_cents: number; attributed_cents: number }>;
  rows: ShiftRow[];
}
```

- [ ] **Step 3: Add per-field click-to-edit inside the day card**

Option B from the design mockup: the cell stays read-only text until a line is clicked; that line becomes an input and the other two stay text. Edits accumulate in component state keyed by `${employee_id}|${date}|${field}` and commit on the row's Save.

Add these imports to `ShiftTimeline.tsx` (it currently imports only `Fragment`, `useQuery`,
`queryKeys`, `TipPoolFrequency`, `fmtCents`):

```tsx
import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Banner from "@/app/components/ui/Banner";
```

State, declared inside `ShiftTimeline`:

```tsx
type Field = "hours" | "card" | "cash";
const editKey = (emp: string, date: string, f: Field) => `${emp}|${date}|${f}`;

const qc = useQueryClient();
const [edits, setEdits] = useState<Record<string, string>>({});
const [focused, setFocused] = useState<string | null>(null);
const [notes, setNotes] = useState<Record<string, string>>({});
const [savingRow, setSavingRow] = useState<string | null>(null);
const [saveError, setSaveError] = useState<string | null>(null);
```

`useState` must be called before the early `isLoading` / `error` returns at lines 58-62 —
hooks cannot run conditionally.

Render one line of a card. `overridden` drives the accent + strikethrough treatment, matching the `ValueCell` idiom in `PayrollEntryRow.tsx:54-61`. Token utilities only — no raw colors on the override affordances.

```tsx
function CardLine({
  value, source, overridden, editable, editing, draft,
  onFocus, onChange, className,
}: {
  value: string; source: string; overridden: boolean;
  editable: boolean; editing: boolean; draft: string;
  onFocus: () => void; onChange: (v: string) => void; className: string;
}) {
  if (editable && editing) {
    return (
      <input
        autoFocus
        type="number"
        min="0"
        step="0.01"
        value={draft}
        onChange={e => onChange(e.target.value)}
        className="inp-sm w-full text-right font-mono text-xs px-1 py-0"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={onFocus}
      className={`text-left leading-none font-mono text-xs ${
        overridden ? "text-accent" : className
      } ${editable ? "cursor-text" : "cursor-default"}`}
    >
      {value}
      {overridden && <span className="ml-1 text-faint line-through">{source}</span>}
    </button>
  );
}
```

Empty cells must be clickable in override mode — a missed punch is the likeliest reason to override. Replace the `h > 0 ? … : <div …/>` branch (lines 125-143) with a single card that renders whenever there are hours **or** the cell is editable, so a zero-hour day is no longer an inert div:

```tsx
const ov = row.overrides[d];
const canEdit = overrideMode && row.overridable;
const show = h > 0 || canEdit;
return (
  <td key={d} className="px-1 py-1 align-top">
    {show ? (
      <div className={`w-20 ${cardH} rounded-lg px-3 py-2 flex flex-col justify-center gap-0.5 ${
        h > 0 ? hourCellStyle(h) : "border border-line-strong"
      }`}>
        <CardLine
          value={`${h.toFixed(1)}h`}
          source={`${(row.source_hours[d] ?? 0).toFixed(1)}h`}
          overridden={ov?.adj_hours != null}
          editable={canEdit}
          editing={focused === editKey(row.employee_id, d, "hours")}
          draft={edits[editKey(row.employee_id, d, "hours")] ?? String(h)}
          onFocus={() => setFocused(editKey(row.employee_id, d, "hours"))}
          onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "hours")]: v }))}
          className="text-sm font-semibold"
        />
        {isTipped && (
          <CardLine
            value={t && t > 0 ? fmtCents(t) : "—"}
            source={fmtCents(row.source_tips_cents?.[d] ?? 0)}
            overridden={ov?.adj_paycheck_tips_cents != null}
            editable={canEdit}
            editing={focused === editKey(row.employee_id, d, "card")}
            draft={edits[editKey(row.employee_id, d, "card")] ?? String((t ?? 0) / 100)}
            onFocus={() => setFocused(editKey(row.employee_id, d, "card"))}
            onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "card")]: v }))}
            className="text-emerald-400"
          />
        )}
        {hasCash && (
          <CardLine
            value={ct && ct > 0 ? fmtCents(ct) : "—"}
            source={fmtCents(row.source_cash_tips_cents?.[d] ?? 0)}
            overridden={ov?.adj_cash_tips_cents != null}
            editable={canEdit}
            editing={focused === editKey(row.employee_id, d, "cash")}
            draft={edits[editKey(row.employee_id, d, "cash")] ?? String((ct ?? 0) / 100)}
            onFocus={() => setFocused(editKey(row.employee_id, d, "cash"))}
            onChange={v => setEdits(e => ({ ...e, [editKey(row.employee_id, d, "cash")]: v }))}
            className="text-amber-300"
          />
        )}
      </div>
    ) : (
      <div className={`w-20 ${cardH} rounded-lg bg-surface/30`} />
    )}
  </td>
);
```

The `text-emerald-400` / `text-amber-300` / `hourCellStyle` classes are the existing sanctioned data ramp — carried over unchanged, not new raw colors. The override treatment itself uses `text-accent` inside `CardLine`.

- [ ] **Step 4: Add the per-row Save**

One request per row commits every edited cell for that employee.

```tsx
async function saveRow(row: ShiftRow) {
  setSavingRow(row.employee_id);
  const byDate = new Map<string, DayOverrideCell>();
  for (const day of days) {
    const existing = row.overrides[day];
    const g = (f: Field) => {
      const k = editKey(row.employee_id, day, f);
      return k in edits ? (edits[k] === "" ? null : Number(edits[k])) : undefined;
    };
    const h = g("hours"), card = g("card"), cash = g("cash");
    if (h === undefined && card === undefined && cash === undefined && !existing) continue;
    byDate.set(day, {
      adj_hours: h === undefined ? existing?.adj_hours ?? null : h,
      adj_paycheck_tips_cents: card === undefined
        ? existing?.adj_paycheck_tips_cents ?? null
        : card === null ? null : Math.round(card * 100),
      adj_cash_tips_cents: cash === undefined
        ? existing?.adj_cash_tips_cents ?? null
        : cash === null ? null : Math.round(cash * 100),
      note: notes[row.employee_id] ?? existing?.note ?? null,
    });
  }

  const res = await fetch(`/api/payroll/periods/${periodId}/shift-overrides/${row.employee_id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cells: [...byDate].map(([work_date, c]) => ({ work_date, ...c })) }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Save failed" }));
    setSaveError(error);
    setSavingRow(null);
    return;
  }
  setSaveError(null);
  await Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.payroll.shifts(periodId) }),
    qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) }),
  ]);
  setEdits({});
  setSavingRow(null);
}
```

Both invalidations are required — the Shifts grid and the Summary tab are separate queries, and an override now moves both. A 422 pool violation surfaces through `saveError`.

Append a trailing actions column to each row, rendered only in override mode. Per spec §7 the
note is **one input per row**, written to every cell saved in that request — per-cell notes
are not in v1. This mirrors the Notes + Save pairing in `PayrollEntryRow.tsx:194-213`.

```tsx
{overrideMode && row.overridable && (
  <td className="pl-4 py-1 align-middle">
    <div className="flex gap-2 items-center">
      <input
        type="text"
        value={notes[row.employee_id] ?? ""}
        onChange={e => setNotes(n => ({ ...n, [row.employee_id]: e.target.value }))}
        placeholder="Notes…"
        className="inp-sm w-32"
      />
      <button
        onClick={() => saveRow(row)}
        disabled={savingRow === row.employee_id}
        className="btn-secondary btn-xxs"
      >
        {savingRow === row.employee_id ? "…" : "Save"}
      </button>
    </div>
  </td>
)}
```

Add a matching `{overrideMode && <th />}` to the header row and `{overrideMode && <td />}` to
the `tfoot` row so the column counts stay aligned.

```tsx
{saveError && <Banner tone="danger">{saveError}</Banner>}
```

- [ ] **Step 5: Add the rebalance-span and variance banners**

Worded from the live config so no frequency is privileged:

```tsx
{overrideMode && (
  <Banner tone="info">
    Card tips rebalance within {data.tip_buckets.length === 1
      ? "the whole period"
      : `each ${FREQ_LABELS[tip_pool_frequency]} pool (${data.tip_buckets[0].label}, …)`}
    . Editing one cell moves the others in that span.
  </Banner>
)}
{data.pool_variance.map(v => (
  <Banner key={v.label} tone={v.attributed_cents > v.pool_cents ? "danger" : "neutral"}>
    {v.attributed_cents > v.pool_cents
      ? `Pinned card tips for ${v.label} exceed the pool by ${fmtCents(v.attributed_cents - v.pool_cents)} — revise them.`
      : `${fmtCents(v.pool_cents - v.attributed_cents)} of the ${v.label} pool is unattributed (no eligible hours).`}
  </Banner>
))}
```

The positive case is reachable with no user action — a refund syncing late shrinks the pool under stored pins — so it must render at blocking severity, not as a quiet note.

- [ ] **Step 6: Verify in the browser**

```bash
npm run dev
```

Then via the preview tools: load `/taproom/payroll`, open the Shifts tab, confirm the grid renders read-only, toggle Override Mode, click an hours line, type a value, Save, and confirm the Summary tab total moves. Check `read_console_messages` for errors.

- [ ] **Step 7: Verify and commit**

Run: `npm run verify`
Expected: PASS.

```bash
git add app/components/payroll/ lib/query-keys.ts
git commit -m "feat(payroll): per-day override mode in the Shifts grid"
```

---

## Post-Implementation

- [ ] Final whole-branch review — **Opus**, once. Per `feedback_final_review_catches_real_bugs`, do not skip under budget pressure.
- [ ] Confirm `git diff main --stat` shows `previewService.test.ts` and `calculations.test.ts` unchanged.
- [ ] Open the PR. Note in the body that migration `20260821_payroll_shift_overrides.sql` is **pending prod apply** and the feature 500s until it is applied.
- [ ] Migration applied to prod by the orchestrator only, after explicit approval and a backup.
- [ ] If PR #276 merges before this branch, rebase onto main and drop the cherry-picked `ea47280` (it will go empty or conflict trivially).
