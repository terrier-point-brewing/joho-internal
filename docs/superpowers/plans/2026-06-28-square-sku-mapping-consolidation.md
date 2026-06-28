# Square SKU Mapping Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three Square-mapping tables (`recipe_square_links`, `invoice_item_mappings`, `square_catalog_variations`) so every feature (taproom, intake, export, finance) resolves Square SKUs through one code path, with the catalog mirror as the single source of catalog metadata + GL account + inventory-unit semantics, and product mappings keyed at the production-native `packaging_variation` grain.

**Architecture:** Keep the two mapping tables physically separate but put one resolver module (`lib/square/skuMappings.ts`) in front of them so no feature queries them directly (the user's "Option B"). Move inventory-unit semantics onto `square_catalog_variations` so the duplicated name-parsers collapse to one (the user's "Option A"). Re-grain `recipe_square_links` from `(recipe_id, container, format)` to `variation_id` for keg/can rows (fixing a real collision where two beer-specific variations sharing a container+format — e.g. Epic Hazy "Printed Can" vs "Be Like Mike Labeled Can" — cannot both be linked today), while keeping draft as a recipe-grain row. Rework the `RecipeLinkMatrix` tool to variation grain with a completeness view and bulk-apply, since hand-mapping ~51-and-growing variations one cell at a time is unworkable.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres, raw Square `fetch` client, TanStack Query, Tailwind v4. New: Vitest (pure-logic unit tests only).

## Global Constraints

- Next.js version has breaking changes vs. training data — read `node_modules/next/dist/docs/` before touching routing/conventions (per `AGENTS.md`).
- No business logic in `app/api/**` or page components — logic lives in `lib/` (per `CLAUDE.md` Architecture Priorities).
- Auth/role checks only via `lib/auth.ts` (`requireRole`); never roll your own.
- Pick the Supabase client matching context: `lib/supabase/server.ts` (route handlers/Server Components), `lib/supabase/browser.ts` (Client Components), `lib/supabase/admin.ts` (privileged). Never the browser client in a route handler.
- Schema source of truth is `supabase/migrations/`. Add NEW migration files; never hand-edit existing ones. New migrations must sort AFTER the latest existing file — the latest is `20260708_*`, so name new files `20260709_*` (the repo's migration dates run ahead of the system clock; preserve ascending order, do not use today's date if it would sort earlier).
- Square single location: `LZ8TH4A632YW0`. Square API version `2025-04-16`.
- Reports (`lib/reports/**`, `app/reports/**`) are OUT OF SCOPE for this plan — they need a separate rebuild. Do not modify them. `lib/reports/bbl-tracker.ts`'s `canOzPerUnit` stays in place for now even though it duplicates parser logic; only `lib/square/sell-through.ts`'s `ozPerSale` is consolidated here.
- Migrations are applied to the remote Supabase project (`drlsazatrcrdwaihjmex`) — there is no local DB. Apply via the Supabase MCP `apply_migration` tool (or the user's migration workflow) and verify with `execute_sql`.

---

## File Structure

**New files:**
- `vitest.config.ts` — Vitest config scoped to `lib/**`.
- `lib/square/catalogUnits.ts` — single volume/unit parser (replaces `ozPerSale`; mirror-population helper).
- `lib/square/catalogUnits.test.ts` — parser unit tests.
- `lib/square/skuMappings.ts` — the unified resolver (product / service / catalog lookups).
- `lib/square/skuMappings.test.ts` — pure-helper unit tests (service-mapping fallback selection).
- `lib/production/recipeLinkMatrix.test.ts` — variation-grain matrix builder tests.
- `supabase/migrations/20260709_catalog_variation_units.sql` — inventory-unit columns on the mirror.
- `supabase/migrations/20260710_recipe_square_links_variation_grain.sql` — `variation_id` + re-keyed indexes + safe backfill.
- `supabase/migrations/20260711_invoice_item_mappings_catalog_fk.sql` — FK from fee mappings into the mirror.

**Modified files:**
- `app/api/finance/sync-catalog/route.ts` — populate the new mirror unit columns during sync.
- `app/api/production/recipe-square-links/route.ts` — accept/return `variation_id`; keep draft recipe-grain.
- `lib/production/exportInvoicePreview.ts` — product lines via the resolver at variation grain.
- `lib/square/sell-through.ts` — read unit semantics from the mirror instead of name-parsing.
- `lib/production/recipeLinkMatrix.ts` — rebuild at variation grain (one row per `recipe_packaging_variation`).
- `app/production/components/RecipeLinkMatrix.tsx` — render variation-grain list with completeness + bulk-apply.
- `app/production/types.ts` — extend `RecipeSquareLinkRow` with `variation_id`; add matrix types.
- `package.json` — add `test` script + Vitest devDeps.

---

## Task 1: Vitest harness for pure-logic modules

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + devDependencies)
- Test: `lib/square/catalogUnits.test.ts` (created in Task 2; this task only proves the runner works)

**Interfaces:**
- Produces: an `npm run test` script running `vitest run` over `lib/**/*.test.ts`. Later tasks rely on this command existing.

- [ ] **Step 1: Install Vitest**

Run:
```bash
npm install -D vitest@^2
```
Expected: `vitest` added under devDependencies, install completes with no errors.

- [ ] **Step 2: Create the Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Add the test script**

In `package.json`, add to the `scripts` block (keep existing entries):
```json
"test": "vitest run"
```

- [ ] **Step 4: Add a temporary smoke test**

Create `lib/square/_smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("vitest harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the test to verify the harness works**

Run: `npm run test`
Expected: PASS — 1 test passed.

- [ ] **Step 6: Remove the smoke test and commit**

```bash
rm lib/square/_smoke.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest harness for lib pure-logic tests"
```

---

## Task 2: Single volume/unit parser (`catalogUnits.ts`)

**Files:**
- Create: `lib/square/catalogUnits.ts`
- Test: `lib/square/catalogUnits.test.ts`

**Interfaces:**
- Produces:
  - `type InventoryUnit = "fl_oz" | "each"`
  - `function volumeFlOzPerUnit(variationName: string | null): number | null` — total fluid ounces ONE sold unit of this variation represents. Pours (`"Draft - 16oz"` → 16), can multipacks (`"12oz 4-Pack"` → 48, `"16oz Case"` → 384), kegs (`"1/6 Keg"` → 661, `"1/4 Keg"` → 992, `"1/2 Keg"` → 1984). Returns `null` when unknown (e.g. a bare `"Draft"`/`"Regular"` base variation).
  - `function inferInventoryUnit(variationName: string | null): InventoryUnit | null` — `"fl_oz"` for keg-volume base variations tracked by fluid ounce (a bare `"Draft"`/`"Regular"` with no size token), `"each"` for anything with a unit/pack/keg token, `null` when indeterminate.
- Consumed by: Task 4 (sync population), Task 9 (sell-through).

- [ ] **Step 1: Write the failing test**

Create `lib/square/catalogUnits.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { volumeFlOzPerUnit, inferInventoryUnit } from "./catalogUnits";

describe("volumeFlOzPerUnit", () => {
  it("parses a single pour size", () => {
    expect(volumeFlOzPerUnit("Draft - 16oz")).toBe(16);
  });
  it("parses a 4-pack of 12oz cans", () => {
    expect(volumeFlOzPerUnit("12oz 4-Pack")).toBe(48);
  });
  it("parses a 6-pack of 12oz cans", () => {
    expect(volumeFlOzPerUnit("12oz 6-Pack")).toBe(72);
  });
  it("parses a case as 24 units", () => {
    expect(volumeFlOzPerUnit("16oz Case")).toBe(384);
  });
  it("parses keg sizes", () => {
    expect(volumeFlOzPerUnit("1/6 Keg")).toBe(661);
    expect(volumeFlOzPerUnit("1/4 Keg")).toBe(992);
    expect(volumeFlOzPerUnit("1/2 Keg")).toBe(1984);
  });
  it("returns null for a bare base variation", () => {
    expect(volumeFlOzPerUnit("Draft")).toBeNull();
    expect(volumeFlOzPerUnit("Regular")).toBeNull();
    expect(volumeFlOzPerUnit(null)).toBeNull();
  });
});

