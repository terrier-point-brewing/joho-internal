# Deterministic Draft Keg Swaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bartender-rung "Draft Restock" line item the sole deterministic source of draft keg swaps — producing the shipment, cold-storage deduction, Square recount, and a deterministic shrinkage record — with all swap config consolidated per-tap in Configure Taps.

**Architecture:** Swap config moves from per-recipe (`taproom_recipe_settings`) to per-tap (`tap_assignments`). The consumption sync resolves each restock line straight off its tap. The fuzzy count-crossing inference is deleted from both the write path (`taproomConsumption.ts`) and the read path (`draft-stats` shrinkage), the latter replaced by a new `draft_swap_shrinkage` table populated at recount time. The Configure Taps UI sources the "keg to drain" dropdown from real cold-storage on-hand (`export-bay/inventory`).

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres, Square REST API (raw fetch), Vitest, Tailwind v4.

## Global Constraints

- No business logic in `app/api/**` or page components — extract to `lib/` (project rule).
- New/modified `lib/` modules ship co-located `*.test.ts`; keep coverage above `vitest.config.ts` threshold; CI runs `npm run test`.
- Schema changes = a NEW migration file in `supabase/migrations/`; never hand-edit existing migrations. Prod application happens only after explicit user OK + backup — this plan does not apply migrations to prod.
- Supabase client per context: `lib/supabase/server` in route handlers, `admin` for privileged upserts (system_settings pattern already in tap-config), never the browser client in a route.
- UI: token utilities only (no raw `zinc/amber/red/green/blue/gray`), primitives from `app/components/ui/` (`.inp`/`.inp-sm`, `.btn-ghost`, `.btn-amber`, `<Badge>`), spacing scale only. Data-category/urgency palettes are the one exception.
- Square API version `2025-04-16`; single location `LZ8TH4A632YW0`.
- Restock swap sourceRef format is exactly `sqtransfer:<orderId>:<lineUid>` (idempotency anchor).

---

## File Structure

- `supabase/migrations/20260705_draft_swap_per_tap.sql` — **create**: tap-grain swap columns + backfill + `draft_swap_shrinkage` table + drop old columns.
- `lib/square/taproomConsumption.ts` — **modify**: remove crossing inference; resolve swap config from tap grain.
- `lib/square/taproomConsumption.test.ts` — **modify**: drop crossing cases; add tap-grain restock cases.
- `lib/production/taproomConsumptionSync.ts` — **modify**: capture deterministic shrinkage at recount.
- `lib/production/taproomConsumptionSync.test.ts` — **modify**: add shrinkage-capture cases; new pure `remainingAtOrBefore` tests.
- `lib/reports/draftShrinkage.ts` — **create**: pure shrinkage aggregation.
- `lib/reports/draftShrinkage.test.ts` — **create**.
- `app/api/taproom/draft-stats/route.ts` — **modify**: read `draft_swap_shrinkage` via `aggregateShrinkage`; drop `detectKegSwaps`.
- `app/api/taproom/tap-config/route.ts` — **modify**: GET + PUT carry `swap_variation_id`, `swap_volume_fl_oz` per tap.
- `app/api/production/taproom-recipe-settings/route.ts` — **modify**: remove swap-config branches (keep retirement).
- `app/taproom/components/DraftStatsTab.tsx` — **modify**: per-tap keg + volume + Auto-map kegs; delete `DraftSwapInventorySection`.
- `lib/square/draftKegEvents.ts` + `lib/square/draftKegEvents.test.ts` — **delete**.

---

## Task 1: Schema migration — tap-grain swap config + shrinkage table

**Files:**
- Create: `supabase/migrations/20260705_draft_swap_per_tap.sql`

**Interfaces:**
- Produces: `tap_assignments.swap_variation_id uuid`, `tap_assignments.swap_volume_fl_oz numeric`; table `draft_swap_shrinkage(source_ref text pk, recipe_id uuid, tap_number int, occurred_at timestamptz, remaining_fl_oz numeric, full_fl_oz numeric, created_at timestamptz)`. Removes `taproom_recipe_settings.swap_variation_id` and `.swap_volume_fl_oz`.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260705_draft_swap_per_tap.sql`:

```sql
-- Draft keg swaps become fully per-tap + deterministic.
--
-- 1. Swap config (which cold-storage keg to drain, and the full-keg recount
--    level) moves from per-recipe (taproom_recipe_settings) to per-tap
--    (tap_assignments), next to restock_variation_id. Same recipe on two taps
--    stores the config twice, intentionally — the tap fully describes its swap.
-- 2. draft_swap_shrinkage records the beer left in a keg at swap time, keyed by
--    the restock line's source_ref so the sync upserts it idempotently. Replaces
--    the old count-crossing inference that drove the Draft Shrinkage chart.

alter table public.tap_assignments
  add column if not exists swap_variation_id uuid
    references public.packaging_variations(id) on delete set null;

alter table public.tap_assignments
  add column if not exists swap_volume_fl_oz numeric;

-- Backfill each tap from the recipe it currently runs.
update public.tap_assignments t
   set swap_variation_id = s.swap_variation_id,
       swap_volume_fl_oz = s.swap_volume_fl_oz
  from public.taproom_recipe_settings s
 where s.recipe_id = t.recipe_id
   and t.recipe_id is not null;

