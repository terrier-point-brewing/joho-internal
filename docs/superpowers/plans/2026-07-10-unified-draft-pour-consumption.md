# Unified Draft Pour Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make actual draft *pour* sell-through (5oz/10oz/16oz) the single, persisted, validated basis for every taproom operational metric — fl-oz-available, oz/day, days-left, shrinkage, and production demand — while leaving the whole-keg "export at swap" accounting path byte-for-byte untouched.

**Architecture:** Two deliberately separate lenses on the same physical beer. (1) **Accounting truth = keg-granularity**, unchanged: a `draft_swap` still writes a whole-keg `export_transactions` row + excise + cold-storage depletion + the Square recount. (2) **Operational truth = pour-granularity**, new: a persisted daily ledger `draft_pour_consumption` populated from Square pour-variation order sales, read by sell-through, demand, and shrinkage. Shrinkage "leftover at swap" is captured live from Square's calculated on-hand (which nets pours) and reconstructed historically as `last_recount − pours_since`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Square API v2025-04-16 (raw fetch), Vitest.

## Global Constraints

- **FROZEN — do not modify the draft_swap accounting write path.** No changes to `lib/production/exportTransactionWriter.ts`, `lib/production/recordTaproomConsumption.ts`, `lib/production/shipmentWriter.ts`, cold-storage depletion, `computeExciseTaxBreakdown`, or the `export_transactions`/`export_transaction_taxes` columns written for a `draft_swap`. The whole-keg `quantity`/`volume_bbl`/excise and the `setPhysicalCount` recount are the accounting basis and stay identical. A guardrail test (Task 6) asserts this.
- **Only touch these operational surfaces:** `lib/square/sell-through.ts`, `app/api/taproom/draft-stats/route.ts`, `app/api/production/demand-calendar/route.ts`, `app/production/lib/demandCalendar.ts` (consumer only), `lib/production/backfillDraftShrinkage.ts`, `app/api/taproom/draft-stats/backfill/route.ts`, and the shrinkage-capture block only (lines ~229–249) of `lib/production/taproomConsumptionSync.ts`.
- **Square location:** `LZ8TH4A632YW0`. Square version `2025-04-16`. `BBL_TO_FL_OZ` from `lib/constants/production.ts`.
- **Every new/modified `lib/` module ships with co-located `*.test.ts`.** CI runs `npm run test`; do not drop `lib/` coverage below the `vitest.config.ts` floor.
- **No raw colors / hand-rolled primitives** in any UI touched (`docs/UI_STANDARD.md`).
- **Migrations are append-only.** Add a new file under `supabase/migrations/`; never edit an existing one. Next filename date prefix: `20260727_...`.

---

## File Structure

**Create:**
- `supabase/migrations/20260727_draft_pour_consumption.sql` — the persisted daily pour ledger table.
- `lib/taproom/draftPourConsumption.ts` — the one operational primitive: pure aggregation + ledger read + pour-variation loading.
- `lib/taproom/draftPourConsumption.test.ts`
- `lib/production/syncDraftPourConsumption.ts` — populates the ledger from Square pour sales.
- `lib/production/syncDraftPourConsumption.test.ts`

**Modify:**
- `lib/square/sell-through.ts` — draft oz/day reads the ledger; `current_qty` still Square live.
- `app/api/production/demand-calendar/route.ts` — draft daily/current bbl via the primitive (fixes the zero-draft-demand bug).
- `lib/production/taproomConsumptionSync.ts` — revert #155 capture; live shrinkage = `fetchCurrentCounts` pre-recount; call the pour-ledger sync.
- `lib/square/inventory.ts` — revert #155 additions; restore `fetchPhysicalCounts`.
- `lib/production/backfillDraftShrinkage.ts` — reconstruct `last_recount − pours_since`.
- Their co-located tests.

**Frozen (read-only reference, never edited):** `exportTransactionWriter.ts`, `recordTaproomConsumption.ts`, `shipmentWriter.ts`.

---

## Task 1: Persisted pour ledger table

**Files:**
- Create: `supabase/migrations/20260727_draft_pour_consumption.sql`

**Interfaces:**
- Produces: table `draft_pour_consumption(recipe_id uuid, business_date date, fl_oz numeric, pour_units numeric, updated_at timestamptz)`, unique `(recipe_id, business_date)`.