describe("inferInventoryUnit", () => {
  it("treats a bare base variation as fl_oz", () => {
    expect(inferInventoryUnit("Draft")).toBe("fl_oz");
    expect(inferInventoryUnit("Regular")).toBe("fl_oz");
  });
  it("treats sized/packed variations as each", () => {
    expect(inferInventoryUnit("1/6 Keg")).toBe("each");
    expect(inferInventoryUnit("12oz 4-Pack")).toBe("each");
    expect(inferInventoryUnit("Draft - 16oz")).toBe("each");
  });
  it("returns null for empty", () => {
    expect(inferInventoryUnit(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- catalogUnits`
Expected: FAIL — cannot find module `./catalogUnits`.

- [ ] **Step 3: Implement the parser**

Create `lib/square/catalogUnits.ts`:
```ts
/**
 * Single source of truth for "how much volume does one sold unit of a Square
 * variation represent" and "is this variation counted by fluid ounce or by
 * each". Replaces the per-feature name-parsers (sell-through's ozPerSale).
 *
 * lib/reports/bbl-tracker.ts's canOzPerUnit intentionally stays separate for
 * now (reports are out of scope for the mapping consolidation) — do not import
 * this from there yet.
 */

export type InventoryUnit = "fl_oz" | "each";

const KEG_FL_OZ: Record<string, number> = {
  "1/2 Keg": 1984,
  "1/4 Keg": 992,
  "1/6 Keg": 661,
};

const KEG_NAME = /\b(1\/2|1\/4|1\/6)\s*Keg\b/i;
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*oz/i;
const PACK_TOKEN = /(\d+)[\s-]?(?:pack|pk)\b/i;
const CASE_TOKEN = /\bcase\b/i;

/** Total fluid ounces one sold unit of this variation represents, or null if unknown. */
export function volumeFlOzPerUnit(variationName: string | null): number | null {
  if (!variationName) return null;

  const kegMatch = variationName.match(KEG_NAME);
  if (kegMatch) {
    const key = `${kegMatch[1]} Keg`;
    return KEG_FL_OZ[key] ?? null;
  }

  const sizeMatch = variationName.match(SIZE_TOKEN);
  if (!sizeMatch) return null;
  const oz = parseFloat(sizeMatch[1]);

  if (CASE_TOKEN.test(variationName)) return 24 * oz;
  const packMatch = variationName.match(PACK_TOKEN);
  if (packMatch) return parseInt(packMatch[1], 10) * oz;
  return oz;
}

/** Whether Square tracks stock for this variation by fluid ounce or by each. */
export function inferInventoryUnit(variationName: string | null): InventoryUnit | null {
  if (!variationName) return null;
  if (KEG_NAME.test(variationName)) return "each";
  if (SIZE_TOKEN.test(variationName) || PACK_TOKEN.test(variationName) || CASE_TOKEN.test(variationName)) {
    return "each";
  }
  // Bare base variation (no size/pack token) — the fl-oz-tracked draft base.
  return "fl_oz";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- catalogUnits`
Expected: PASS — all assertions green.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add lib/square/catalogUnits.ts lib/square/catalogUnits.test.ts
git commit -m "feat(square): add consolidated catalog volume/unit parser"
```

---

## Task 3: Migration — inventory-unit columns on the catalog mirror

**Files:**
- Create: `supabase/migrations/20260709_catalog_variation_units.sql`

**Interfaces:**
- Produces: two nullable columns on `public.square_catalog_variations`: `inventory_unit text` (check `in ('fl_oz','each')`) and `volume_fl_oz_per_unit numeric`. Task 4 populates them; Task 9 reads them.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260709_catalog_variation_units.sql`:
```sql
-- Inventory-unit semantics on the catalog mirror. Centralizes "how is this
-- variation counted (fl oz vs each)" and "how much volume does one sold unit
-- represent" so consumers (sell-through, taproom inventory) stop re-parsing
-- variation names independently. Populated by the catalog sync route via
-- lib/square/catalogUnits.ts. Nullable: a value is only known for beer SKUs
-- whose names carry size/pack/keg tokens.

alter table public.square_catalog_variations
  add column if not exists inventory_unit text
    check (inventory_unit in ('fl_oz', 'each')),
  add column if not exists volume_fl_oz_per_unit numeric;
```

- [ ] **Step 2: Apply the migration**

Apply `supabase/migrations/20260709_catalog_variation_units.sql` to project `drlsazatrcrdwaihjmex` via the Supabase MCP `apply_migration` tool (name: `catalog_variation_units`).

- [ ] **Step 3: Verify the columns exist**

Run via Supabase MCP `execute_sql`:
```sql
select column_name, data_type
from information_schema.columns
where table_name = 'square_catalog_variations'
  and column_name in ('inventory_unit', 'volume_fl_oz_per_unit')
order by column_name;
```
Expected: two rows — `inventory_unit | text` and `volume_fl_oz_per_unit | numeric`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260709_catalog_variation_units.sql
git commit -m "feat(db): add inventory-unit columns to square_catalog_variations"
```

---

## Task 4: Populate mirror unit columns during catalog sync

**Files:**
- Modify: `app/api/finance/sync-catalog/route.ts:64-84`

**Interfaces:**
- Consumes: `volumeFlOzPerUnit`, `inferInventoryUnit` from `lib/square/catalogUnits.ts` (Task 2); the columns from Task 3.
- Produces: every synced variation row carries `inventory_unit` + `volume_fl_oz_per_unit` derived from its name.

- [ ] **Step 1: Add the import**

In `app/api/finance/sync-catalog/route.ts`, add after the existing imports (below line 4):
```ts
import { volumeFlOzPerUnit, inferInventoryUnit } from "@/lib/square/catalogUnits";
```

- [ ] **Step 2: Populate the two columns in the variation upsert rows**

In `app/api/finance/sync-catalog/route.ts`, replace the variation row mapping (currently lines 68-83, the `return (item.item_data.variations ?? []).map((v) => ({ ... }))` block) with:
```ts
    return (item.item_data.variations ?? []).map((v) => {
      const variationName = v.item_variation_data.name;
      return {
        square_variation_id:   v.id,
        catalog_item_id:       catalogItemId,
        square_item_id:        item.id,
        variation_name:        variationName,
        sku:                   v.item_variation_data.sku ?? null,
        upc:                   v.item_variation_data.upc ?? null,
        price_amount:          v.item_variation_data.price_money?.amount ?? null,
        price_currency:        v.item_variation_data.price_money?.currency ?? null,
        pricing_type:          v.item_variation_data.pricing_type ?? null,
        track_inventory:       v.item_variation_data.track_inventory ?? null,
        sellable:              v.item_variation_data.sellable ?? null,
        stockable:             v.item_variation_data.stockable ?? null,
        service_duration_ms:   v.item_variation_data.service_duration ?? null,
        inventory_unit:        inferInventoryUnit(variationName),
        volume_fl_oz_per_unit: volumeFlOzPerUnit(variationName),
        synced_at:             now,
      };
    });
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run lint`
Expected: no errors in `sync-catalog/route.ts`.
Run: `npm run build`
Expected: build succeeds (type-checks the route).

- [ ] **Step 4: Run the sync and verify population**

Trigger a catalog sync (POST `/api/finance/sync-catalog` as an admin via the running app, or have the user click the existing "Sync catalog" control). Then verify via Supabase MCP `execute_sql`:
```sql
select variation_name, inventory_unit, volume_fl_oz_per_unit
from public.square_catalog_variations
where variation_name ~* 'keg|pack|case|oz'
order by variation_name
limit 15;
```
Expected: keg rows show `each` + 661/992/1984; pack/case rows show `each` + computed oz; bare base draft rows show `fl_oz` + null.

- [ ] **Step 5: Commit**

```bash
git add app/api/finance/sync-catalog/route.ts
git commit -m "feat(square): populate inventory-unit columns during catalog sync"
```

---

## Task 5: Migration — re-grain `recipe_square_links` to `variation_id`

**Files:**
- Create: `supabase/migrations/20260710_recipe_square_links_variation_grain.sql`

**Interfaces:**
- Produces: `recipe_square_links.variation_id uuid` (FK → `packaging_variations`, `on delete cascade`); partial unique `rsl_variation_uniq` on `(variation_id)`; partial unique `rsl_draft_uniq` on `(recipe_id)` where `packaging='draft'`; the old container-based uniques dropped. Unambiguous existing keg/can rows backfilled to `variation_id`.
- Consumed by: Task 6 (route), Task 7 (resolver), Task 10 (matrix).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260710_recipe_square_links_variation_grain.sql`:
```sql
-- Re-grain the product mapping from (recipe_id, container, format) to the
-- production-native packaging_variation grain. The old key cannot represent
-- two beer-specific variations that share a container+format but sell as
-- different Square SKUs (e.g. Epic Hazy "Printed Can" vs "Be Like Mike
-- Labeled Can", both 16oz can — migration 20260707). variation_id fixes that.
--
-- Draft is NOT a packaging_variation (it's poured, not vesselled) and stays a
-- recipe-grain row: variation_id NULL, keyed by (recipe_id) where
-- packaging='draft'. Keg/can rows become keyed by variation_id.
--
-- Backfill only sets variation_id where exactly ONE active variation matches a
-- link's (recipe, container, format); genuinely ambiguous rows (the collision
-- case above) are left NULL for the management UI to resolve.

alter table public.recipe_square_links
  add column if not exists variation_id uuid
    references public.packaging_variations(id) on delete cascade;

-- Backfill unambiguous keg/can links. Kegs carry packaging_format NULL in the
-- link but format='loose' on the seeded keg variation, so coalesce to 'loose'.
update public.recipe_square_links rsl
set variation_id = match.variation_id
from (
  select l.id as link_id, pv.id as variation_id
  from public.recipe_square_links l
  join public.recipe_packaging_variations rpv on rpv.recipe_id = l.recipe_id
  join public.packaging_variations pv
    on pv.id = rpv.variation_id
   and pv.is_active = true
   and pv.container_id = l.packaging_item_id
   and pv.format = coalesce(l.packaging_format, 'loose')
  where l.packaging in ('keg', 'can')
    and l.packaging_item_id is not null
  group by l.id, pv.id
  having count(*) over (partition by l.id) = 1
) as match
where rsl.id = match.link_id
  and rsl.variation_id is null;

-- Drop the old container-based unique indexes (they enforce the collision).
drop index if exists rsl_keg_uniq;
drop index if exists rsl_can_format_uniq;

-- One product link per packaging_variation.
create unique index if not exists rsl_variation_uniq
  on public.recipe_square_links (variation_id)
  where variation_id is not null;

-- One draft link per recipe.
create unique index if not exists rsl_draft_uniq
  on public.recipe_square_links (recipe_id)
  where packaging = 'draft';
```

> NOTE on `count(*) over (...) having` — Postgres allows `having` to reference a window only via a subquery. The form above uses the window inside the derived table's `having`, which Postgres rejects. Use the rewritten, portable version below instead (it is the one to paste):

```sql
-- (Use THIS backfill block in place of the inline one above.)
update public.recipe_square_links rsl
set variation_id = u.variation_id
from (
  select link_id, min(variation_id) as variation_id
  from (
    select l.id as link_id, pv.id as variation_id
    from public.recipe_square_links l
    join public.recipe_packaging_variations rpv on rpv.recipe_id = l.recipe_id
    join public.packaging_variations pv
      on pv.id = rpv.variation_id
     and pv.is_active = true
     and pv.container_id = l.packaging_item_id
     and pv.format = coalesce(l.packaging_format, 'loose')
    where l.packaging in ('keg', 'can')
      and l.packaging_item_id is not null
  ) candidates
  group by link_id
  having count(*) = 1
) u
where rsl.id = u.link_id
  and rsl.variation_id is null;
```

When writing the file, include the column add, then ONLY the second (portable) backfill block, then the index changes. Do not include the first backfill block (it is shown only to explain the fix).

- [ ] **Step 2: Apply the migration**

Apply `supabase/migrations/20260710_recipe_square_links_variation_grain.sql` to project `drlsazatrcrdwaihjmex` via Supabase MCP `apply_migration` (name: `recipe_square_links_variation_grain`).

- [ ] **Step 3: Verify backfill + indexes**

Run via Supabase MCP `execute_sql`:
```sql
select packaging,
       count(*) as rows,
       count(variation_id) as with_variation
from public.recipe_square_links
group by packaging
order by packaging;
```
Expected: `draft` rows have `with_variation = 0`; `keg`/`can` rows have most (unambiguous ones) with a variation_id, possibly a few NULL (ambiguous, expected).

```sql
select indexname from pg_indexes
where tablename = 'recipe_square_links'
  and indexname in ('rsl_variation_uniq', 'rsl_draft_uniq', 'rsl_keg_uniq', 'rsl_can_format_uniq')
order by indexname;
```
Expected: `rsl_draft_uniq` and `rsl_variation_uniq` present; `rsl_keg_uniq` and `rsl_can_format_uniq` absent.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260710_recipe_square_links_variation_grain.sql
git commit -m "feat(db): re-grain recipe_square_links to packaging_variation"
```

---

## Task 6: Update the recipe-square-links route for variation grain

**Files:**
- Modify: `app/api/production/recipe-square-links/route.ts`
- Modify: `app/production/types.ts:318-330` (extend `RecipeSquareLinkRow`)

**Interfaces:**
- Consumes: `variation_id` column from Task 5.
- Produces: POST accepts `{ recipe_id, packaging, variation_id?, square_variation_id, square_item_id?, variation_name?, item_name? }`. For `packaging in ('keg','can')`, `variation_id` is REQUIRED and `packaging_item_id`/`packaging_format` are no longer accepted from the client (derived server-side from the variation for backward-compatible storage). For `packaging='draft'`, `variation_id` must be absent. GET returns rows including `variation_id` and a joined `packaging_variations(id, name)`.
- Consumed by: Task 11 (UI posts `variation_id`).

- [ ] **Step 1: Extend the row type**

In `app/production/types.ts`, replace the `RecipeSquareLinkRow` interface (lines 318-330) with:
```ts
export interface RecipeSquareLinkRow {
  id: string;
  recipe_id: string;
  packaging: "draft" | "keg" | "can";
  variation_id: string | null;
  packaging_item_id: string | null;
  packaging_format: string | null;
  square_variation_id: string;
  square_item_id: string | null;
  variation_name: string | null;
  item_name: string | null;
  created_at: string;
  recipes?: { beer_name: string } | null;
  packaging_items?: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
  packaging_variations?: { id: string; name: string } | null;
}
```

- [ ] **Step 2: Update GET to select variation join**

In `app/api/production/recipe-square-links/route.ts`, replace the GET select (line 12) with:
```ts
    .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz), packaging_variations(id, name)")
```

- [ ] **Step 3: Replace the POST body parsing + validation**

In `app/api/production/recipe-square-links/route.ts`, replace the POST handler body from the destructure through the keg/can validation (currently lines 23-64) with:
```ts
  const {
    recipe_id, packaging, variation_id,
    square_variation_id, square_item_id, variation_name, item_name,
  } = await req.json();

  if (!recipe_id || !packaging || !square_variation_id) {
    return NextResponse.json(
      { error: "recipe_id, packaging, and square_variation_id are required" },
      { status: 400 }
    );
  }

  if (packaging !== "draft" && packaging !== "keg" && packaging !== "can") {
    return NextResponse.json({ error: "packaging must be 'draft', 'keg', or 'can'" }, { status: 400 });
  }

  // keg/can are variation-grain; draft is recipe-grain
  if ((packaging === "keg" || packaging === "can") && !variation_id) {
    return NextResponse.json(
      { error: "variation_id is required for keg and can links" },
      { status: 400 }
    );
  }
  if (packaging === "draft" && variation_id) {
    return NextResponse.json(
      { error: "draft links must not carry a variation_id" },
      { status: 400 }
    );
  }

  // Derive container + format from the variation so the denormalized columns
  // stay populated for any legacy reader. Source of truth is variation_id.
  let derivedItemId: string | null = null;
  let derivedFormat: string | null = null;
  if (variation_id) {
    const { data: pv, error: pvErr } = await supabase
      .from("packaging_variations")
      .select("container_id, format")
      .eq("id", variation_id)
      .single();
    if (pvErr || !pv) {
      return NextResponse.json({ error: "variation_id not found" }, { status: 400 });
    }
    derivedItemId = pv.container_id;
    derivedFormat = pv.format;
  }
```

- [ ] **Step 4: Update the insert payload**

In `app/api/production/recipe-square-links/route.ts`, replace the insert object (currently lines 88-101, the `.insert({ ... })` argument) with:
```ts
    .insert({
      recipe_id,
      packaging,
      variation_id: variation_id || null,
      packaging_item_id: derivedItemId,
      packaging_format: derivedFormat,
      square_variation_id,
      square_item_id: square_item_id || null,
      variation_name: variation_name || null,
      item_name: item_name || null,
      catalog_item_id,
      catalog_variation_id,
    })
```

- [ ] **Step 5: Typecheck + lint**

Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

> The matrix UI (`RecipeLinkMatrix.tsx`) still posts the OLD shape at this point and will be updated in Task 11. That is expected — do not "fix" it here; it is covered by a later task and the build still passes because the POST body is `any`-typed JSON.

- [ ] **Step 6: Commit**

```bash
git add app/api/production/recipe-square-links/route.ts app/production/types.ts
git commit -m "feat(production): variation-grain recipe-square-links route"
```

---

## Task 7: The unified resolver (`lib/square/skuMappings.ts`)

**Files:**
- Create: `lib/square/skuMappings.ts`
- Test: `lib/square/skuMappings.test.ts`

**Interfaces:**
- Consumes: `recipe_square_links.variation_id` (Task 5), `invoice_item_mappings`, `square_catalog_variations` + its unit columns (Task 3).
- Produces:
  - `type SkuDbClient = { from: (table: string) => any }`
  - `interface ProductSku { squareVariationId: string; squareItemId: string | null; catalogVariationId: string | null; itemName: string | null; variationName: string | null; }`
  - `interface ServiceSku { squareVariationId: string | null; squareItemId: string | null; squareDiscountId: string | null; displayName: string | null; }`
  - `interface CatalogMeta { catalogVariationId: string; squareVariationId: string; itemName: string | null; variationName: string | null; inventoryUnit: "fl_oz" | "each" | null; volumeFlOzPerUnit: number | null; chartOfAccountsId: string | null; }`
  - `interface ServiceMappingRow { service_type: string; partner_id: string | null; packaging_item_id: string | null; packaging_format: string | null; square_catalog_item_id: string | null; square_catalog_variation_id: string | null; square_catalog_discount_id: string | null; display_name: string | null; }`
  - `function selectServiceMapping(rows: ServiceMappingRow[], c: { serviceType: string; partnerId: string | null; packagingItemId: string | null; packagingFormat: string | null }): ServiceMappingRow | null` — PURE; partner-specific row wins over the `partner_id IS NULL` default.
  - `async function resolveProductSku(db, args: { kind: "draft"; recipeId: string } | { kind: "packaged"; variationId: string }): Promise<ProductSku | null>`
  - `async function resolveServiceSku(db, args: { serviceType: string; partnerId: string | null; packagingItemId?: string | null; packagingFormat?: string | null }): Promise<ServiceSku | null>`
  - `async function resolveCatalog(db, squareVariationId: string): Promise<CatalogMeta | null>`
- Consumed by: Task 8 (export invoice), Task 9 (sell-through).

- [ ] **Step 1: Write the failing test (pure selection helper)**

Create `lib/square/skuMappings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { selectServiceMapping, type ServiceMappingRow } from "./skuMappings";

function row(p: Partial<ServiceMappingRow>): ServiceMappingRow {
  return {
    service_type: "packaging_fee",
    partner_id: null,
    packaging_item_id: null,
    packaging_format: null,
    square_catalog_item_id: null,
    square_catalog_variation_id: null,
    square_catalog_discount_id: null,
    display_name: null,
    ...p,
  };
}

describe("selectServiceMapping", () => {
  const rows = [
    row({ service_type: "packaging_fee", partner_id: null, packaging_item_id: "c1", packaging_format: "case", display_name: "default-case" }),
    row({ service_type: "packaging_fee", partner_id: "p1", packaging_item_id: "c1", packaging_format: "case", display_name: "partner-case" }),
    row({ service_type: "keg_cleaning", partner_id: null, display_name: "kegclean" }),
  ];

  it("prefers the partner-specific row over the default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p1", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("partner-case");
  });

  it("falls back to the partner_id-null default", () => {
    const m = selectServiceMapping(rows, { serviceType: "packaging_fee", partnerId: "p2", packagingItemId: "c1", packagingFormat: "case" });
    expect(m?.display_name).toBe("default-case");
  });

  it("matches container-less services", () => {
    const m = selectServiceMapping(rows, { serviceType: "keg_cleaning", partnerId: "p1", packagingItemId: null, packagingFormat: null });
    expect(m?.display_name).toBe("kegclean");
  });

  it("returns null when nothing matches", () => {
    const m = selectServiceMapping(rows, { serviceType: "forklift", partnerId: null, packagingItemId: null, packagingFormat: null });
    expect(m).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- skuMappings`
Expected: FAIL — cannot find module `./skuMappings`.

- [ ] **Step 3: Implement the resolver**

Create `lib/square/skuMappings.ts`:
```ts
/**
 * Unified Square SKU resolver. The ONLY module features should call to answer
 * "what Square SKU represents this physical thing?". It hides which underlying
 * table is consulted:
 *   - product SKUs  → recipe_square_links (variation-grain for keg/can,
 *                     recipe-grain for draft)
 *   - service/fee   → invoice_item_mappings (coarse: service + partner +
 *                     container + format; beer-agnostic by design)
 *   - catalog meta  → square_catalog_variations (the mirror: names, GL account,
 *                     inventory-unit semantics)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SkuDbClient = { from: (table: string) => any };

export interface ProductSku {
  squareVariationId: string;
  squareItemId: string | null;
  catalogVariationId: string | null;
  itemName: string | null;
  variationName: string | null;
}

export interface ServiceSku {
  squareVariationId: string | null;
  squareItemId: string | null;
  squareDiscountId: string | null;
  displayName: string | null;
}

export interface CatalogMeta {
  catalogVariationId: string;
  squareVariationId: string;
  itemName: string | null;
  variationName: string | null;
  inventoryUnit: "fl_oz" | "each" | null;
  volumeFlOzPerUnit: number | null;
  chartOfAccountsId: string | null;
}

export interface ServiceMappingRow {
  service_type: string;
  partner_id: string | null;
  packaging_item_id: string | null;
  packaging_format: string | null;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  square_catalog_discount_id: string | null;
  display_name: string | null;
}

/**
 * Pure selection: among service mappings already loaded for a partner+default,
 * pick the row matching (service, container, format), preferring the
 * partner-specific row over the partner_id-NULL default.
 */
export function selectServiceMapping(
  rows: ServiceMappingRow[],
  c: { serviceType: string; partnerId: string | null; packagingItemId: string | null; packagingFormat: string | null }
): ServiceMappingRow | null {
  const matches = (m: ServiceMappingRow, partner: string | null) =>
    m.service_type === c.serviceType &&
    m.partner_id === partner &&
    m.packaging_item_id === c.packagingItemId &&
    m.packaging_format === c.packagingFormat;

  if (c.partnerId) {
    const partnerRow = rows.find((m) => matches(m, c.partnerId));
    if (partnerRow) return partnerRow;
  }
  return rows.find((m) => matches(m, null)) ?? null;
}

export async function resolveProductSku(
  db: SkuDbClient,
  args: { kind: "draft"; recipeId: string } | { kind: "packaged"; variationId: string }
): Promise<ProductSku | null> {
  let q = db
    .from("recipe_square_links")
    .select("square_variation_id, square_item_id, catalog_variation_id, item_name, variation_name");

  q = args.kind === "draft"
    ? q.eq("recipe_id", args.recipeId).eq("packaging", "draft")
    : q.eq("variation_id", args.variationId);

  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    squareVariationId: data.square_variation_id,
    squareItemId: data.square_item_id ?? null,
    catalogVariationId: data.catalog_variation_id ?? null,
    itemName: data.item_name ?? null,
    variationName: data.variation_name ?? null,
  };
}

export async function resolveServiceSku(
  db: SkuDbClient,
  args: { serviceType: string; partnerId: string | null; packagingItemId?: string | null; packagingFormat?: string | null }
): Promise<ServiceSku | null> {
  const { data, error } = await db
    .from("invoice_item_mappings")
    .select("service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .eq("service_type", args.serviceType)
    .or(`partner_id.eq.${args.partnerId ?? "00000000-0000-0000-0000-000000000000"},partner_id.is.null`);
  if (error) throw new Error(error.message);

  const row = selectServiceMapping((data ?? []) as ServiceMappingRow[], {
    serviceType: args.serviceType,
    partnerId: args.partnerId,
    packagingItemId: args.packagingItemId ?? null,
    packagingFormat: args.packagingFormat ?? null,
  });
  if (!row) return null;
  return {
    squareVariationId: row.square_catalog_variation_id,
    squareItemId: row.square_catalog_item_id,
    squareDiscountId: row.square_catalog_discount_id,
    displayName: row.display_name,
  };
}

export async function resolveCatalog(
  db: SkuDbClient,
  squareVariationId: string
): Promise<CatalogMeta | null> {
  const { data, error } = await db
    .from("square_catalog_variations")
    .select("id, square_variation_id, variation_name, inventory_unit, volume_fl_oz_per_unit, chart_of_accounts_id, square_catalog_items(item_name)")
    .eq("square_variation_id", squareVariationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    catalogVariationId: data.id,
    squareVariationId: data.square_variation_id,
    itemName: data.square_catalog_items?.item_name ?? null,
    variationName: data.variation_name ?? null,
    inventoryUnit: data.inventory_unit ?? null,
    volumeFlOzPerUnit: data.volume_fl_oz_per_unit ?? null,
    chartOfAccountsId: data.chart_of_accounts_id ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- skuMappings`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
npm run lint
npm run build
git add lib/square/skuMappings.ts lib/square/skuMappings.test.ts
git commit -m "feat(square): add unified SKU resolver (product/service/catalog)"
```

---

## Task 8: Export invoice product lines via the resolver

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts:81-131` (the `buildProductLines` function)

**Interfaces:**
- Consumes: `resolveProductSku` (Task 7); `export_transactions` already carries `variation_id`-derivable data via its `recipe_id` + `packaging_item_id` + `packaging_format`. NOTE: `export_transactions` does NOT store `variation_id` directly (verify with the query in Step 1); the product link must be resolved by the variation that matches the transaction's recipe+container+format. To stay variation-grain AND correct, resolve the variation first, then the product SKU.
- Produces: `buildProductLines` returns the same `InvoiceLineItemDraft[]` shape; only its internal lookup changes.

- [ ] **Step 1: Confirm whether export_transactions has variation_id**

Run via Supabase MCP `execute_sql`:
```sql
select column_name from information_schema.columns
where table_name = 'export_transactions' and column_name in ('variation_id', 'packaging_item_id', 'packaging_format', 'recipe_id');
```
Record which columns exist. If `variation_id` IS present, use it directly in Step 2's variant A. If it is NOT present, use variant B (resolve the variation from recipe+container+format).

- [ ] **Step 2: Replace `buildProductLines`**

In `lib/production/exportInvoicePreview.ts`, add this import near the top (after the existing imports):
```ts
import { resolveProductSku } from "@/lib/square/skuMappings";
```

Then replace the entire `buildProductLines` function (lines 81-131) with the variant matching Step 1's finding.

**Variant A — `export_transactions.variation_id` EXISTS** (also add `variation_id` to the `ExportTxRow` interface's select list in `buildInvoicePreview`, see Step 3):
```ts
async function buildProductLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  priceByVariationId: Map<string, number>,
  pkgNameById: Map<string, string>
): Promise<InvoiceLineItemDraft[]> {
  const lineItems: InvoiceLineItemDraft[] = [];
  for (const tx of rows) {
    if (!tx.recipe_id) {
      throw new Error(
        `Transaction ${tx.id} has no recipe — cannot build product line items for this channel`
      );
    }
    if (!tx.variation_id) {
      const pkgName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
      throw new Error(
        `Transaction for "${pkgName}" has no packaging variation recorded — cannot resolve its Square product SKU.`
      );
    }
    const sku = await resolveProductSku(supabase, { kind: "packaged", variationId: tx.variation_id });
    if (!sku) {
      const pkgName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
      throw new Error(
        `No Square product link found for recipe + "${pkgName}" (format: ${tx.packaging_format || "none"}) — ` +
        `go to Production → Link Styles to Square and add this mapping before generating a Distribution or Wholesale invoice.`
      );
    }
    lineItems.push({
      id: crypto.randomUUID(),
      description: sku.itemName
        ? `${sku.itemName}${sku.variationName ? ` · ${sku.variationName}` : ""}${tx.packaging_format ? ` (${tx.packaging_format})` : ""}`
        : sku.squareVariationId,
      quantity: tx.quantity,
      unitPriceCents: priceByVariationId.get(sku.squareVariationId) ?? 0,
      squareCatalogVariationId: sku.squareVariationId,
    });
  }
  return lineItems;
}
```

**Variant B — NO `variation_id` on `export_transactions`** (resolve the variation by recipe+container+format first):
```ts
async function buildProductLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  priceByVariationId: Map<string, number>,
  pkgNameById: Map<string, string>
): Promise<InvoiceLineItemDraft[]> {
  const lineItems: InvoiceLineItemDraft[] = [];
  for (const tx of rows) {
    if (!tx.recipe_id) {
      throw new Error(
        `Transaction ${tx.id} has no recipe — cannot build product line items for this channel`
      );
    }
    const pkgName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;

    // Resolve the packaging_variation this transaction shipped (recipe ∩
    // container ∩ format), then the product SKU at variation grain.
    const { data: pvRows, error: pvErr } = await supabase
      .from("recipe_packaging_variations")
      .select("variation_id, packaging_variations!inner(id, container_id, format)")
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.container_id", tx.packaging_item_id)
      .eq("packaging_variations.format", tx.packaging_format ?? "loose");
    if (pvErr) throw new Error(pvErr.message);
    if (!pvRows || pvRows.length !== 1) {
      throw new Error(
        `Cannot uniquely resolve the packaging variation for recipe + "${pkgName}" ` +
        `(format: ${tx.packaging_format || "none"}) — ${pvRows?.length ?? 0} candidates. ` +
        `Resolve the mapping in Production → Link Styles to Square.`
      );
    }
    const variationId = pvRows[0].variation_id as string;

    const sku = await resolveProductSku(supabase, { kind: "packaged", variationId });
    if (!sku) {
      throw new Error(
        `No Square product link found for recipe + "${pkgName}" (format: ${tx.packaging_format || "none"}) — ` +
        `go to Production → Link Styles to Square and add this mapping before generating a Distribution or Wholesale invoice.`
      );
    }
    lineItems.push({
      id: crypto.randomUUID(),
      description: sku.itemName
        ? `${sku.itemName}${sku.variationName ? ` · ${sku.variationName}` : ""}${tx.packaging_format ? ` (${tx.packaging_format})` : ""}`
        : sku.squareVariationId,
      quantity: tx.quantity,
      unitPriceCents: priceByVariationId.get(sku.squareVariationId) ?? 0,
      squareCatalogVariationId: sku.squareVariationId,
    });
  }
  return lineItems;
}
```

- [ ] **Step 3 (Variant A only): add `variation_id` to ExportTxRow + its select**

If Step 1 showed `variation_id` exists: in `lib/production/exportInvoicePreview.ts`, add `recipe_id: string | null;` already present — also add `variation_id: string | null;` to the `ExportTxRow` interface (around line 24-35), and add `variation_id` to the `.select(...)` string in `buildInvoicePreview` (around line 144). If Variant B, skip this step.

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification — generate a distribution invoice preview**

In the running app, go to the Export flow and generate an invoice preview for a distribution or wholesale shipment whose variation IS linked. Confirm product lines render with the linked Square item/variation name and a non-zero price. Then try one whose variation is NOT linked and confirm the error message points to "Link Styles to Square".

- [ ] **Step 6: Commit**

```bash
git add lib/production/exportInvoicePreview.ts
git commit -m "feat(export): resolve product lines via unified SKU resolver"
```

---

## Task 9: Sell-through reads unit semantics from the mirror

**Files:**
- Modify: `lib/square/sell-through.ts:32-45` (remove `ozPerSale`), `:81-110` (use mirror columns), `:160-171` (can volume)

**Interfaces:**
- Consumes: `square_catalog_variations.volume_fl_oz_per_unit` (Task 3/4).
- Produces: same `LinkSellThrough[]` shape; pour/can oz now come from the mirror, not name-parsing.

- [ ] **Step 1: Replace the draft sibling oz source**

In `lib/square/sell-through.ts`, the draft sibling loader (lines 93-105) currently parses `variation_name` with `ozPerSale`. Replace the sibling `.select(...)` and the push so it reads the precomputed column:

Replace lines 94-104 (the `if (draftItemIds.length > 0) { ... }` block) with:
```ts
  if (draftItemIds.length > 0) {
    const { data: siblings } = await supabase
      .from("square_catalog_variations")
      .select("square_variation_id, square_item_id, volume_fl_oz_per_unit")
      .in("square_item_id", draftItemIds);
    for (const v of siblings ?? []) {
      const itemId = v.square_item_id as string;
      const list = draftVarsByItem.get(itemId) ?? [];
      list.push({ id: v.square_variation_id as string, oz: (v.volume_fl_oz_per_unit as number | null) ?? null });
      draftVarsByItem.set(itemId, list);
    }
  }
```

- [ ] **Step 2: Replace the can volume source**

In `lib/square/sell-through.ts`, the keg/can branch computes `volFlOz` for cans via `canOzPerUnit(l.variation_name)` (around lines 165-171). The per-link row already selects `packaging_items(volume_fl_oz)`, but the can total needs per-sold-unit oz. Resolve it from the mirror instead. Add, right after the links query resolves `baseVarIds` (after line 81), a mirror lookup:
```ts
  const { data: unitRows } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, volume_fl_oz_per_unit")
    .in("square_variation_id", baseVarIds);
  const volPerUnitByVarId = new Map<string, number | null>(
    (unitRows ?? []).map((r) => [r.square_variation_id as string, (r.volume_fl_oz_per_unit as number | null) ?? null]),
  );
```
Then replace the can branch's `volFlOz` computation (lines 165-171) with:
```ts
    let volFlOz: number | null = null;
    if (l.packaging === "keg") {
      volFlOz = l.packaging_items?.volume_fl_oz ?? null;
    } else {
      // can: total oz per sold unit comes from the mirror, falling back to the
      // packaging_items container volume if the mirror has no parsed value.
      volFlOz = volPerUnitByVarId.get(l.square_variation_id as string) ?? l.packaging_items?.volume_fl_oz ?? null;
    }
```

- [ ] **Step 3: Delete the now-unused `ozPerSale` and its import of `canOzPerUnit`**

In `lib/square/sell-through.ts`, delete the `ozPerSale` function (lines 32-45). Then check whether `canOzPerUnit` (imported at line 3) is still referenced; if not, remove its import. Run:
```bash
grep -n "canOzPerUnit\|ozPerSale" lib/square/sell-through.ts
```
Expected: no remaining references (remove the import line `import { canOzPerUnit } from "@/lib/reports/bbl-tracker";` if the grep shows it is now unused).

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run lint`
Expected: no unused-variable errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification — taproom draft stats**

In the running app, open the taproom draft-stats view (it calls `fetchSellThrough`). Confirm draft BBL remaining and daily sell-through render numerically (non-NaN) for a tapped beer, matching pre-change values within rounding. (Requires Task 4's sync to have populated `volume_fl_oz_per_unit`.)

- [ ] **Step 6: Commit**

```bash
git add lib/square/sell-through.ts
git commit -m "refactor(square): sell-through reads unit semantics from mirror"
```

---

## Task 10: Re-grain the matrix builder to packaging_variation

**Files:**
- Modify: `lib/production/recipeLinkMatrix.ts` (replace the column/cell model with a variation-row model)
- Test: `lib/production/recipeLinkMatrix.test.ts`

**Interfaces:**
- Consumes: `RecipePackagingVariationExpanded[]`, `RecipeSquareLinkRow[]` (now carrying `variation_id`), `SquareCatalogOptions`.
- Produces:
  - `interface VariationLinkRow { recipePackagingVariationId: string; recipeId: string; beerName: string; variationId: string; variationLabel: string; format: PackagingVariationFormat; state: "linked" | "suggested" | "empty"; linkId: string | null; linkedItemName: string | null; linkedVariationName: string | null; suggestion: CellSuggestion | null; }`
  - `interface VariationLinkGroup { partnerId: string | null; partnerName: string; rows: VariationLinkRow[]; }`
  - `function buildVariationLinkMatrix(rpvs: RecipePackagingVariationExpanded[], recipes: Recipe[], links: RecipeSquareLinkRow[], catalog: SquareCatalogOptions): VariationLinkGroup[]`
  - Keep the existing `CellSuggestion` interface and `autoSuggest` function exports (reused).
- Consumed by: Task 11 (UI).

- [ ] **Step 1: Write the failing test**

Create `lib/production/recipeLinkMatrix.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildVariationLinkMatrix } from "./recipeLinkMatrix";
import type { RecipePackagingVariationExpanded, RecipeSquareLinkRow, Recipe } from "@/app/production/types";
import type { SquareCatalogOptions } from "@/app/production/types";

const recipes = [{ id: "r1", beer_name: "Epic Hazy IPA" } as Recipe];

const rpvs: RecipePackagingVariationExpanded[] = [
  {
    id: "rpv1", recipe_id: "r1", variation_id: "v1", created_at: "",
    packaging_variations: {
      id: "v1", container_id: "c16", format: "4-pack", partner_id: "p1",
      total_volume_fl_oz: 64, is_active: true,
      packaging_items: { id: "c16", name: "16oz Blank", type: "can", volume_fl_oz: 16 },
      contract_brewing_partners: { id: "p1", company_name: "Argus Beverage Ventures LLC" },
    },
  },
  {
    id: "rpv2", recipe_id: "r1", variation_id: "v2", created_at: "",
    packaging_variations: {
      id: "v2", container_id: "c16", format: "4-pack", partner_id: "p1",
      total_volume_fl_oz: 64, is_active: true,
      packaging_items: { id: "c16", name: "16oz Blank", type: "can", volume_fl_oz: 16 },
      contract_brewing_partners: { id: "p1", company_name: "Argus Beverage Ventures LLC" },
    },
  },
];

const catalog: SquareCatalogOptions = {
  items: [{ itemId: "i1", itemName: "Epic Hazy IPA", variations: [{ variationId: "sv1", variationName: "4-Pack" }] }],
  discounts: [],
};

describe("buildVariationLinkMatrix", () => {
  it("emits one row per recipe_packaging_variation even when container+format collide", () => {
    const groups = buildVariationLinkMatrix(rpvs, recipes, [], catalog);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.map((r) => r.variationId).sort()).toEqual(["v1", "v2"]);
  });

  it("marks a row linked when a link exists for its variation_id", () => {
    const links: RecipeSquareLinkRow[] = [{
      id: "l1", recipe_id: "r1", packaging: "can", variation_id: "v1",
      packaging_item_id: "c16", packaging_format: "4-pack",
      square_variation_id: "sv1", square_item_id: "i1",
      variation_name: "4-Pack", item_name: "Epic Hazy IPA", created_at: "",
    }];
    const groups = buildVariationLinkMatrix(rpvs, recipes, links, catalog);
    const v1 = groups.flatMap((g) => g.rows).find((r) => r.variationId === "v1");
    const v2 = groups.flatMap((g) => g.rows).find((r) => r.variationId === "v2");
    expect(v1?.state).toBe("linked");
    expect(v1?.linkId).toBe("l1");
    expect(v2?.state).not.toBe("linked");
  });

  it("groups by partner", () => {
    const groups = buildVariationLinkMatrix(rpvs, recipes, [], catalog);
    expect(groups.length).toBe(1);
    expect(groups[0].partnerName).toBe("Argus Beverage Ventures LLC");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- recipeLinkMatrix`
Expected: FAIL — `buildVariationLinkMatrix` is not exported.

- [ ] **Step 3: Add the new builder (keep existing exports)**

In `lib/production/recipeLinkMatrix.ts`, keep the existing `CellSuggestion` interface and `autoSuggest` function. Append the new model at the end of the file:
```ts
// ─── Variation-grain model (replaces the column/cell grid) ────────────────────

export interface VariationLinkRow {
  recipePackagingVariationId: string;
  recipeId: string;
  beerName: string;
  variationId: string;
  variationLabel: string;
  format: PackagingVariationFormat;
  containerType: "keg" | "can";
  state: "linked" | "suggested" | "empty";
  linkId: string | null;
  linkedItemName: string | null;
  linkedVariationName: string | null;
  suggestion: CellSuggestion | null;
}

export interface VariationLinkGroup {
  partnerId: string | null;
  partnerName: string;
  rows: VariationLinkRow[];
}

/**
 * One row per recipe_packaging_variation — the production-native grain. Unlike
 * the old grid (keyed by recipe+container+format, which collapsed two
 * beer-specific variations that share a container+format into one cell), this
 * distinguishes every variation, so the Be Like Mike / Printed Can collision
 * is representable.
 */
export function buildVariationLinkMatrix(
  rpvs: RecipePackagingVariationExpanded[],
  recipes: Recipe[],
  links: RecipeSquareLinkRow[],
  catalog: SquareCatalogOptions
): VariationLinkGroup[] {
  const beerNameByRecipe = new Map(recipes.map((r) => [r.id, r.beer_name]));
  const linkByVariation = new Map<string, RecipeSquareLinkRow>();
  for (const l of links) {
    if (l.variation_id) linkByVariation.set(l.variation_id, l);
  }

  const groups = new Map<string | null, VariationLinkGroup>();

  for (const rpv of rpvs) {
    const pv = rpv.packaging_variations;
    if (!pv || !pv.is_active) continue;
    if (pv.packaging_items?.type !== "keg" && pv.packaging_items?.type !== "can") continue;

    const partnerId = pv.partner_id;
    const partnerName = pv.contract_brewing_partners?.company_name ?? "House Beers";
    if (!groups.has(partnerId)) groups.set(partnerId, { partnerId, partnerName, rows: [] });

    const beerName = beerNameByRecipe.get(rpv.recipe_id) ?? "—";
    const link = linkByVariation.get(rpv.variation_id);

    let state: VariationLinkRow["state"];
    let suggestion: CellSuggestion | null = null;
    if (link) {
      state = "linked";
    } else {
      suggestion = autoSuggest(beerName, catalog);
      state = suggestion ? "suggested" : "empty";
    }

    groups.get(partnerId)!.rows.push({
      recipePackagingVariationId: rpv.id,
      recipeId: rpv.recipe_id,
      beerName,
      variationId: rpv.variation_id,
      variationLabel: pv.name ?? beerName,
      format: pv.format,
      containerType: pv.packaging_items.type === "keg" ? "keg" : "can",
      state,
      linkId: link?.id ?? null,
      linkedItemName: link?.item_name ?? null,
      linkedVariationName: link?.variation_name ?? null,
      suggestion,
    });
  }

  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.beerName.localeCompare(b.beerName) || a.variationLabel.localeCompare(b.variationLabel));
  }

  return [...groups.values()].sort((a, b) => {
    if (a.partnerId === null) return -1;
    if (b.partnerId === null) return 1;
    return a.partnerName.localeCompare(b.partnerName);
  });
}
```

> `PackagingVariationExpanded` (the type behind `rpv.packaging_variations`) must expose `name`. Check `app/production/types.ts:82-99`; if `name` is absent, add `name?: string | null;` (OPTIONAL — so the test fixtures that omit it still type-check) to that interface AND add `name` to the `.select(...)` in `app/api/production/recipe-packaging-variations/route.ts` (the `packaging_variations(...)` sub-select) so the live data carries it. The builder uses `pv.name ?? beerName`, so a missing name degrades gracefully to the beer name.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- recipeLinkMatrix`
Expected: PASS — all 3 assertions green.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
npm run lint
npm run build
git add lib/production/recipeLinkMatrix.ts lib/production/recipeLinkMatrix.test.ts app/production/types.ts app/api/production/recipe-packaging-variations/route.ts
git commit -m "feat(production): variation-grain matrix builder"
```

---

## Task 11: Rework the RecipeLinkMatrix UI to variation grain

**Files:**
- Modify: `app/production/components/RecipeLinkMatrix.tsx` (replace the grid with a grouped variation list + completeness + bulk-apply)

**Interfaces:**
- Consumes: `buildVariationLinkMatrix`, `VariationLinkGroup`, `VariationLinkRow` (Task 10); posts the variation-grain body to `/api/production/recipe-square-links` (Task 6).
- Produces: a grouped list where each row is one `recipe_packaging_variation` with link/accept/change/remove, a per-group "Accept all suggestions", and a header count of unmapped variations.

- [ ] **Step 1: Replace the component**

Replace the entire contents of `app/production/components/RecipeLinkMatrix.tsx` with:
```tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useRecipePackagingVariationsExpandedQuery,
  useRecipesQuery,
  useRecipeSquareLinksQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import { buildVariationLinkMatrix } from "@/lib/production/recipeLinkMatrix";
import type { VariationLinkGroup, VariationLinkRow } from "@/lib/production/recipeLinkMatrix";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

interface SquareSelection {
  squareVariationId: string;
  squareItemId: string;
  variationName: string;
  itemName: string;
}

function RowView({
  row,
  onLink,
  onDelete,
}: {
  row: VariationLinkRow;
  onLink: (p: SquareSelection) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: catalog } = useExportSquareCatalogQuery();
  const items = catalog?.items ?? [];

  if (row.state === "linked") {
    return (
      <div className="flex items-center gap-1 group">
        <span className="text-emerald-400 text-[11px] leading-tight">
          ✓ {row.linkedItemName ?? row.linkedVariationName ?? "linked"}
          {row.linkedVariationName ? ` · ${row.linkedVariationName}` : ""}
        </span>
        <button
          className="text-zinc-700 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
          disabled={saving}
          title="Remove link"
          onClick={async () => {
            if (!row.linkId) return;
            setSaving(true);
            await onDelete(row.linkId);
            setSaving(false);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  if (row.state === "suggested" && !editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-amber-400 text-[11px] leading-tight">
          ~ {row.suggestion?.variationName ?? row.suggestion?.itemName ?? "suggested"}
        </span>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-amber-500 hover:text-amber-300 underline"
            disabled={saving}
            onClick={async () => {
              if (!row.suggestion) return;
              setSaving(true);
              await onLink({
                squareVariationId: row.suggestion.variationId,
                squareItemId: row.suggestion.itemId,
                variationName: row.suggestion.variationName,
                itemName: row.suggestion.itemName,
              });
              setSaving(false);
            }}
          >
            Accept
          </button>
          <button className="text-[10px] text-zinc-600 hover:text-zinc-400" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  if (row.state === "empty" && !editing) {
    return (
      <button className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors" onClick={() => setEditing(true)}>
        + link
      </button>
    );
  }

  return (
    <div className="min-w-[220px]">
      <SquareCatalogSelect
        items={items}
        itemId={null}
        variationId={null}
        onChange={async (itemId, variationId) => {
          if (!variationId || !itemId) { setEditing(false); return; }
          const catalogItem = items.find((i) => i.itemId === itemId);
          const catalogVariation = catalogItem?.variations.find((v) => v.variationId === variationId);
          setSaving(true);
          await onLink({
            squareVariationId: variationId,
            squareItemId: itemId,
            variationName: catalogVariation?.variationName ?? "",
            itemName: catalogItem?.itemName ?? "",
          });
          setSaving(false);
          setEditing(false);
        }}
      />
      <button className="text-[10px] text-zinc-600 hover:text-zinc-400 mt-0.5" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}

function GroupTable({
  group,
  onLink,
  onDelete,
  onAcceptAll,
}: {
  group: VariationLinkGroup;
  onLink: (row: VariationLinkRow, p: SquareSelection) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
  onAcceptAll: (group: VariationLinkGroup) => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const unmapped = group.rows.filter((r) => r.state !== "linked").length;
  const hasSuggestions = group.rows.some((r) => r.state === "suggested");

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          {group.partnerName}
          <span className="ml-2 text-zinc-600 normal-case font-normal">
            {unmapped > 0 ? `${unmapped} unmapped` : "all mapped"}
          </span>
        </h4>
        {hasSuggestions && (
          <button
            disabled={accepting}
            onClick={async () => { setAccepting(true); await onAcceptAll(group); setAccepting(false); }}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors disabled:opacity-50"
          >
            {accepting ? "Accepting…" : "Accept all suggestions"}
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap w-40">Beer</th>
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">Packaging variation</th>
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">Square link</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.recipePackagingVariationId} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/20">
                <td className="px-3 py-2.5 text-zinc-200 font-medium whitespace-nowrap">{row.beerName}</td>
                <td className="px-3 py-2.5 text-zinc-400 whitespace-nowrap">{row.variationLabel}</td>
                <td className="px-3 py-2.5 align-top">
                  <RowView row={row} onLink={(p) => onLink(row, p)} onDelete={onDelete} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RecipeLinkMatrix() {
  const qc = useQueryClient();
  const { data: rpvs = [] } = useRecipePackagingVariationsExpandedQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: links = [] } = useRecipeSquareLinksQuery();
  const { data: catalog } = useExportSquareCatalogQuery();

  const groups: VariationLinkGroup[] = catalog
    ? buildVariationLinkMatrix(rpvs, recipes, links, catalog)
    : [];

  async function refreshLinks() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
  }

  async function saveLink(row: VariationLinkRow, p: SquareSelection) {
    const packaging = row.containerType;
    const res = await fetch("/api/production/recipe-square-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_id: row.recipeId,
        packaging,
        variation_id: row.variationId,
        square_variation_id: p.squareVariationId,
        square_item_id: p.squareItemId,
        variation_name: p.variationName,
        item_name: p.itemName,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to save link");
      return;
    }
    await refreshLinks();
  }

  async function handleDelete(linkId: string) {
    const res = await fetch(`/api/production/recipe-square-links?id=${linkId}`, { method: "DELETE" });
    if (!res.ok) { alert("Failed to remove link"); return; }
    await refreshLinks();
  }

  async function handleAcceptAll(group: VariationLinkGroup) {
    const toSave = group.rows.filter((r) => r.state === "suggested" && r.suggestion);
    await Promise.all(
      toSave.map((r) =>
        saveLink(r, {
          squareVariationId: r.suggestion!.variationId,
          squareItemId: r.suggestion!.itemId,
          variationName: r.suggestion!.variationName,
          itemName: r.suggestion!.itemName,
        })
      )
    );
  }

  if (groups.length === 0) {
    return <p className="text-xs text-zinc-600 italic">No active keg/can packaging variations found.</p>;
  }

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-4">
        Map each beer&apos;s packaging variation to a Square catalog variation. Green = linked, amber =
        auto-suggested (review before accepting), + link = unmapped. One row per packaging variation, so
        differently-branded variations of the same container map independently.
      </p>
      {groups.map((group) => (
        <GroupTable
          key={group.partnerId ?? "__house__"}
          group={group}
          onLink={saveLink}
          onDelete={handleDelete}
          onAcceptAll={handleAcceptAll}
        />
      ))}
    </div>
  );
}
```

> The POST's `packaging` field comes from `row.containerType` (set by the Task 10 builder from `pv.packaging_items.type`), NOT inferred from format — a loose can must post `packaging: "can"`, not `"keg"`. This is why `containerType` is threaded through the builder.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual verification — the mapping tool**

In the running app, open Production → the Recipe ↔ Square linking view. Confirm:
1. Each partner group lists one row per packaging variation (e.g. Epic Hazy shows both "Printed Can" and "Be Like Mike Labeled Can" rows where applicable).
2. The header shows an "N unmapped" / "all mapped" count.
3. Accepting a suggestion persists (row turns green after refresh) and the POST returns 201.
4. "Accept all suggestions" maps every amber row in a group.
5. Removing a link returns the row to unmapped.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/RecipeLinkMatrix.tsx
git commit -m "feat(production): variation-grain recipe↔square mapping UI"
```

---

## Final Verification

- [ ] **Step 1: Full test suite**

Run: `npm run test`
Expected: all pure-logic tests pass (catalogUnits, skuMappings, recipeLinkMatrix).

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean lint, successful production build.

- [ ] **Step 3: End-to-end smoke (running app)**
  - Sync catalog → mirror unit columns populate.
  - Recipe↔Square tool → map a previously-colliding pair of variations independently.
  - Generate a distribution/wholesale invoice preview → product lines resolve via the resolver.
  - Taproom draft stats → render numerically.

- [ ] **Step 4: Update the schema doc**

Add to `docs/production-schema.md` under the packaging section: `recipe_square_links` is now variation-grain for keg/can (`variation_id`), recipe-grain for draft; `square_catalog_variations` carries `inventory_unit` + `volume_fl_oz_per_unit`. Commit:
```bash
git add docs/production-schema.md
git commit -m "docs: note variation-grain product mapping + mirror unit columns"
```

---

## Self-Review Notes (for the executing agent)

- **`invoice_item_mappings` FK migration (`20260711`) is referenced in the file structure but has no task** — it is intentionally deferred: the resolver (Task 7) reads fee mappings by their existing text `square_catalog_variation_id`, which still works. Adding the FK is a pure-cleanup follow-up (add `catalog_variation_id uuid references square_catalog_variations(id)`, backfill by matching `square_catalog_variation_id = square_catalog_variations.square_variation_id`). Create it only if time allows; nothing in Tasks 1–11 depends on it. Do NOT block the plan on it.
- **Draft links** are created/managed outside this matrix today (the tool only handles keg/can). This plan preserves that: the route still accepts draft POSTs, the resolver handles `kind: "draft"`. No new draft UI is in scope.
- **Reports** (`lib/reports/**`) keep their own `canOzPerUnit`; do not touch them.
- **Backfill ambiguity** (Task 5) intentionally leaves colliding rows' `variation_id` NULL — the new tool (Task 11) surfaces them as "unmapped" for manual resolution. This is the designed outcome, not a bug.
- If `export_transactions.variation_id` exists (Task 8, Step 1), prefer Variant A — it is simpler and exactly variation-grain.