create table if not exists public.draft_swap_shrinkage (
  source_ref      text primary key,
  recipe_id       uuid references public.recipes(id) on delete cascade,
  tap_number      int,
  occurred_at     timestamptz not null,
  remaining_fl_oz numeric not null,
  full_fl_oz      numeric not null,
  created_at      timestamptz not null default now()
);

create index if not exists draft_swap_shrinkage_recipe_idx
  on public.draft_swap_shrinkage (recipe_id);

comment on table public.draft_swap_shrinkage is
  'Deterministic per-swap shrinkage: beer left in a keg when a Draft Restock line was rung. One row per restock source_ref.';

alter table public.taproom_recipe_settings drop column if exists swap_variation_id;
alter table public.taproom_recipe_settings drop column if exists swap_volume_fl_oz;
```

- [ ] **Step 2: Sanity-check no other reader references the dropped columns**

Run: `grep -rn "swap_variation_id\|swap_volume_fl_oz" app lib | grep -v tap_assignments | grep -v draft_swap_shrinkage`
Expected: only hits are in `taproom-recipe-settings/route.ts`, `taproomConsumption.ts`, and `DraftStatsTab.tsx` — all rewritten in later tasks. No other consumers.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260705_draft_swap_per_tap.sql
git commit -m "feat(db): move draft swap config to tap grain + add draft_swap_shrinkage"
```

> Migration application to any live DB (branch or prod) is done by the orchestrator after explicit user OK + backup, per repo policy — not inside task execution.

---

## Task 2: Resolve swap config from the tap (remove crossing inference)

**Files:**
- Modify: `lib/square/taproomConsumption.ts`
- Test: `lib/square/taproomConsumption.test.ts`

**Interfaces:**
- Consumes: `RestockLineEvent` from `./inventory` (unchanged).
- Produces:
  - `TapRestockLink` gains `swapVariationId: string | null` and `swapVolumeFlOz: number | null`.
  - `ConsumptionUnit` gains `tapNumber?: number`.
  - `assembleConsumption(input)` where `input` = `{ salesByDay, kegCanLinks, draftLinks, restockEvents?, tapRestockLinks? }` — **`physicalCountsByVar` and `swapByRecipe` are removed**.
  - `SwapConfig` type and `DEFAULT_SWAP_VOLUME_FL_OZ` are removed; `detectKegSwaps` import removed.

- [ ] **Step 1: Update the failing tests first**

In `lib/square/taproomConsumption.test.ts`: remove the `count()` helper and every `assembleConsumption` call that passes `physicalCountsByVar`/`swapByRecipe` (the crossing-inference `describe` blocks). Update `empty()` and imports:

```typescript
import { describe, it, expect } from "vitest";
import { assembleConsumption, type KegCanLink, type DraftLink, type TapRestockLink } from "./taproomConsumption";
import type { RestockLineEvent } from "./inventory";

function empty() {
  return {
    salesByDay: new Map<string, number>(),
    kegCanLinks: [] as KegCanLink[],
    draftLinks: [] as DraftLink[],
  };
}

const draftLink: DraftLink = { squareVariationId: "draft-sqvar", recipeId: "recipe-1", beerName: "Vienna Lager" };

const tapLink = (over: Partial<TapRestockLink> = {}): TapRestockLink => ({
  restockVariationId: "restock-tap3",
  tapNumber: 3,
  recipeId: "recipe-1",
  beerName: "Vienna Lager",
  swapVariationId: "pv-keg-1",
  swapVolumeFlOz: 660,
  ...over,
});

const restockEvent = (over: Partial<RestockLineEvent> = {}): RestockLineEvent => ({
  orderId: "ord-1",
  lineUid: "line-1",
  squareVariationId: "restock-tap3",
  quantity: 1,
  occurredAt: "2026-07-04T20:00:00Z",
  ...over,
});

describe("assembleConsumption — restock draft swaps (tap grain)", () => {
  it("maps a restock line to a draft_swap unit with the tap's swap keg + recount", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
    });
    expect(discrepancies).toHaveLength(0);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      recipeId: "recipe-1",
      variationId: "pv-keg-1",
      kind: "draft_swap",
      sourceRef: "sqtransfer:ord-1:line-1",
      tapNumber: 3,
      recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
    });
  });

  it("flags an unconfigured swap when the tap has no swap keg", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink({ swapVariationId: null })],
    });
    expect(units).toHaveLength(0);
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ kind: "unconfigured_draft_swap", recipeId: "recipe-1", swapCount: 1 }),
    );
  });

  it("flags an unmapped restock when the variation maps to no tap", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      restockEvents: [restockEvent({ squareVariationId: "restock-unknown" })],
      tapRestockLinks: [tapLink()],
    });
    expect(units).toHaveLength(0);
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ kind: "unmapped_restock", squareVariationId: "restock-unknown", count: 1 }),
    );
  });

  it("omits the recount when the recipe has no draft Square link", () => {
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
    });
    expect(units[0].recount).toBeUndefined();
  });
});
```