- [ ] **Step 1: Write the migration**

```sql
-- Daily operational record of actual draft POUR consumption (fl oz), per recipe.
-- This is the taproom operational lens (sell-through / demand / shrinkage) and is
-- intentionally separate from the whole-keg accounting lens in export_transactions.
create table if not exists draft_pour_consumption (
  recipe_id     uuid not null references recipes(id) on delete cascade,
  business_date date not null,
  fl_oz         numeric not null default 0,
  pour_units    numeric not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (recipe_id, business_date)
);

create index if not exists draft_pour_consumption_date_idx
  on draft_pour_consumption (business_date);

alter table draft_pour_consumption enable row level security;

-- Service-role only (populated by the sync, read by server routes via service/admin
-- or server client). No public/anon access — matches the RLS posture of the other
-- taproom operational tables.
create policy draft_pour_consumption_service_all
  on draft_pour_consumption for all
  to service_role using (true) with check (true);
```

- [ ] **Step 2: Verify SQL parses locally**

Run: `node -e "require('fs').readFileSync('supabase/migrations/20260727_draft_pour_consumption.sql','utf8')"`
Expected: no error (file present). Apply-to-prod is a separate, human-authorized step (see Task 8).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727_draft_pour_consumption.sql
git commit -m "feat(taproom): add draft_pour_consumption daily ledger table"
```

---

## Task 2: Pour-consumption primitive (pure aggregation + ledger read + variation loader)

**Files:**
- Create: `lib/taproom/draftPourConsumption.ts`
- Test: `lib/taproom/draftPourConsumption.test.ts`

**Interfaces:**
- Consumes: `fetchOrderSalesByDay(startDate, endDate, ids)` and `fetchOrderSales(startDate, endDate, ids)` from `lib/square/inventory`; `volumeFlOzPerUnit(name)` from `lib/square/catalogUnits`.
- Produces:
  - `interface PourVar { id: string; oz: number | null }`
  - `loadDraftPourVariations(supabase): Promise<Map<string, PourVar[]>>` — recipeId → pour sibling variations (with oz).
  - `aggregatePourFlOzByRecipeDay(salesByDay: Map<string,number>, pourVarsByRecipe: Map<string,PourVar[]>): { recipe_id: string; business_date: string; fl_oz: number; pour_units: number }[]`
  - `aggregatePourFlOzByRecipe(salesTotals: Map<string,number>, pourVarsByRecipe: Map<string,PourVar[]>): Map<string,{ flOz: number; units: number }>`
  - `fetchDailyPourSellThrough(supabase, windowDays: number): Promise<Map<string,{ dailyFlOz: number; dailyUnits: number }>>` — reads the ledger.

- [ ] **Step 1: Write failing tests for the pure aggregators**

```ts
import { describe, it, expect } from "vitest";
import { aggregatePourFlOzByRecipeDay, aggregatePourFlOzByRecipe } from "./draftPourConsumption";

const pourVars = new Map([
  ["r1", [{ id: "v5", oz: 5 }, { id: "v16", oz: 16 }]],
]);

describe("aggregatePourFlOzByRecipeDay", () => {
  it("sums pour units × size into per-recipe-day fl oz", () => {
    const salesByDay = new Map([
      ["v5\t2026-07-01", 3],   // 15 fl oz
      ["v16\t2026-07-01", 2],  // 32 fl oz
      ["v16\t2026-07-02", 1],  // 16 fl oz
    ]);
    const rows = aggregatePourFlOzByRecipeDay(salesByDay, pourVars).sort((a, b) => a.business_date.localeCompare(b.business_date));
    expect(rows).toEqual([
      { recipe_id: "r1", business_date: "2026-07-01", fl_oz: 47, pour_units: 5 },
      { recipe_id: "r1", business_date: "2026-07-02", fl_oz: 16, pour_units: 1 },
    ]);
  });
  it("ignores sales for variations with no known size", () => {
    const rows = aggregatePourFlOzByRecipeDay(new Map([["vX\t2026-07-01", 9]]), new Map([["r1", [{ id: "vX", oz: null }]]]));
    expect(rows).toEqual([{ recipe_id: "r1", business_date: "2026-07-01", fl_oz: 0, pour_units: 9 }]);
  });
});