Keep the existing keg/can-sale `describe` block as-is (it passes `salesByDay`/`kegCanLinks` only).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- lib/square/taproomConsumption.test.ts`
Expected: FAIL — `TapRestockLink` has no `swapVariationId`, and the crossing-based assembly still requires removed fields.

- [ ] **Step 3: Rewrite `taproomConsumption.ts`**

Remove the `detectKegSwaps` import. Delete the `SwapConfig` interface and `DEFAULT_SWAP_VOLUME_FL_OZ`. Update `TapRestockLink`:

```typescript
// tap → its Square "Draft Restock" variation, plus the tap's own swap config
export interface TapRestockLink {
  restockVariationId: string;
  tapNumber: number;
  recipeId: string | null;
  beerName: string;
  swapVariationId: string | null;   // cold-storage packaging variation to drain
  swapVolumeFlOz: number | null;    // full-keg recount target
}
```

Add `tapNumber?: number;` to `ConsumptionUnit`. Change the `assembleConsumption` input type to drop `physicalCountsByVar` and `swapByRecipe`, and destructure only `{ salesByDay, kegCanLinks, draftLinks, restockEvents = [], tapRestockLinks = [] }`.

Replace the restock loop body and DELETE the entire count-crossing `for (const draft of draftLinks)` block. The restock loop becomes:

```typescript
const linkByRestockVar = new Map<string, TapRestockLink>();
for (const link of tapRestockLinks) linkByRestockVar.set(link.restockVariationId, link);

const restockUnconfigured = new Map<string, { beerName: string; count: number }>();
const unmappedRestock = new Map<string, number>();
for (const ev of restockEvents) {
  const link = linkByRestockVar.get(ev.squareVariationId);
  if (!link || !link.recipeId) {
    unmappedRestock.set(ev.squareVariationId, (unmappedRestock.get(ev.squareVariationId) ?? 0) + 1);
    continue;
  }
  if (!link.swapVariationId || !link.swapVolumeFlOz) {
    const prev = restockUnconfigured.get(link.recipeId);
    restockUnconfigured.set(link.recipeId, { beerName: link.beerName, count: (prev?.count ?? 0) + 1 });
    continue;
  }
  const draftSquareVar = draftSquareVarByRecipe.get(link.recipeId);
  units.push({
    recipeId: link.recipeId,
    variationId: link.swapVariationId,
    quantity: ev.quantity,
    sourceRef: `sqtransfer:${ev.orderId}:${ev.lineUid}`,
    kind: "draft_swap",
    label: `${link.beerName} · Tap ${link.tapNumber} restock · ${ev.occurredAt.slice(0, 10)}`,
    tapNumber: link.tapNumber,
    recount: draftSquareVar
      ? { squareVariationId: draftSquareVar, quantity: link.swapVolumeFlOz, occurredAt: ev.occurredAt }
      : undefined,
  });
}
for (const [recipeId, v] of restockUnconfigured) {
  discrepancies.push({ kind: "unconfigured_draft_swap", recipeId, beerName: v.beerName, swapCount: v.count });
}
for (const [squareVariationId, count] of unmappedRestock) {
  discrepancies.push({ kind: "unmapped_restock", squareVariationId, count });
}
```

Keep `draftSquareVarByRecipe` (built from `draftLinks`) — it now serves only the recount target.

- [ ] **Step 4: Update `deriveTaproomConsumption` (same file)**

- Change the `tap_assignments` select to `"tap_number, recipe_id, restock_variation_id, swap_variation_id, swap_volume_fl_oz, recipes(beer_name)"` and add those fields to `TapAssignmentRow`.
- Build `tapRestockLinks` including `swapVariationId: t.swap_variation_id, swapVolumeFlOz: t.swap_volume_fl_oz`.
- DELETE the `taproom_recipe_settings` swap query and `swapByRecipe`.
- DELETE the `fetchPhysicalCounts` call, `physicalCountsByVar`, and `draftSquareVarIds` plumbing (draftLinks stay; their square ids are no longer fetched for counts).
- Remove `fetchPhysicalCounts`/`PhysicalCount` from the import from `./inventory` (keep `fetchOrderSalesByDay`, `fetchDraftRestockLineItems`, `RestockLineEvent`).
- Final `assembleConsumption({ salesByDay, kegCanLinks, draftLinks, restockEvents, tapRestockLinks })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- lib/square/taproomConsumption.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `taproomConsumption.ts` (the sync in Task 3 may still reference old shapes until updated — if so, proceed; Task 3 fixes it).

- [ ] **Step 7: Commit**

```bash
git add lib/square/taproomConsumption.ts lib/square/taproomConsumption.test.ts
git commit -m "feat(taproom): resolve draft swap config per-tap, drop crossing inference"
```

---

## Task 3: Capture deterministic shrinkage at recount time

**Files:**
- Modify: `lib/production/taproomConsumptionSync.ts`
- Test: `lib/production/taproomConsumptionSync.test.ts`

**Interfaces:**
- Consumes: `ConsumptionUnit` (now with `tapNumber?`), `RecountInstruction` from `taproomConsumption.ts`; `setPhysicalCount`, `fetchPhysicalCounts` from `@/lib/square/inventory`.
- Produces: exported pure `remainingAtOrBefore(counts: PhysicalCount[], occurredAt: string): number | null`. New `SyncDiscrepancy` variant `{ kind: "shrinkage_capture_failed"; sourceRef: string; detail: string }`. Upserts `draft_swap_shrinkage` rows keyed by `source_ref`.