describe("aggregatePourFlOzByRecipe", () => {
  it("sums total pour fl oz + units per recipe", () => {
    const totals = new Map([["v5", 4], ["v16", 3]]); // 20 + 48 = 68 fl oz, 7 units
    expect(aggregatePourFlOzByRecipe(totals, pourVars).get("r1")).toEqual({ flOz: 68, units: 7 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/taproom/draftPourConsumption.test.ts`
Expected: FAIL — module has no exports yet.

- [ ] **Step 3: Implement the module**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { volumeFlOzPerUnit } from "@/lib/square/catalogUnits";

export interface PourVar { id: string; oz: number | null }

// recipeId → its draft base variation's pour-size sibling variations (5oz/10oz/16oz),
// loaded from the catalog mirror (falling back to parsing oz from the variation name).
export async function loadDraftPourVariations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
): Promise<Map<string, PourVar[]>> {
  const { data: links, error } = await supabase
    .from("recipe_square_links")
    .select("recipe_id, square_item_id")
    .eq("packaging", "draft");
  if (error) throw new Error(error.message);
  const itemToRecipe = new Map<string, string>();
  for (const l of (links ?? []) as { recipe_id: string; square_item_id: string | null }[]) {
    if (l.square_item_id) itemToRecipe.set(l.square_item_id, l.recipe_id);
  }
  const itemIds = [...itemToRecipe.keys()];
  const byRecipe = new Map<string, PourVar[]>();
  if (itemIds.length === 0) return byRecipe;

  const { data: sibs, error: sibErr } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, square_item_id, variation_name, volume_fl_oz_per_unit")
    .in("square_item_id", itemIds);
  if (sibErr) throw new Error(sibErr.message);
  for (const v of (sibs ?? []) as { square_variation_id: string; square_item_id: string; variation_name: string | null; volume_fl_oz_per_unit: number | null }[]) {
    const recipeId = itemToRecipe.get(v.square_item_id);
    if (!recipeId) continue;
    const oz = v.volume_fl_oz_per_unit ?? volumeFlOzPerUnit(v.variation_name);
    const list = byRecipe.get(recipeId) ?? [];
    list.push({ id: v.square_variation_id, oz });
    byRecipe.set(recipeId, list);
  }
  return byRecipe;
}

// Pure: "<varId>\t<YYYY-MM-DD>" → units  ⇒  per (recipe, day) fl oz + pour units.
export function aggregatePourFlOzByRecipeDay(
  salesByDay: Map<string, number>,
  pourVarsByRecipe: Map<string, PourVar[]>,
): { recipe_id: string; business_date: string; fl_oz: number; pour_units: number }[] {
  const ozByVar = new Map<string, number | null>();
  const recipeByVar = new Map<string, string>();
  for (const [recipeId, vars] of pourVarsByRecipe) {
    for (const v of vars) { ozByVar.set(v.id, v.oz); recipeByVar.set(v.id, recipeId); }
  }
  const acc = new Map<string, { recipe_id: string; business_date: string; fl_oz: number; pour_units: number }>();
  for (const [key, units] of salesByDay) {
    const [varId, day] = key.split("\t");
    const recipeId = recipeByVar.get(varId);
    if (!recipeId) continue;
    const oz = ozByVar.get(varId);
    const k = `${recipeId}\t${day}`;
    const row = acc.get(k) ?? { recipe_id: recipeId, business_date: day, fl_oz: 0, pour_units: 0 };
    row.pour_units += units;
    if (oz) row.fl_oz += units * oz;
    acc.set(k, row);
  }
  return [...acc.values()];
}

// Pure: varId → total units  ⇒  recipeId → { flOz, units }.
export function aggregatePourFlOzByRecipe(
  salesTotals: Map<string, number>,
  pourVarsByRecipe: Map<string, PourVar[]>,
): Map<string, { flOz: number; units: number }> {
  const out = new Map<string, { flOz: number; units: number }>();
  for (const [recipeId, vars] of pourVarsByRecipe) {
    let flOz = 0, units = 0;
    for (const v of vars) {
      const sold = salesTotals.get(v.id) ?? 0;
      units += sold;
      if (v.oz) flOz += sold * v.oz;
    }
    out.set(recipeId, { flOz, units });
  }
  return out;
}

// Ledger read: recipeId → average daily pour fl oz + units over the trailing window.
export async function fetchDailyPourSellThrough(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
  windowDays: number,
): Promise<Map<string, { dailyFlOz: number; dailyUnits: number }>> {
  const startDate = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("draft_pour_consumption")
    .select("recipe_id, fl_oz, pour_units")
    .gte("business_date", startDate);
  if (error) throw new Error(error.message);
  const sum = new Map<string, { flOz: number; units: number }>();
  for (const r of (data ?? []) as { recipe_id: string; fl_oz: number; pour_units: number }[]) {
    const e = sum.get(r.recipe_id) ?? { flOz: 0, units: 0 };
    e.flOz += Number(r.fl_oz); e.units += Number(r.pour_units);
    sum.set(r.recipe_id, e);
  }
  const out = new Map<string, { dailyFlOz: number; dailyUnits: number }>();
  for (const [recipeId, e] of sum) out.set(recipeId, { dailyFlOz: e.flOz / windowDays, dailyUnits: e.units / windowDays });
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/taproom/draftPourConsumption.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/taproom/draftPourConsumption.ts lib/taproom/draftPourConsumption.test.ts
git commit -m "feat(taproom): pour-consumption primitive (aggregation + ledger read)"
```

---

## Task 3: Populate the ledger from Square pour sales

**Files:**
- Create: `lib/production/syncDraftPourConsumption.ts`
- Test: `lib/production/syncDraftPourConsumption.test.ts`
- Modify: `lib/production/taproomConsumptionSync.ts` (call the new sync after the frozen work; additive only)

**Interfaces:**
- Consumes: `loadDraftPourVariations`, `aggregatePourFlOzByRecipeDay` (Task 2); `fetchOrderSalesByDay(startDate, endDate, ids)` from `lib/square/inventory`.
- Produces: `syncDraftPourConsumption(supabase, { days: number }): Promise<{ recipesTouched: number; rowsUpserted: number }>`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/square/inventory", () => ({ fetchOrderSalesByDay: vi.fn() }));
vi.mock("@/lib/taproom/draftPourConsumption", async (orig) => ({
  ...(await orig<typeof import("@/lib/taproom/draftPourConsumption")>()),
  loadDraftPourVariations: vi.fn(),
}));
import { syncDraftPourConsumption } from "./syncDraftPourConsumption";
import { fetchOrderSalesByDay } from "@/lib/square/inventory";
import { loadDraftPourVariations } from "@/lib/taproom/draftPourConsumption";

const sales = vi.mocked(fetchOrderSalesByDay);
const loadVars = vi.mocked(loadDraftPourVariations);

function fakeDb(sink: { upserts: unknown[] }) {
  return { from: () => ({ upsert: async (rows: unknown) => { sink.upserts.push(rows); return { error: null }; } }) } as never;
}

beforeEach(() => { sales.mockReset(); loadVars.mockReset(); });

it("upserts per-recipe-day pour fl oz from Square sales", async () => {
  loadVars.mockResolvedValue(new Map([["r1", [{ id: "v16", oz: 16 }]]]));
  sales.mockResolvedValue(new Map([["v16\t2026-07-01", 2]]));
  const sink = { upserts: [] as unknown[] };
  const res = await syncDraftPourConsumption(fakeDb(sink), { days: 30 });
  expect(sink.upserts[0]).toEqual([{ recipe_id: "r1", business_date: "2026-07-01", fl_oz: 32, pour_units: 2 }]);
  expect(res).toEqual({ recipesTouched: 1, rowsUpserted: 1 });
});

it("no-ops when there are no draft pour variations", async () => {
  loadVars.mockResolvedValue(new Map());
  const sink = { upserts: [] as unknown[] };
  const res = await syncDraftPourConsumption(fakeDb(sink), { days: 30 });
  expect(sales).not.toHaveBeenCalled();
  expect(res).toEqual({ recipesTouched: 0, rowsUpserted: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/syncDraftPourConsumption.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderSalesByDay } from "@/lib/square/inventory";
import { loadDraftPourVariations, aggregatePourFlOzByRecipeDay } from "@/lib/taproom/draftPourConsumption";

// Populate the operational pour ledger for the trailing `days` window. Additive and
// idempotent (upsert on recipe_id+business_date); never touches export_transactions.
export async function syncDraftPourConsumption(
  supabase: SupabaseClient,
  { days }: { days: number },
): Promise<{ recipesTouched: number; rowsUpserted: number }> {
  const pourVarsByRecipe = await loadDraftPourVariations(supabase);
  const varIds = [...pourVarsByRecipe.values()].flatMap((vs) => vs.map((v) => v.id));
  if (varIds.length === 0) return { recipesTouched: 0, rowsUpserted: 0 };

  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const salesByDay = await fetchOrderSalesByDay(start, end, varIds);

  const rows = aggregatePourFlOzByRecipeDay(salesByDay, pourVarsByRecipe);
  if (rows.length > 0) {
    const { error } = await supabase
      .from("draft_pour_consumption")
      .upsert(rows, { onConflict: "recipe_id,business_date" });
    if (error) throw new Error(error.message);
  }
  return { recipesTouched: pourVarsByRecipe.size, rowsUpserted: rows.length };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/production/syncDraftPourConsumption.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the sync entrypoint (additive, after the frozen work)**

In `lib/production/taproomConsumptionSync.ts`, inside `runTaproomConsumptionSync`, after the main unit loop completes and before the return (still inside the lock `try`), add a best-effort call so a pour-ledger failure never blocks the accounting sync:

```ts
    try {
      await syncDraftPourConsumption(supabase, { days });
    } catch (e) {
      packagingWarnings.add(`draft_pour_consumption sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
```

Add the import at the top:

```ts
import { syncDraftPourConsumption } from "./syncDraftPourConsumption";
```

- [ ] **Step 6: Run the sync test suite (unchanged behavior for accounting)**

Run: `npx vitest run lib/production/taproomConsumptionSync.test.ts`
Expected: PASS (existing tests untouched; the new call is mocked-inert or wrapped).

- [ ] **Step 7: Commit**

```bash
git add lib/production/syncDraftPourConsumption.ts lib/production/syncDraftPourConsumption.test.ts lib/production/taproomConsumptionSync.ts
git commit -m "feat(taproom): populate draft pour ledger from Square sales in the sync"
```

---

## Task 4: Point sell-through's draft oz/day at the ledger

**Files:**
- Modify: `lib/square/sell-through.ts:162-192` (draft branch)
- Test: co-located sell-through test (add a draft-branch case if none exists)

**Interfaces:**
- Consumes: `fetchDailyPourSellThrough(supabase, windowDays)` (Task 2). `current_qty` still from `fetchCurrentCounts` (Square live, unchanged).

- [ ] **Step 1: Write failing test asserting draft oz/day comes from the ledger, current from Square counts**

```ts
// In lib/square/sell-through.test.ts — mock fetchDailyPourSellThrough + fetchCurrentCounts,
// assert daily_sell_through_bbl derives from the ledger value and current_qty from counts.
// (Follow the file's existing mock setup for fetchCurrentCounts/fetchOrderSales.)
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/square/sell-through.test.ts`
Expected: FAIL — draft daily still computed from `salesTotals` siblings.

- [ ] **Step 3: Refactor the draft branch**

Replace the inline sibling-sales summation (`sell-through.ts:168-175`) so draft `daily_*` come from the ledger primitive. Load it once before the `links.map`:

```ts
import { fetchDailyPourSellThrough } from "@/lib/taproom/draftPourConsumption";
// ...
const pourDaily = packaging === undefined || packaging === "draft"
  ? await fetchDailyPourSellThrough(supabase, windowDays)
  : new Map<string, { dailyFlOz: number; dailyUnits: number }>();
```

Then in the draft branch:

```ts
    if (l.packaging === "draft") {
      const currentBbl = qty / BBL_TO_FL_OZ; // qty = base-variation IN_STOCK (fl oz), unchanged
      const daily = pourDaily.get(l.recipe_id as string) ?? { dailyFlOz: 0, dailyUnits: 0 };
      return {
        // ...unchanged fields...
        current_qty:               qty,
        current_bbl:               Number(currentBbl.toFixed(4)),
        daily_sell_through_units:  Number(daily.dailyUnits.toFixed(2)),
        daily_sell_through_bbl:    Number((daily.dailyFlOz / BBL_TO_FL_OZ).toFixed(4)),
        recipe:                    l.recipes ?? null,
      };
    }
```

Delete the now-dead draft sibling-loading blocks (`sell-through.ts:91-141`) and drop `allDraftSiblingIds` from `allVarIds` (keg/can sales still need `baseVarIds`). Keep `fetchCurrentCounts(baseVarIds)`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/square/sell-through.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/square/sell-through.ts lib/square/sell-through.test.ts
git commit -m "refactor(taproom): draft sell-through oz/day reads the pour ledger"
```

---

## Task 5: Point production demand at the primitive (fixes zero-draft-demand)

**Files:**
- Modify: `app/api/production/demand-calendar/route.ts:82-124`

**Interfaces:**
- Consumes: `fetchDailyPourSellThrough` (Task 2); `fetchCurrentCounts` (existing) for draft current fl oz.

- [ ] **Step 1: Replace the draft branch of the taproom-demand loop**

The current code parses oz from the base "Draft" variation name (no size token) → `ozPerUnit = null` → draft daily **and** current bbl are always 0. Fix: draft daily bbl from the ledger; draft current bbl straight from the base-variation fl-oz count.

```ts
import { fetchDailyPourSellThrough } from "@/lib/taproom/draftPourConsumption";
// ...
const pourDaily = await fetchDailyPourSellThrough(supabase, 28);
// inside the per-link loop:
if (packaging === "draft") {
  const daily = pourDaily.get(recipeId) ?? { dailyFlOz: 0, dailyUnits: 0 };
  taproomDailyBblByRecipe.set(recipeId, (taproomDailyBblByRecipe.get(recipeId) ?? 0) + daily.dailyFlOz / BBL_TO_FL_OZ);
  const currentQty = currentCounts.get(varId) ?? 0; // base draft variation = fl oz on hand
  taproomCurrentBblByRecipe.set(recipeId, (taproomCurrentBblByRecipe.get(recipeId) ?? 0) + currentQty / BBL_TO_FL_OZ);
  continue;
}
// keg/can branches unchanged (still use ozPerUnit from packaging_items / canOzPerUnit)
```

- [ ] **Step 2: Manually verify draft now contributes**

Run the dev server and hit `/api/production/demand-calendar` for a recipe on draft; confirm the taproom channel shows non-zero draft demand (previously 0). Record the before/after in the commit body.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/demand-calendar/route.ts
git commit -m "fix(production): draft taproom demand from pour ledger (was always zero)"
```

---

## Task 6: Revert #155 + live shrinkage from Square calculated on-hand

**Files:**
- Modify: `lib/production/taproomConsumptionSync.ts` (shrinkage block ~229–249; imports)
- Modify: `lib/square/inventory.ts` (remove #155 additions; restore `fetchPhysicalCounts`)
- Test: `lib/production/taproomConsumptionSync.test.ts`; new guardrail test `lib/production/taproomConsumptionSync.frozen.test.ts`

**Interfaces:**
- Consumes: `fetchCurrentCounts(ids)` (existing), `fetchPhysicalCounts(start, end, ids)` (restored) from `lib/square/inventory`.
- Produces: live shrinkage `remaining_fl_oz = fetchCurrentCounts([draftBaseVar])` captured before the recount.

- [ ] **Step 1: Write the frozen-write guardrail test**

```ts
// lib/production/taproomConsumptionSync.frozen.test.ts
// Asserts a draft_swap still drives the identical export/accounting writes: quantity =
// whole keg, recount fired to full, and NO change to the recordTaproomConsumption call shape.
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/square/taproomConsumption", () => ({ deriveTaproomConsumption: vi.fn() }));
vi.mock("@/lib/production/recordTaproomConsumption", () => ({ recordTaproomConsumption: vi.fn() }));
vi.mock("@/lib/square/inventory", () => ({ setPhysicalCount: vi.fn(), fetchCurrentCounts: vi.fn(), fetchPhysicalCounts: vi.fn() }));
vi.mock("@/lib/production/reconcileSquareCanInventory", () => ({ reconcileSquareCanInventory: vi.fn(async () => ({ writes: [], skips: [], warnings: [], applied: 0 })) }));
vi.mock("@/lib/production/syncDraftPourConsumption", () => ({ syncDraftPourConsumption: vi.fn(async () => ({ recipesTouched: 0, rowsUpserted: 0 })) }));
import { runTaproomConsumptionSync } from "./taproomConsumptionSync";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { deriveTaproomConsumption } from "@/lib/square/taproomConsumption";
import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";
// build a fakeSupabase like the existing suite; a swapUnit with recount {squareVariationId:"draft-sqvar", quantity:660, occurredAt}
it("draft_swap still records whole-keg consumption and recounts to full (accounting frozen)", async () => {
  vi.mocked(deriveTaproomConsumption).mockResolvedValue({ units: [/* swapUnit, quantity 1 whole keg */], discrepancies: [] });
  vi.mocked(recordTaproomConsumption).mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
  vi.mocked(fetchCurrentCounts).mockResolvedValue(new Map([["draft-sqvar", 34]]));
  // ...run, then:
  expect(recordTaproomConsumption).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 1, sourceRef: expect.stringContaining("sqtransfer:") }));
  expect(setPhysicalCount).toHaveBeenCalledWith("draft-sqvar", 660, expect.any(String));
});
```

- [ ] **Step 2: Run to verify it captures current behavior**

Run: `npx vitest run lib/production/taproomConsumptionSync.frozen.test.ts`
Expected: PASS before and after this task (proves accounting untouched).

- [ ] **Step 3: Revert `lib/square/inventory.ts` #155 additions**

Remove `InventoryChange`, `InventoryAdjustment`, `fetchInventoryChanges`; restore `fetchPhysicalCounts(startDate, endDate, catalogObjectIds?)` returning `PhysicalCount[]` filtered to `types: ["PHYSICAL_COUNT"]` (the pre-#155 version — physical counts genuinely exist on the base variation and Task 7 needs them).

- [ ] **Step 4: Rewrite the live shrinkage capture in `taproomConsumptionSync.ts`**

Replace the `reconstructRemainingFlOz`/`onHandAtOrBefore` capture with a read of Square's calculated on-hand for the draft base variation, captured **before** `setPhysicalCount` resets it to full. Delete `onHandAtOrBefore`, `reconstructRemainingFlOz`, `SHRINKAGE_LOOKBACK_DAYS`, and the `fetchInventoryChanges`/`InventoryChange` import.

```ts
        try {
          const counts = await fetchCurrentCounts([u.recount.squareVariationId]);
          const remaining = counts.get(u.recount.squareVariationId);
          if (remaining !== undefined) {
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
          shrinkageWarnings.push({ kind: "shrinkage_capture_failed", sourceRef: u.sourceRef, detail: e instanceof Error ? e.message : String(e) });
        }
```

Update the import: `import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";`

- [ ] **Step 5: Update the sync unit tests**

In `taproomConsumptionSync.test.ts`: swap the `fetchInventoryChanges` mock for `fetchCurrentCounts`; delete the `onHandAtOrBefore` describe block; update the "captures shrinkage" test so `fetchCurrentCounts.mockResolvedValue(new Map([["draft-sqvar", 45]]))` yields `remaining_fl_oz: 45`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run lib/production/taproomConsumptionSync.test.ts lib/production/taproomConsumptionSync.frozen.test.ts lib/square/inventory.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/production/taproomConsumptionSync.ts lib/square/inventory.ts lib/production/taproomConsumptionSync.test.ts lib/production/taproomConsumptionSync.frozen.test.ts
git commit -m "fix(taproom): capture live shrinkage from Square on-hand; revert #155 changes-reconstruction"
```

---

## Task 7: Rebuild the historical backfill on `last_recount − pours_since`

**Files:**
- Modify: `lib/production/backfillDraftShrinkage.ts`
- Test: `lib/production/backfillDraftShrinkage.test.ts`

**Interfaces:**
- Consumes: `fetchPhysicalCounts(start, end, [baseVar])` (restored, Task 6) for the anchoring recount; `fetchOrderSales(start, end, pourVarIds)` + `aggregatePourFlOzByRecipe` (Task 2) for pours in the window; `loadDraftPourVariations` (Task 2).
- Produces: same `ShrinkageBackfillResult` shape as today, with `remaining_fl_oz = max(0, lastRecountBeforeSwap − poursBetween(recountTime, swapTime))`.

- [ ] **Step 1: Write failing test for the reconstruction**

```ts
// Given a row occurring at T_swap, a physical count of 658 at T_recount < T_swap on the
// base var, and pours of 624 fl oz between → remaining 34. Mock fetchPhysicalCounts,
// fetchOrderSales, loadDraftPourVariations; assert the row is updated to 34.
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/backfillDraftShrinkage.test.ts`
Expected: FAIL — still reconstructing from the reverted helper.

- [ ] **Step 3: Reimplement the per-row reconstruction**

For each `draft_swap_shrinkage` row: resolve the recipe's draft base variation (`recipe_square_links` packaging=draft) and its pour siblings (`loadDraftPourVariations`). Fetch base-variation physical counts in a 60-day window ending at the swap; take the latest with `occurred_at < swap.occurred_at` as `(recountTime, recountQty)`. Fetch pour-variation sales in `(recountTime, swapTime]`, aggregate to fl oz via `aggregatePourFlOzByRecipe`. `newVal = max(0, recountQty − pourFlOz)`. Keep the existing statuses (`updated`/`would_update`/`unchanged`/`skipped_no_sku`/`skipped_no_baseline`/`error`), where `skipped_no_baseline` now means "no physical count precedes the swap." `full_fl_oz` stays untouched. Dry-run unless `apply`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/production/backfillDraftShrinkage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/backfillDraftShrinkage.ts lib/production/backfillDraftShrinkage.test.ts
git commit -m "fix(taproom): backfill shrinkage as last_recount minus pours_since"
```

---

## Task 8: Full verification + operational rollout (human-gated)

**Files:** none (verification + ops).

- [ ] **Step 1: Full suite + typecheck + build**

Run: `npm run test && npx tsc --noEmit && npm run build`
Expected: all pass; routes `/api/taproom/draft-stats`, `/api/taproom/draft-stats/backfill`, `/api/production/demand-calendar` compile.

- [ ] **Step 2: Confirm accounting is byte-identical**

The frozen guardrail test (Task 6) passes. Manually diff a `git log -p` of this branch to confirm zero edits to `exportTransactionWriter.ts` / `recordTaproomConsumption.ts` / `shipmentWriter.ts`.

- [ ] **Step 3: Apply the migration to prod (human-authorized only)**

Per repo policy, the human applies `20260727_draft_pour_consumption.sql` to prod after backup. Do not auto-apply.

- [ ] **Step 4: Backfill the ledger, then re-run the sync once**

After the table exists, run one sync (or a one-off `syncDraftPourConsumption(admin, { days: 90 })`) to populate history, then load the Draft Stats tab and confirm oz/day + fl-oz-available render.

- [ ] **Step 5: Run the shrinkage backfill dry-run, review, then apply**

`POST /api/taproom/draft-stats/backfill` (dry-run) → confirm the Carolina 7/10 row moves 658 → 34 and no value exceeds its `full_fl_oz`; then `{ "apply": true }`.

- [ ] **Step 6: Resume the accreted-backfill cleanup sweep** (separate follow-up, tracked earlier).

---

## Self-Review Notes

- **Spec coverage:** persist ✓ (Task 1/3), unify sell-through ✓ (Task 4) + demand ✓ (Task 5), fold #155 revert ✓ (Task 6), shrinkage correct live ✓ (Task 6) + historical ✓ (Task 7), accounting frozen ✓ (Global Constraints + Task 6 guardrail).
- **Type consistency:** `fetchDailyPourSellThrough → { dailyFlOz, dailyUnits }` used identically in Tasks 4/5; `aggregatePourFlOzByRecipe → { flOz, units }` used in Task 7; `PourVar { id, oz }` shared across Tasks 2/3/7.
- **Known limitation (documented, not solved):** a beer simultaneously on two taps shares one set of pour variations, so per-tap pour split isn't possible; shrinkage stays recipe-grain, matching today's model.