- [ ] **Step 1: Write failing tests for the pure helper + capture**

Add to `lib/production/taproomConsumptionSync.test.ts`. First extend the inventory mock and add the helper import:

```typescript
vi.mock("@/lib/square/inventory", () => ({
  setPhysicalCount: vi.fn(),
  fetchPhysicalCounts: vi.fn(),
}));
import { runTaproomConsumptionSync, remainingDelta, remainingAtOrBefore } from "./taproomConsumptionSync";
import { setPhysicalCount, fetchPhysicalCounts } from "@/lib/square/inventory";
const recount = vi.mocked(setPhysicalCount);
const fetchCounts = vi.mocked(fetchPhysicalCounts);

const pc = (id: string, quantity: number, occurredAt: string) => ({
  id, catalog_object_id: "draft-sqvar", catalog_object_type: "ITEM_VARIATION",
  state: "IN_STOCK", location_id: "LZ8TH4A632YW0",
  quantity: String(quantity), occurred_at: occurredAt, created_at: occurredAt,
});

describe("remainingAtOrBefore", () => {
  it("returns the latest count at or before the timestamp", () => {
    const counts = [pc("a", 500, "2026-07-01T00:00:00Z"), pc("b", 45, "2026-07-04T18:00:00Z"), pc("c", 660, "2026-07-04T21:00:00Z")];
    expect(remainingAtOrBefore(counts, "2026-07-04T20:00:00Z")).toBe(45);
  });
  it("returns null when no count precedes the timestamp", () => {
    expect(remainingAtOrBefore([pc("c", 660, "2026-07-05T00:00:00Z")], "2026-07-04T20:00:00Z")).toBeNull();
  });
});
```

Then update the shared `fakeSupabase` to also capture `draft_swap_shrinkage` upserts, and add the capture test. Replace `fakeSupabase` with:

```typescript
function fakeSupabase(rows: { source_ref: string; quantity: number }[], sink?: { shrinkage: unknown[] }) {
  return {
    from: (table: string) => {
      if (table === "draft_swap_shrinkage") {
        return { upsert: async (row: unknown) => { sink?.shrinkage.push(row); return { error: null }; } };
      }
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    },
  } as never;
}

const swapUnit = (over: Record<string, unknown> = {}) => ({
  recipeId: "r1", variationId: "pv-keg", quantity: 1,
  sourceRef: "sqtransfer:ord-1:line-1", kind: "draft_swap" as const,
  label: "Vienna · Tap 3 restock · 2026-07-04", tapNumber: 3,
  recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
  ...over,
});

it("captures shrinkage once and recounts to full on first record", async () => {
  const sink = { shrinkage: [] as unknown[] };
  derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
  record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"] });
  fetchCounts.mockResolvedValue([pc("b", 45, "2026-07-04T18:00:00Z")]);
  const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
  expect(sink.shrinkage).toHaveLength(1);
  expect(sink.shrinkage[0]).toMatchObject({
    source_ref: "sqtransfer:ord-1:line-1", recipe_id: "r1", tap_number: 3,
    remaining_fl_oz: 45, full_fl_oz: 660, occurred_at: "2026-07-04T20:00:00Z",
  });
  expect(recount).toHaveBeenCalledWith("draft-sqvar", 660, "2026-07-04T20:00:00Z");
  expect(res.recountsApplied).toBe(1);
});

it("does not capture shrinkage again when already recorded", async () => {
  const sink = { shrinkage: [] as unknown[] };
  derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
  const res = await runTaproomConsumptionSync(
    fakeSupabase([{ source_ref: "sqtransfer:ord-1:line-1", quantity: 1 }], sink), { days: 2 });
  expect(sink.shrinkage).toHaveLength(0);
  expect(recount).not.toHaveBeenCalled();
  expect(res.skipped).toBe(1);
});

it("flags shrinkage capture failure without aborting the recount", async () => {
  const sink = { shrinkage: [] as unknown[] };
  derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
  record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"] });
  fetchCounts.mockRejectedValue(new Error("square down"));
  const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
  expect(recount).toHaveBeenCalled();
  expect(res.discrepancies).toContainEqual(
    expect.objectContaining({ kind: "shrinkage_capture_failed", sourceRef: "sqtransfer:ord-1:line-1" }));
});
```

Add `beforeEach` reset for `recount` and `fetchCounts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- lib/production/taproomConsumptionSync.test.ts`
Expected: FAIL — `remainingAtOrBefore` not exported; shrinkage upsert not implemented.

- [ ] **Step 3: Implement in `taproomConsumptionSync.ts`**

Add imports and the pure helper:

```typescript
import { setPhysicalCount, fetchPhysicalCounts, type PhysicalCount } from "@/lib/square/inventory";

/** Draft SKU on-hand as of a timestamp: the latest PHYSICAL_COUNT at or before it. */
export function remainingAtOrBefore(counts: PhysicalCount[], occurredAt: string): number | null {
  const prior = counts
    .filter((c) => c.occurred_at <= occurredAt)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const last = prior.at(-1);
  return last ? parseFloat(last.quantity) : null;
}
```

Add the discrepancy variant to the `SyncDiscrepancy` union:

```typescript
  | {
      kind: "shrinkage_capture_failed";
      sourceRef: string;
      detail: string;
    }
```

Add a `shrinkageWarnings: SyncDiscrepancy[] = []` accumulator alongside `recountWarnings`. In the recount branch (`if (u.recount && alreadyRecorded === 0)`), BEFORE `setPhysicalCount`, capture shrinkage (best-effort, isolated try/catch so a failure never blocks the recount):

```typescript
if (u.recount && alreadyRecorded === 0) {
  // Deterministic shrinkage: the draft SKU's on-hand as of the swap, captured
  // before the recount overwrites it to full. Best-effort — never fatal.
  try {
    const day = (s: string) => s.slice(0, 10);
    const windowStart = new Date(new Date(u.recount.occurredAt).getTime() - 45 * 86400000).toISOString();
    const counts = await fetchPhysicalCounts(day(windowStart), day(u.recount.occurredAt), [u.recount.squareVariationId]);
    const remaining = remainingAtOrBefore(counts, u.recount.occurredAt);
    if (remaining !== null) {
      const { error } = await supabase.from("draft_swap_shrinkage").upsert({
        source_ref:      u.sourceRef,
        recipe_id:       u.recipeId,
        tap_number:      u.tapNumber ?? null,
        occurred_at:     u.recount.occurredAt,
        remaining_fl_oz: remaining,
        full_fl_oz:      u.recount.quantity,
      }, { onConflict: "source_ref" });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    shrinkageWarnings.push({
      kind: "shrinkage_capture_failed",
      sourceRef: u.sourceRef,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    await setPhysicalCount(u.recount.squareVariationId, u.recount.quantity, u.recount.occurredAt);
    recountsApplied++;
  } catch (e) {
    recountWarnings.push({ kind: "recount_failed", sourceRef: u.sourceRef, label: u.label,
      detail: e instanceof Error ? e.message : String(e) });
  }
}
```

Append `...shrinkageWarnings` to the returned `discrepancies` array.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- lib/production/taproomConsumptionSync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/taproomConsumptionSync.ts lib/production/taproomConsumptionSync.test.ts
git commit -m "feat(taproom): capture deterministic swap shrinkage at recount"
```

> **R1 (from spec):** `remainingAtOrBefore` reads the latest PHYSICAL_COUNT at/before the swap. If real Square data shows draft pours are NOT recorded as PHYSICAL_COUNT changes, this reads a stale level. Validate against a real swap's change history with the user before relying on the chart; the read helper is isolated so only its body changes if the source must switch.

---

## Task 4: Pure shrinkage aggregation module

**Files:**
- Create: `lib/reports/draftShrinkage.ts`
- Test: `lib/reports/draftShrinkage.test.ts`

**Interfaces:**
- Produces: `SwapShrinkageRow` = `{ recipe_id: string; occurred_at: string; remaining_fl_oz: number; full_fl_oz: number }`; `ShrinkageByRecipe` = `{ recipe_id, beer_name, events: {date,shrinkage_fl_oz,shrinkage_pct}[], avg_shrinkage_fl_oz, avg_shrinkage_pct, keg_count }`; `aggregateShrinkage(rows: SwapShrinkageRow[], beerNameByRecipe: Map<string,string>): ShrinkageByRecipe[]`.

- [ ] **Step 1: Write the failing test**

Create `lib/reports/draftShrinkage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { aggregateShrinkage, type SwapShrinkageRow } from "./draftShrinkage";

const rows: SwapShrinkageRow[] = [
  { recipe_id: "r1", occurred_at: "2026-07-01T10:00:00Z", remaining_fl_oz: 60, full_fl_oz: 660 },
  { recipe_id: "r1", occurred_at: "2026-07-03T10:00:00Z", remaining_fl_oz: 40, full_fl_oz: 660 },
  { recipe_id: "r2", occurred_at: "2026-07-02T10:00:00Z", remaining_fl_oz: 990, full_fl_oz: 1980 },
];

describe("aggregateShrinkage", () => {
  it("averages fl oz and pct per recipe using per-row full volume", () => {
    const out = aggregateShrinkage(rows, new Map([["r1", "Vienna"], ["r2", "Porter"]]));
    const r1 = out.find((o) => o.recipe_id === "r1")!;
    expect(r1.beer_name).toBe("Vienna");
    expect(r1.keg_count).toBe(2);
    expect(r1.avg_shrinkage_fl_oz).toBe(50);
    expect(r1.avg_shrinkage_pct).toBe(7.6); // mean(60/660, 40/660)*100 = 7.575 -> 7.6
    expect(r1.events.map((e) => e.date)).toEqual(["2026-07-01", "2026-07-03"]);
  });

  it("computes pct off each row's own full volume (50% for the 1/2 keg)", () => {
    const out = aggregateShrinkage(rows, new Map([["r2", "Porter"]]));
    expect(out.find((o) => o.recipe_id === "r2")!.avg_shrinkage_pct).toBe(50);
  });

  it("sorts recipes by descending avg shrinkage", () => {
    const out = aggregateShrinkage(rows, new Map());
    expect(out[0].recipe_id).toBe("r2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- lib/reports/draftShrinkage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/reports/draftShrinkage.ts`**

```typescript
export interface SwapShrinkageRow {
  recipe_id: string;
  occurred_at: string;
  remaining_fl_oz: number;
  full_fl_oz: number;
}

export interface ShrinkageEvent {
  date: string;
  shrinkage_fl_oz: number;
  shrinkage_pct: number;
}

export interface ShrinkageByRecipe {
  recipe_id: string;
  beer_name: string;
  events: ShrinkageEvent[];
  avg_shrinkage_fl_oz: number;
  avg_shrinkage_pct: number;
  keg_count: number;
}

const round1 = (n: number) => Number(n.toFixed(1));

/** Group deterministic swap-shrinkage rows into the per-recipe chart shape. */
export function aggregateShrinkage(
  rows: SwapShrinkageRow[],
  beerNameByRecipe: Map<string, string>,
): ShrinkageByRecipe[] {
  const byRecipe = new Map<string, SwapShrinkageRow[]>();
  for (const row of rows) {
    const list = byRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    byRecipe.set(row.recipe_id, list);
  }

  return [...byRecipe.entries()]
    .map(([recipe_id, group]) => {
      const events: ShrinkageEvent[] = group
        .map((r) => ({
          date: r.occurred_at.slice(0, 10),
          shrinkage_fl_oz: round1(r.remaining_fl_oz),
          shrinkage_pct: r.full_fl_oz > 0 ? round1((r.remaining_fl_oz / r.full_fl_oz) * 100) : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const avgFlOz = group.reduce((s, r) => s + r.remaining_fl_oz, 0) / group.length;
      const avgPct =
        group.reduce((s, r) => s + (r.full_fl_oz > 0 ? r.remaining_fl_oz / r.full_fl_oz : 0), 0) / group.length;
      return {
        recipe_id,
        beer_name: beerNameByRecipe.get(recipe_id) ?? "—",
        events,
        avg_shrinkage_fl_oz: round1(avgFlOz),
        avg_shrinkage_pct: round1(avgPct * 100),
        keg_count: group.length,
      };
    })
    .sort((a, b) => b.avg_shrinkage_fl_oz - a.avg_shrinkage_fl_oz);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- lib/reports/draftShrinkage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reports/draftShrinkage.ts lib/reports/draftShrinkage.test.ts
git commit -m "feat(reports): pure deterministic draft-shrinkage aggregation"
```

---

## Task 5: Draft-stats route reads persisted shrinkage

**Files:**
- Modify: `app/api/taproom/draft-stats/route.ts`

**Interfaces:**
- Consumes: `aggregateShrinkage`, `SwapShrinkageRow` from `@/lib/reports/draftShrinkage`.
- Produces: unchanged response shape — `shrinkage_by_recipe: ShrinkageByRecipe[]`.

- [ ] **Step 1: Replace the inference block**

Remove imports of `fetchPhysicalCounts`, `PhysicalCount`, `detectKegSwaps`, the `FULL_KEG_FL_OZ` constant, the `KegEvent` interface, and the `detectKegEvents` helper. Add:

```typescript
import { aggregateShrinkage, type SwapShrinkageRow } from "@/lib/reports/draftShrinkage";
```

Replace the whole "Shrinkage: physical count history …" section (from `const draftVarIds = …` through the `shrinkageByRecipe` construction) with:

```typescript
    // Deterministic shrinkage: read persisted per-swap rows for the window.
    const shrinkageStart = new Date(Date.now() - days * 86400000).toISOString();
    const { data: shrinkRows } = await supabase
      .from("draft_swap_shrinkage")
      .select("recipe_id, occurred_at, remaining_fl_oz, full_fl_oz")
      .gte("occurred_at", shrinkageStart);

    const beerNameByRecipe = new Map<string, string>(
      [...byRecipe.entries()].map(([id, v]) => [id, v.beer_name]),
    );
    const shrinkageByRecipe = aggregateShrinkage(
      (shrinkRows ?? []) as SwapShrinkageRow[],
      beerNameByRecipe,
    );
```

Leave `enrichedTaps` and the final `NextResponse.json({ tap_count, taps: enrichedTaps, shrinkage_by_recipe: shrinkageByRecipe })` untouched.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `draft-stats/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/api/taproom/draft-stats/route.ts
git commit -m "feat(taproom): draft-stats reads deterministic shrinkage table"
```

---

## Task 6: Tap-config route carries per-tap swap fields

**Files:**
- Modify: `app/api/taproom/tap-config/route.ts`

**Interfaces:**
- Produces: GET `taps[]` include `swap_variation_id`, `swap_volume_fl_oz`; PUT accepts them per tap and upserts to `tap_assignments`.

- [ ] **Step 1: Extend GET select**

Change the `tap_assignments` select to:

```typescript
      .select("tap_number, recipe_id, label, restock_variation_id, swap_variation_id, swap_volume_fl_oz, recipes(beer_name)")
```

- [ ] **Step 2: Extend PUT body type + upsert**

In the PUT body type, add to each tap: `swap_variation_id?: string | null; swap_volume_fl_oz?: number | null;`. In the per-tap upsert object, add:

```typescript
              swap_variation_id:    tap.swap_variation_id || null,
              swap_volume_fl_oz:    tap.swap_volume_fl_oz ?? null,
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `tap-config/route.ts`.

- [ ] **Step 4: Commit**

```bash
git add app/api/taproom/tap-config/route.ts
git commit -m "feat(taproom): tap-config persists per-tap swap keg + volume"
```

---

## Task 7: Trim swap config from taproom-recipe-settings

**Files:**
- Modify: `app/api/production/taproom-recipe-settings/route.ts`

**Interfaces:**
- Produces: PATCH handles only retirement fields (`is_retired`, `retired_notes`).

- [ ] **Step 1: Remove the swap branches**

In the PATCH body type remove `swap_variation_id` and `swap_volume_fl_oz`. Delete the two `if ("swap_variation_id" in body)` and `if ("swap_volume_fl_oz" in body)` blocks entirely. Leave the `is_retired` block and the upsert intact.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `taproom-recipe-settings/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/taproom-recipe-settings/route.ts
git commit -m "refactor(taproom): recipe-settings keeps only retirement"
```

---

## Task 8: Configure Taps UI — per-tap swap keg + volume + auto-map

**Files:**
- Modify: `app/taproom/components/DraftStatsTab.tsx`

**Interfaces:**
- Consumes: `AvailableInventoryLine` from `app/production/types.ts` (`{ recipe_id, variation_id, variation_name, container_type, quantity_on_hand }`); `queryKeys.production.exportBayInventory()` → `/api/production/export-bay/inventory`.

- [ ] **Step 1: Load cold-storage kegs; drop the old swap-inventory data**

Add a query near the other `useQuery` calls:

```typescript
  // Cold-storage on-hand kegs, for the per-tap "keg to drain" dropdown.
  const { data: coldStorage = [] } = useQuery({
    queryKey: queryKeys.production.exportBayInventory(),
    queryFn:  () => fetchJson<AvailableInventoryLine[]>("/api/production/export-bay/inventory"),
    staleTime: 60_000,
  });

  // Per-recipe keg lots actually on hand (container = keg, qty > 0).
  const kegOptionsByRecipe = new Map<string, AvailableInventoryLine[]>();
  for (const line of coldStorage) {
    if (line.container_type !== "keg" || line.quantity_on_hand <= 0) continue;
    const list = kegOptionsByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    kegOptionsByRecipe.set(line.recipe_id, list);
  }
```

Add `import type { AvailableInventoryLine } from "@/app/production/types";` (match the existing import style for the file). Delete the `rpv`/`settings` queries and the `DraftSwapInventorySection` component entirely (and the `RPVRow`, `SwapSettingRow`, `KegOption` interfaces and the `{draftRecipes.length > 0 && <DraftSwapInventorySection …/>}` render at the bottom).

- [ ] **Step 2: Extend per-tap edit state**

Change `tapEdits` state type and every initializer to include swap fields:

```typescript
  const [tapEdits, setTapEdits] = useState<Record<number, {
    recipe_id: string; label: string; restock_variation_id: string;
    swap_variation_id: string; swap_volume_fl_oz: string;
  }>>({});
```

In the `useEffect`/initializer that seeds `tapEdits` from `tapConfig.taps`, populate the two new fields from each tap (`t.swap_variation_id ?? ""`, `t.swap_volume_fl_oz != null ? String(t.swap_volume_fl_oz) : ""`), and update `getTapEdit`'s fallback object and `setTapEdit`'s `field` union to include `"swap_variation_id" | "swap_volume_fl_oz"`. Add `swap_variation_id`, `swap_volume_fl_oz` to the `TapConfig` tap type used by the GET query.

- [ ] **Step 3: Add the keg + volume controls to each tap card**

Inside the `editingTaps` branch of a tap card, after the restock-variation `<select>`, add (uses the tap's currently-selected recipe to scope options):

```tsx
                    {(() => {
                      const kegs = kegOptionsByRecipe.get(edit.recipe_id) ?? [];
                      const needsKeg = edit.recipe_id && !edit.swap_variation_id;
                      return (
                        <>
                          <select
                            className="inp text-xs w-full disabled:opacity-40"
                            value={edit.swap_variation_id}
                            disabled={!edit.recipe_id}
                            title="Cold-storage keg drained when this tap is swapped"
                            onChange={(e) => {
                              const opt = kegs.find((k) => k.variation_id === e.target.value);
                              setTapEdit(tapNum, "swap_variation_id", e.target.value);
                              // Auto-fill volume from the lot's container when empty.
                              if (opt && !getTapEdit(tapNum).swap_volume_fl_oz) {
                                const vol = containerVolumeFor(opt);
                                if (vol) setTapEdit(tapNum, "swap_volume_fl_oz", String(vol));
                              }
                            }}
                          >
                            <option value="">— keg to drain —</option>
                            {kegs.map((k) => (
                              <option key={k.variation_id} value={k.variation_id}>
                                {k.variation_name} ({k.quantity_on_hand} on hand)
                              </option>
                            ))}
                          </select>
                          <input
                            className="inp text-xs w-full"
                            placeholder="Full-keg fl oz (recount target)"
                            value={edit.swap_volume_fl_oz}
                            onChange={(e) => setTapEdit(tapNum, "swap_volume_fl_oz", e.target.value)}
                          />
                          {needsKeg && (
                            <p className="text-xs text-danger">Needs a swap keg</p>
                          )}
                        </>
                      );
                    })()}
```

`AvailableInventoryLine` has no volume field, so add a small helper near the top of the component. Since on-hand lines don't carry container volume, derive it from the variation name's keg size, falling back to blank (user types it):

```typescript
  // Best-effort full-keg fl oz from a keg lot's name; blank if unknown (editable).
  const KEG_FL_OZ: Record<string, number> = { "1/6": 660, "1/4": 992, "1/2": 1984 };
  function containerVolumeFor(line: AvailableInventoryLine): number | null {
    const m = line.variation_name.match(/1\/[0-9]+/);
    return m ? (KEG_FL_OZ[m[0]] ?? null) : null;
  }
```

- [ ] **Step 4: Add the "Auto-map kegs" button**

In the Configure Taps header area next to "Auto-match by tap #", add:

```tsx
            <button
              type="button"
              onClick={autoMapKegs}
              className="btn-ghost btn-sm"
            >
              Auto-map kegs
            </button>
```

And the handler (never clobbers a manual pick; picks the sole keg, else the largest-volume):

```typescript
  function autoMapKegs() {
    setTapEdits((prev) => {
      const next = { ...prev };
      for (let n = 1; n <= (tapsToRender.length || 0); n++) {
        const cur = next[n] ?? { recipe_id: "", label: "", restock_variation_id: "", swap_variation_id: "", swap_volume_fl_oz: "" };
        if (!cur.recipe_id || cur.swap_variation_id) continue;
        const kegs = kegOptionsByRecipe.get(cur.recipe_id) ?? [];
        if (kegs.length === 0) continue;
        const pick = kegs.length === 1
          ? kegs[0]
          : [...kegs].sort((a, b) => (containerVolumeFor(b) ?? 0) - (containerVolumeFor(a) ?? 0))[0];
        const vol = containerVolumeFor(pick);
        next[n] = {
          ...cur,
          swap_variation_id: pick.variation_id,
          swap_volume_fl_oz: cur.swap_volume_fl_oz || (vol ? String(vol) : ""),
        };
      }
      return next;
    });
  }
```

- [ ] **Step 5: Include swap fields in the save payload**

In the save handler that builds `taps`, add the two fields per tap:

```typescript
        swap_variation_id: e.swap_variation_id || null,
        swap_volume_fl_oz: e.swap_volume_fl_oz ? Number(e.swap_volume_fl_oz) : null,
```

- [ ] **Step 6: Verify build + lint**

Run: `npm run build`
Expected: compiles with no type errors. Then `npm run lint` — no new errors.

- [ ] **Step 7: Verify in the preview**

Start the dev server (`preview_start`), open the taproom draft-stats page, click **Configure Taps**, and confirm: a tap with a recipe shows keg options like `1/6 Keg (N on hand)`; "Auto-map kegs" fills them; Save persists (reload keeps values). Capture a screenshot for the reviewer.

- [ ] **Step 8: Commit**

```bash
git add app/taproom/components/DraftStatsTab.tsx
git commit -m "feat(taproom): per-tap swap keg + volume + auto-map in Configure Taps"
```

---

## Task 9: Delete dead code + full verification

**Files:**
- Delete: `lib/square/draftKegEvents.ts`, `lib/square/draftKegEvents.test.ts`

**Interfaces:** none produced.

- [ ] **Step 1: Confirm no remaining references**

Run: `grep -rn "draftKegEvents\|detectKegSwaps\|SWAP_THRESHOLD_FRACTION" app lib`
Expected: no matches.

- [ ] **Step 2: Delete the files**

```bash
git rm lib/square/draftKegEvents.ts lib/square/draftKegEvents.test.ts
```

- [ ] **Step 3: Full test + typecheck + build**

Run: `npm run test`
Expected: all green, coverage above threshold.
Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(taproom): remove count-crossing keg-swap inference"
```

---

## Self-Review

**Spec coverage:**
- Restock = sole path, crossing removed → Task 2, Task 9.
- Swap config per-tap (add cols, backfill, drop old) → Task 1; sync resolves from tap → Task 2; save via tap-config PUT → Task 6; recipe-settings trim → Task 7.
- Deterministic shrinkage table + capture → Task 1 (table), Task 3 (capture), R1 noted.
- Shrinkage read replaced → Task 4 (pure agg), Task 5 (route).
- Configure Taps per-tap UI + keg source from cold storage on-hand + auto-map + "needs a swap keg" flag → Task 8.
- Deletions (draftKegEvents, DraftSwapInventorySection, recipe-settings branches, dropped columns, inferred shrinkage) → Tasks 2, 5, 7, 8, 9.

**Placeholder scan:** No TBD/TODO; every code step shows full code. R1 is an explicit validation note, not a placeholder — the read helper is fully implemented against a defined data source.

**Type consistency:** `TapRestockLink` (+`swapVariationId`,`swapVolumeFlOz`), `ConsumptionUnit.tapNumber`, `remainingAtOrBefore(counts, occurredAt)`, `draft_swap_shrinkage` columns (`source_ref, recipe_id, tap_number, occurred_at, remaining_fl_oz, full_fl_oz`), `SwapShrinkageRow`/`aggregateShrinkage`, and `AvailableInventoryLine` fields are used identically across Tasks 1–8.

**Known non-blocking note:** Between Task 2 and Task 3, `taproomConsumptionSync.ts` references `ConsumptionUnit.tapNumber` (added in Task 2) but doesn't yet read it — no type break. Full `tsc` is clean only after Task 3; Task 2 Step 6 accounts for this.
