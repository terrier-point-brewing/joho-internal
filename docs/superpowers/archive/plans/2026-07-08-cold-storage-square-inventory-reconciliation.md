# Cold-Storage ↔ Square Inventory Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cold_storage_inventory` the single source of truth for taproom can/keg availability — the Performance → Inventory grid reads it directly, and a reconciler pushes each beer's cold-storage loose-can total back onto its base Square variation so Square reflects cold-storage reality.

**Architecture:** Three phases. (A) Read-side: the taproom inventory grid stops reading Square per-format counts and reads `cold_storage_inventory` (keg/can), keeping draft on Square fl-oz; labels render by packaging format. (B) Write-side: a new pure planner + IO reconciler groups a recipe's cold-storage rows into can-identity families, computes `Σ(cansEach × on-hand)` as the loose-can total, and writes it to the family's **base (loose) Square variation** via the existing `setPhysicalCount`, journaling every correction. It runs at the tail of `runTaproomConsumptionSync`, so every trigger (webhook, cron, on-demand) reconciles the recipes it touched. (C) UI: the Inventory subtab shows a clear notice summarizing recent auto-corrections.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (raw REST via supabase-js), Square API v2025-04-16 (raw fetch), Vitest, Tailwind v4 + project token utilities.

## Global Constraints

- **Square base unit for cans is loose cans on the parent/"Regular" variation.** Per-format sale quantities (4-pack, case) are Square's unit-conversion derivations (`base ÷ pack-size`) and are **not** independent inventory. Never write per-format counts to Square; only write the loose-can total to the base variation.
- **Cold storage trumps Square on drift.** The reconciler always writes cold-storage truth onto Square; it never reads Square counts back into cold storage.
- **Reconcile grain = (recipe × can-identity family).** A family = packaging_variations sharing `(container_id, lid_id, label_id, partner_id)` (null-safe). This separates Regular vs "Be Like Mike" (they differ by `label_id`). The tuple is only unique **within a recipe** — always scope by `recipe_id`.
- **Variant packaging is a distinct family**, not a special case: "Be Like Mike" (Epic Hazy IPA, `label_id` set) reconciles against its own base loose variation, independently of the Regular (printed-can, `label_id` NULL) family.
- **Money/volume math:** `currentBbl = qty × total_volume_fl_oz ÷ BBL_TO_FL_OZ`, importing `BBL_TO_FL_OZ` from `@/lib/constants/production`.
- **No raw colors / hand-rolled primitives** in any UI change — use token utilities and `app/components/` primitives (`<Banner>`, `<Badge>`) per `docs/UI_STANDARD.md`.
- **`lib/` coverage floor is 86% lines/statements** (`vitest.config.ts`). Every new `lib/` module ships with a co-located `*.test.ts`. CI runs `npm run test`.
- **All can quantities written to Square are whole** — round the loose-can total; warn (never silently truncate) if the pre-round value isn't within 1e-6 of an integer.

---

## Pre-flight verification (Phase B gate — ✅ DONE 2026-07-08)

**Resolved via read-only prod probe (user-approved).** Findings that shaped Task 6:

- Model confirmed: Square tracks loose cans on each item's **parent "Regular" variation** (`volume_fl_oz_per_unit = null`); the 4-Pack/Case variations are `each`-tracked and hold Square's *derived* `base ÷ pack-size` quantities. Verified all four sampled beers already reconcile (cold-storage loose-equiv == Square base): Pace Yourself 61, BBA Groundhog 64, Groundhog Imperial Stout 43, Blackberry Lemon Wheat 75. **The fractional cans were purely a display bug** (Phase A fixes it).
- The base is **NOT** identifiable by `inventory_unit='each'` — the mirror's heuristic labels the parent `fl_oz`; the per-format sale units are `each`. Base = `volume_fl_oz_per_unit IS NULL`. (The original Task 6 guard was inverted; corrected below.)
- Variant packaging (Epic Hazy): the Square item carries two parents, "Regular" (tracked) and "Be Like Mike" (**`track_inventory=false`**). The reconciler must skip untracked variants — hence `pickBaseVariation` requires `track_inventory=true`.
- Do **not** resolve the base via the loose link: an audit of all 47 can links found 3 loose links (Blackberry Lemon Wheat, Spring Bock, Vienna Lager) pointing at the 4-Pack sale unit. Fix staged in `supabase/migrations/20260723_fix_mislinked_loose_can_links.sql` (manual prod apply). Task 6 resolves the base via the Square item + variant stem, so it is immune to this mislink.

---

# Phase A — Read-side: grid sourced from cold storage

Phase A is independently shippable: it fixes the fractional-cans display with zero writes to Square.

### Task 1: Pure cold-storage aggregator + fetch wrapper

**Files:**
- Create: `lib/production/coldStorageOnHand.ts`
- Test: `lib/production/coldStorageOnHand.test.ts`

**Interfaces:**
- Produces:
  - `interface ColdStorageOnHand { qty: number; totalVolumeFlOz: number; format: string; containerType: "keg" | "can" }`
  - `interface ColdStorageRow { recipeId: string; variationId: string; quantityOnHand: number; totalVolumeFlOz: number; format: string; containerType: "keg" | "can" }`
  - `function coldStorageKey(recipeId: string, variationId: string): string` → `` `${recipeId}\t${variationId}` ``
  - `function aggregateColdStorage(rows: ColdStorageRow[]): Map<string, ColdStorageOnHand>`
  - `async function fetchColdStorageOnHand(supabase: DbClient): Promise<Map<string, ColdStorageOnHand>>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { aggregateColdStorage, coldStorageKey, type ColdStorageRow } from "./coldStorageOnHand";

const row = (recipeId: string, variationId: string, qty: number, vol: number, format: string, containerType: "keg" | "can"): ColdStorageRow =>
  ({ recipeId, variationId, quantityOnHand: qty, totalVolumeFlOz: vol, format, containerType });

describe("aggregateColdStorage", () => {
  it("sums quantity across batches per (recipe, variation) and keeps volume/format/type", () => {
    const map = aggregateColdStorage([
      row("r1", "loose", 5, 16, "loose", "can"),
      row("r1", "loose", 3, 16, "loose", "can"), // second batch of same variation
      row("r1", "case", 1, 384, "case", "can"),
    ]);
    expect(map.get(coldStorageKey("r1", "loose"))).toEqual({ qty: 8, totalVolumeFlOz: 16, format: "loose", containerType: "can" });
    expect(map.get(coldStorageKey("r1", "case"))).toEqual({ qty: 1, totalVolumeFlOz: 384, format: "case", containerType: "can" });
  });

  it("keys collisions only within the same recipe+variation", () => {
    const map = aggregateColdStorage([
      row("r1", "loose", 2, 16, "loose", "can"),
      row("r2", "loose", 9, 16, "loose", "can"),
    ]);
    expect(map.get(coldStorageKey("r1", "loose"))!.qty).toBe(2);
    expect(map.get(coldStorageKey("r2", "loose"))!.qty).toBe(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- coldStorageOnHand`
Expected: FAIL — "Cannot find module './coldStorageOnHand'".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/production/coldStorageOnHand.ts
//
// Reads cold_storage_inventory (the source of truth for finished-goods on hand)
// and aggregates it by (recipe, packaging variation) for the taproom inventory
// grid. Batches are summed; per-variation total volume + format + container type
// ride along so callers can compute barrelage and label by format.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

export interface ColdStorageOnHand {
  qty: number;
  totalVolumeFlOz: number;
  format: string;
  containerType: "keg" | "can";
}

export interface ColdStorageRow {
  recipeId: string;
  variationId: string;
  quantityOnHand: number;
  totalVolumeFlOz: number;
  format: string;
  containerType: "keg" | "can";
}

export function coldStorageKey(recipeId: string, variationId: string): string {
  return `${recipeId}\t${variationId}`;
}

export function aggregateColdStorage(rows: ColdStorageRow[]): Map<string, ColdStorageOnHand> {
  const map = new Map<string, ColdStorageOnHand>();
  for (const r of rows) {
    const key = coldStorageKey(r.recipeId, r.variationId);
    const existing = map.get(key);
    if (existing) {
      existing.qty += r.quantityOnHand;
    } else {
      map.set(key, {
        qty: r.quantityOnHand,
        totalVolumeFlOz: r.totalVolumeFlOz,
        format: r.format,
        containerType: r.containerType,
      });
    }
  }
  return map;
}

export async function fetchColdStorageOnHand(supabase: DbClient): Promise<Map<string, ColdStorageOnHand>> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select(
      "recipe_id, variation_id, quantity_on_hand, " +
      "packaging_variations!inner ( format, total_volume_fl_oz, packaging_items:container_id ( type ) )",
    );
  if (error) throw new Error(error.message);

  const rows: ColdStorageRow[] = [];
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const pv = r.packaging_variations as unknown as {
      format: string; total_volume_fl_oz: number | null;
      packaging_items: { type: string } | null;
    } | null;
    const type = pv?.packaging_items?.type;
    if (!pv || (type !== "keg" && type !== "can")) continue; // only finished cans/kegs
    if (r.recipe_id == null || pv.total_volume_fl_oz == null) continue;
    rows.push({
      recipeId: r.recipe_id as string,
      variationId: r.variation_id as string,
      quantityOnHand: Number(r.quantity_on_hand),
      totalVolumeFlOz: Number(pv.total_volume_fl_oz),
      format: pv.format,
      containerType: type as "keg" | "can",
    });
  }
  return aggregateColdStorage(rows);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- coldStorageOnHand`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/coldStorageOnHand.ts lib/production/coldStorageOnHand.test.ts
git commit -m "feat(taproom): cold_storage_inventory on-hand aggregator for the inventory grid"
```

---

### Task 2: Re-source `buildInventoryGrid` from cold storage (keg/can) + draft

**Files:**
- Modify: `lib/production/inventoryGrid.ts` (whole rewrite of the join logic; keep exports)
- Modify: `lib/production/inventoryGrid.test.ts`

**Interfaces:**
- Consumes: `ColdStorageOnHand`, `coldStorageKey` (Task 1); `BBL_TO_FL_OZ` from `@/lib/constants/production`; `ColumnDef`, `GridRow` from `./squareMappingGrid`.
- Produces:
  - `interface DraftOnHand { currentQty: number; currentBbl: number }`
  - `interface InventorySources { coldStorage: Map<string, ColdStorageOnHand>; draftByLinkId: Map<string, DraftOnHand> }`
  - `interface InventoryCellVariation { variationId: string; variationName: string; packaging: "draft" | "keg" | "can"; format: string | null; currentQty: number; currentBbl: number }`
  - `function buildInventoryGrid(grid: { columns: ColumnDef[]; rows: GridRow[] }, sources: InventorySources): InventoryGrid` (same `InventoryGrid` shape: `{ columns, rows, columnTotals, grandTotalBbl }`)

- [ ] **Step 1: Rewrite the test to drive the new signature**

Replace the body of `lib/production/inventoryGrid.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { buildInventoryGrid, coldStorageKeyForTest, type InventorySources } from "./inventoryGrid";
import { coldStorageKey } from "./coldStorageOnHand";
import type { ColdStorageOnHand } from "./coldStorageOnHand";
import type { ColumnDef, GridRow } from "./squareMappingGrid";

const columns: ColumnDef[] = [
  { key: "draft", label: "Draft", type: "draft", volumeFlOz: null, format: null },
  { key: "keg|1984", label: "1/2 Keg", type: "keg", volumeFlOz: 1984, format: null },
  { key: "can|16|loose", label: "16oz Loose", type: "can", volumeFlOz: 16, format: "loose" },
  { key: "can|16|case", label: "16oz Case", type: "can", volumeFlOz: 16, format: "case" },
];

function cellVar(variationId: string, variationName: string, linkId: string | null) {
  return { variationId, variationName, linkId, linkedSquareCatalogVariationId: null, linkedSquareName: linkId ? "Square Item" : null, suggestion: null };
}
function row(recipeId: string, recipeName: string, cells: GridRow["cells"], partner: string | null = null): GridRow {
  return { recipeId, recipeName, recipePartnerName: partner, cells };
}
const cs = (qty: number, vol: number, format: string, ct: "keg" | "can"): ColdStorageOnHand => ({ qty, totalVolumeFlOz: vol, format, containerType: ct });

describe("buildInventoryGrid", () => {
  it("sources keg/can from cold storage and draft from the draft map, computing bbl per format", () => {
    const rows: GridRow[] = [
      row("r1", "Blackberry Lemon Wheat", {
        draft: { variations: [cellVar("draft", "Draft", "L1")] },
        "keg|1984": { variations: [cellVar("v-keg", "1/2 Keg", "L2")] },
        "can|16|loose": { variations: [cellVar("v-loose", "16oz Labeled Can", "L3")] },
        "can|16|case": { variations: [cellVar("v-case", "16oz Labeled Can Case", "L4")] },
      }),
    ];
    const sources: InventorySources = {
      coldStorage: new Map([
        [coldStorageKey("r1", "v-keg"), cs(1, 1984, "loose" /* n/a for keg */, "keg")],
        [coldStorageKey("r1", "v-loose"), cs(8, 16, "loose", "can")],
        [coldStorageKey("r1", "v-case"), cs(1, 384, "case", "can")],
      ]),
      draftByLinkId: new Map([["L1", { currentQty: 1984, currentBbl: 0.5 }]]),
    };

    const grid = buildInventoryGrid({ columns, rows }, sources);
    const cells = grid.rows[0].cells;

    // Cold-storage counts flow straight through (no Square fractional derivation).
    expect(cells["can|16|loose"]!.variations[0]).toMatchObject({ packaging: "can", format: "loose", currentQty: 8 });
    expect(cells["can|16|case"]!.variations[0]).toMatchObject({ packaging: "can", format: "case", currentQty: 1 });
    // bbl uses the per-format total volume: case = 384 fl oz.
    expect(cells["can|16|case"]!.variations[0].currentBbl).toBeCloseTo(384 / 3968.077, 3);
    // Draft still comes from the draft map.
    expect(cells["draft"]!.variations[0]).toMatchObject({ packaging: "draft", currentBbl: 0.5 });
  });

  it("drops unmapped recipes but keeps mapped-but-empty ones (no cold-storage row → qty 0)", () => {
    const rows: GridRow[] = [
      row("r1", "Unmapped House Ale", { draft: { variations: [cellVar("draft", "Draft", null)] } }),
      row("r2", "Mapped But Empty", { draft: { variations: [cellVar("draft", "Draft", "L-empty")] } }, "Fortnight Brewing"),
    ];
    const grid = buildInventoryGrid({ columns, rows }, { coldStorage: new Map(), draftByLinkId: new Map() });
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].recipeName).toBe("Mapped But Empty");
  });
});

// coldStorageKeyForTest re-exports the key helper so the test file has one import path.
void coldStorageKeyForTest;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- inventoryGrid`
Expected: FAIL — new signature / `format` field / `coldStorageKeyForTest` not present.

- [ ] **Step 3: Rewrite `lib/production/inventoryGrid.ts`**

```ts
// lib/production/inventoryGrid.ts
//
// Pure transform: joins the Square-mapping grid (columns + rows) with on-hand
// inventory to produce the taproom cold-storage inventory grid.
//
// SOURCE OF TRUTH: keg/can quantities come from cold_storage_inventory (keyed by
// recipe_id + packaging_variation), NOT Square. Square's per-format can counts are
// unit-conversion derivations (base loose ÷ pack size) and are not real inventory.
// Draft is the one exception — the tapped keg's remaining fl oz still lives in
// Square, so draft cells read the draft map. Only linked (mapped/sellable)
// variations are shown; unmapped recipes are dropped.

import type { ColumnDef, GridRow } from "@/lib/production/squareMappingGrid";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { coldStorageKey, type ColdStorageOnHand } from "@/lib/production/coldStorageOnHand";

export type Packaging = "draft" | "keg" | "can";

export interface DraftOnHand {
  currentQty: number; // fl oz remaining in the tapped keg
  currentBbl: number;
}

export interface InventorySources {
  coldStorage: Map<string, ColdStorageOnHand>; // key: coldStorageKey(recipeId, variationId)
  draftByLinkId: Map<string, DraftOnHand>;
}

export interface InventoryCellVariation {
  variationId: string;
  variationName: string;
  packaging: Packaging;
  format: string | null; // 'loose' | '4-pack' | '6-pack' | 'case' for cans; null otherwise
  currentQty: number;
  currentBbl: number;
}

export interface InventoryCell {
  totalBbl: number;
  variations: InventoryCellVariation[];
}

export interface InventoryRow {
  recipeId: string;
  recipeName: string;
  recipePartnerName: string | null;
  totalBbl: number;
  cells: Record<string, InventoryCell | null>;
}

export interface InventoryGrid {
  columns: ColumnDef[];
  rows: InventoryRow[];
  columnTotals: Record<string, number>;
  grandTotalBbl: number;
}

// Re-export so the test file imports the key helper from one place.
export { coldStorageKey as coldStorageKeyForTest };

const round = (n: number) => Number(n.toFixed(2));

export function buildInventoryGrid(
  grid: { columns: ColumnDef[]; rows: GridRow[] },
  sources: InventorySources,
): InventoryGrid {
  const { columns } = grid;
  const columnTotals: Record<string, number> = Object.fromEntries(columns.map((c) => [c.key, 0]));
  let grandTotalBbl = 0;

  const built = grid.rows.map((row) => {
    const cells: Record<string, InventoryCell | null> = {};
    let rowTotalBbl = 0;
    let mapped = false;

    for (const col of columns) {
      const cell = row.cells[col.key];
      if (cell === null || cell === undefined) {
        cells[col.key] = null;
        continue;
      }

      const variations: InventoryCellVariation[] = [];
      for (const v of cell.variations) {
        if (!v.linkId) continue; // only mapped/sellable variations carry inventory
        mapped = true;

        if (col.type === "draft") {
          const inv = sources.draftByLinkId.get(v.linkId);
          if (!inv) continue;
          variations.push({
            variationId: v.variationId,
            variationName: v.variationName,
            packaging: "draft",
            format: null,
            currentQty: inv.currentQty,
            currentBbl: inv.currentBbl,
          });
        } else {
          const inv = sources.coldStorage.get(coldStorageKey(row.recipeId, v.variationId));
          if (!inv) continue;
          const currentBbl = (inv.qty * inv.totalVolumeFlOz) / BBL_TO_FL_OZ;
          variations.push({
            variationId: v.variationId,
            variationName: v.variationName,
            packaging: col.type, // 'keg' | 'can'
            format: col.format,
            currentQty: inv.qty,
            currentBbl,
          });
        }
      }

      const cellTotal = variations.reduce((s, v) => s + v.currentBbl, 0);
      cells[col.key] = { totalBbl: round(cellTotal), variations };
      rowTotalBbl += cellTotal;
      columnTotals[col.key] += cellTotal;
    }

    grandTotalBbl += rowTotalBbl;
    const inventoryRow: InventoryRow = {
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      recipePartnerName: row.recipePartnerName,
      totalBbl: round(rowTotalBbl),
      cells,
    };
    return { inventoryRow, mapped };
  });

  for (const key of Object.keys(columnTotals)) columnTotals[key] = round(columnTotals[key]);
  const rows = built.filter((b) => b.mapped).map((b) => b.inventoryRow);
  return { columns, rows, columnTotals, grandTotalBbl: round(grandTotalBbl) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- inventoryGrid`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/inventoryGrid.ts lib/production/inventoryGrid.test.ts
git commit -m "feat(taproom): source inventory grid from cold storage (keg/can) + draft, label by format"
```

---

### Task 3: Wire the route to the new sources

**Files:**
- Modify: `app/api/taproom/inventory/route.ts`

**Interfaces:**
- Consumes: `fetchColdStorageOnHand` (Task 1), `buildInventoryGrid` + `InventorySources` + `DraftOnHand` (Task 2), `fetchSellThrough` (existing), `fetchMappingGrid` (existing).

- [ ] **Step 1: Replace the route body**

```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchMappingGrid } from "@/lib/production/mappingGridData";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { fetchColdStorageOnHand } from "@/lib/production/coldStorageOnHand";
import { buildInventoryGrid, type InventorySources } from "@/lib/production/inventoryGrid";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Taproom cold-storage inventory grid. Keg/can on-hand is the cold_storage_inventory
// source of truth; draft (tapped keg fl oz) still comes from Square via sell-through.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const [grid, coldStorage, draftSellThrough, reconResp] = await Promise.all([
      fetchMappingGrid(supabase),
      fetchColdStorageOnHand(supabase),
      fetchSellThrough(supabase, { packaging: "draft" }),
      supabase
        .from("square_inventory_reconciliations")
        .select("recipe_id, base_variation_name, cold_storage_cans, square_cans_before, drift, occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);

    const draftByLinkId: InventorySources["draftByLinkId"] = new Map(
      draftSellThrough.map((l) => [l.link_id, { currentQty: l.current_qty, currentBbl: l.current_bbl }]),
    );

    const inventory = buildInventoryGrid(grid, { coldStorage, draftByLinkId });
    return NextResponse.json({ ...inventory, reconciliations: reconResp.data ?? [] });
  } catch (err) {
    return apiError(err);
  }
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: compiles with no type errors in `app/api/taproom/inventory/route.ts`. (The `square_inventory_reconciliations` table is created in Task 7; until then the query returns an error object that resolves to `[]` via `?? []` — the route still builds. Sequence Task 7's migration before deploying.)

- [ ] **Step 3: Commit**

```bash
git add app/api/taproom/inventory/route.ts
git commit -m "feat(taproom): serve inventory grid from cold storage + surface reconcile events"
```

---

### Task 4: Label cells by packaging format in `InventoryTab`

**Files:**
- Modify: `app/taproom/components/InventoryTab.tsx:36-98` (QuantityCard + Cell)

**Interfaces:**
- Consumes: `InventoryCellVariation` now carries `format` and `packaging` (Task 2).

- [ ] **Step 1: Add a format→noun helper and use it in `QuantityCard`**

Replace the `unit` computation in `QuantityCard` (`InventoryTab.tsx:48-53`) with format-aware labeling:

```tsx
// Noun for a packaged unit, by cold-storage format. A case is a case — not a can.
function packagedUnit(format: string | null, n: number): string {
  switch (format) {
    case "case":   return pluralize(n, "case", "cases");
    case "4-pack": return pluralize(n, "4-pack", "4-packs");
    case "6-pack": return pluralize(n, "6-pack", "6-packs");
    case "loose":  return pluralize(n, "can", "cans");
    default:       return pluralize(n, "unit", "units");
  }
}
```

```tsx
  const isDraft = v.packaging === "draft";
  const headline = isDraft ? fmtBbl(v.currentBbl) : fmtCount(v.currentQty);
  const unit = isDraft
    ? "bbl on tap"
    : v.packaging === "keg"
      ? pluralize(v.currentQty, "keg", "kegs")
      : packagedUnit(v.format, v.currentQty);
```

- [ ] **Step 2: Update the `InventoryCellVariation` import type usage**

`InventoryTab.tsx` imports `InventoryCellVariation` from `@/lib/production/inventoryGrid` (already). No change needed beyond consuming `v.format` — confirm the imported type now includes `format` (it does after Task 2).

- [ ] **Step 3: Verify in the browser**

- Start the dev server (preview_start), open `/taproom/performance/inventory`.
- Confirm BBA Groundhog's 12oz Case cell reads e.g. "**1 case**" (from cold storage), not "2.7 cans"; Blackberry Lemon Wheat 16oz Loose reads "**8 cans**", 16oz Case reads "**1 case**".
- Take a screenshot as proof.

- [ ] **Step 4: Commit**

```bash
git add app/taproom/components/InventoryTab.tsx
git commit -m "fix(taproom): label inventory cells by format (cases/4-packs/loose), not 'cans'"
```

---

# Phase B — Write-side: cold-storage → Square reconciler

### Task 5: Extract the can-identity family primitives

**Files:**
- Create: `lib/production/canIdentityFamily.ts`
- Create: `lib/production/canIdentityFamily.test.ts`
- Modify: `lib/production/applyBreakDown.ts:35,38` (import shared `CAN_FORMATS` + `nullSafeEq` instead of local defs; behavior unchanged)

**Interfaces:**
- Produces:
  - `const CAN_FORMATS: Set<string>` = `{loose, 4-pack, 6-pack, case}`
  - `function nullSafeEq(a: unknown, b: unknown): boolean`
  - `interface FamilyPackagingRow { id: string; format: string; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null; total_volume_fl_oz: number }`
  - `function familyKey(v: Pick<FamilyPackagingRow, "container_id" | "lid_id" | "label_id" | "partner_id">): string`
  - `function groupCanFamilies(rows: FamilyPackagingRow[]): FamilyPackagingRow[][]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { groupCanFamilies, familyKey, nullSafeEq, type FamilyPackagingRow } from "./canIdentityFamily";

const v = (id: string, format: string, label_id: string | null): FamilyPackagingRow => ({
  id, format, container_id: "c16", lid_id: "silver", label_id, partner_id: "argus",
  total_volume_fl_oz: format === "case" ? 384 : format === "4-pack" ? 64 : 16,
});

describe("groupCanFamilies", () => {
  it("splits Regular (label NULL) from Be Like Mike (label set) even at same container/lid/partner", () => {
    const fams = groupCanFamilies([
      v("reg-loose", "loose", null), v("reg-case", "case", null),
      v("blm-loose", "loose", "belikemike"), v("blm-case", "case", "belikemike"),
    ]);
    expect(fams).toHaveLength(2);
    const ids = fams.map((f) => f.map((x) => x.id).sort());
    expect(ids).toContainEqual(["reg-case", "reg-loose"]);
    expect(ids).toContainEqual(["blm-case", "blm-loose"]);
  });

  it("ignores non-can formats", () => {
    const fams = groupCanFamilies([v("reg-loose", "loose", null), { ...v("keg", "keg" as string, null) }]);
    expect(fams.flat().map((x) => x.id)).toEqual(["reg-loose"]);
  });
});

describe("nullSafeEq / familyKey", () => {
  it("treats null and undefined as equal", () => {
    expect(nullSafeEq(null, undefined)).toBe(true);
    expect(nullSafeEq("a", "a")).toBe(true);
    expect(nullSafeEq("a", null)).toBe(false);
  });
  it("familyKey is stable for the same identity tuple", () => {
    expect(familyKey(v("x", "loose", null))).toBe(familyKey(v("y", "case", null)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- canIdentityFamily`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/production/canIdentityFamily.ts
//
// Shared primitives for grouping packaging_variations into "can-identity families".
// A family = variations that share (container_id, lid_id, label_id, partner_id)
// (null-safe) and differ only by tier/format (loose < 4-pack < 6-pack < case).
// label_id is what separates Regular (printed, NULL) from a labeled variant like
// "Be Like Mike". NOTE: the 4-tuple is only unique WITHIN a recipe — callers must
// pre-filter rows to a single recipe before grouping.

export const CAN_FORMATS = new Set(["loose", "4-pack", "6-pack", "case"]);

export const nullSafeEq = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

export interface FamilyPackagingRow {
  id: string;
  format: string;
  container_id: string;
  lid_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  total_volume_fl_oz: number;
}

export function familyKey(
  v: Pick<FamilyPackagingRow, "container_id" | "lid_id" | "label_id" | "partner_id">,
): string {
  return [v.container_id, v.lid_id ?? "∅", v.label_id ?? "∅", v.partner_id ?? "∅"].join("|");
}

export function groupCanFamilies(rows: FamilyPackagingRow[]): FamilyPackagingRow[][] {
  const byKey = new Map<string, FamilyPackagingRow[]>();
  for (const v of rows) {
    if (!CAN_FORMATS.has(v.format)) continue;
    const key = familyKey(v);
    const list = byKey.get(key);
    if (list) list.push(v);
    else byKey.set(key, [v]);
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Refactor `applyBreakDown.ts` to import the shared primitives**

In `lib/production/applyBreakDown.ts`, delete the local `const CAN_FORMATS = new Set(...)` (line 35) and `const nullSafeEq = ...` (line 38), and add to the imports at the top:

```ts
import { CAN_FORMATS, nullSafeEq } from "./canIdentityFamily";
```

Leave the rest of `applyBreakDown` unchanged.

- [ ] **Step 5: Run the full suite to verify no regression**

Run: `npm run test -- applyBreakDown canIdentityFamily`
Expected: PASS — both the new family tests and all existing `applyBreakDown` tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/production/canIdentityFamily.ts lib/production/canIdentityFamily.test.ts lib/production/applyBreakDown.ts
git commit -m "refactor(cold-storage): extract can-identity family primitives for reuse"
```

---

### Task 6: Reconciler — pure planner + IO orchestrator

**Files:**
- Create: `lib/production/reconcileSquareCanInventory.ts`
- Create: `lib/production/reconcileSquareCanInventory.test.ts`

**Interfaces:**
- Consumes: `groupCanFamilies` + `FamilyPackagingRow` (Task 5); `deriveCansEach` from `./coldStorageBreak`; `resolveProductSku` from `@/lib/square/skuMappings`; `fetchCurrentCounts`, `setPhysicalCount` from `@/lib/square/inventory`. Reads `square_catalog_variations` directly (needs `track_inventory` + `variation_name` + `volume_fl_oz_per_unit`, which `resolveCatalog` does not return).
- Produces:
  - `interface ItemVariation { squareVariationId: string; variationName: string; volumeFlOzPerUnit: number | null; trackInventory: boolean }`
  - `function variantStem(variationName: string): string` — the stem before the size/format suffix (`"Regular - 16oz Case"` → `"Regular"`)
  - `function pickBaseVariation(input: { itemVariations: ItemVariation[]; stem: string | null }): ItemVariation | null` — the family's base = the item's parent variation (`volume_fl_oz_per_unit` null), disambiguated by variant stem, required `track_inventory=true`
  - `interface ReconcileFamilyInput { recipeId: string; baseSquareVariationId: string | null; baseVariationName: string | null; cansEachByVar: Record<string, number>; onHandByVar: Record<string, number> }`
  - `interface ReconcileWrite { recipeId: string; baseSquareVariationId: string; baseVariationName: string | null; coldStorageCans: number; squareCansBefore: number; drift: number }`
  - `interface ReconcilePlan { writes: ReconcileWrite[]; skips: { recipeId: string; reason: string }[]; warnings: string[] }`
  - `function planCanReconciliation(input: { families: ReconcileFamilyInput[]; squareCountByVar: Record<string, number>; threshold?: number }): ReconcilePlan`
  - `async function reconcileSquareCanInventory(supabase, opts?: { recipeIds?: string[]; occurredAt?: string }): Promise<ReconcilePlan & { applied: number }>`

> **Base-resolution rule (verified against live catalog 2026-07-08):** Square tracks loose cans on each item's PARENT variation ("Regular", `volume_fl_oz_per_unit = null`); the 4-Pack/Case variations are `each`-tracked and hold Square's *derived* `base ÷ pack-size` quantities. The write target is that parent, found via the Square **item** (from whichever tiers resolve) and matched by variant name-stem — **never** via the loose tier's own link, which can be mis-mapped (audited: 3 loose links pointed at the 4-Pack sale unit). Variant families whose parent is `track_inventory=false` (e.g. Epic Hazy's "Be Like Mike") are **skipped** — you cannot write a physical count to an untracked variation; cold storage stays their sole source of truth.

- [ ] **Step 1: Write the failing test (pure planner)**

```ts
import { describe, it, expect } from "vitest";
import { planCanReconciliation, variantStem, pickBaseVariation, type ReconcileFamilyInput, type ItemVariation } from "./reconcileSquareCanInventory";

const fam = (over: Partial<ReconcileFamilyInput> = {}): ReconcileFamilyInput => ({
  recipeId: "r1",
  baseSquareVariationId: "SQ-LOOSE",
  baseVariationName: "16oz Labeled Can",
  cansEachByVar: { loose: 1, pack: 4, case: 24 },
  onHandByVar: { loose: 8, pack: 0, case: 1 }, // 8 + 24 = 32 loose-equiv
  ...over,
});

describe("planCanReconciliation", () => {
  it("writes cold-storage total onto the base variation when Square drifts", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 61 } });
    expect(plan.writes).toEqual([
      { recipeId: "r1", baseSquareVariationId: "SQ-LOOSE", baseVariationName: "16oz Labeled Can", coldStorageCans: 32, squareCansBefore: 61, drift: 29 },
    ]);
  });

  it("no write when Square already matches within threshold", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 32 } });
    expect(plan.writes).toEqual([]);
  });

  it("skips a family whose loose tier has no Square link", () => {
    const plan = planCanReconciliation({ families: [fam({ baseSquareVariationId: null })], squareCountByVar: {} });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/no base/i);
  });

  it("rounds a fractional loose-equivalent and warns", () => {
    const plan = planCanReconciliation({
      families: [fam({ onHandByVar: { loose: 0.6, pack: 0, case: 0 } })],
      squareCountByVar: { "SQ-LOOSE": 5 },
    });
    expect(plan.writes[0].coldStorageCans).toBe(1); // round(0.6)
    expect(plan.warnings.join()).toMatch(/fractional/i);
  });
});

const iv = (over: Partial<ItemVariation>): ItemVariation =>
  ({ squareVariationId: "sq", variationName: "Regular", volumeFlOzPerUnit: null, trackInventory: true, ...over });

describe("variantStem", () => {
  it("strips the size/format suffix", () => {
    expect(variantStem("Regular - 16oz Case")).toBe("Regular");
    expect(variantStem("Be Like Mike - 16oz 4-Pack")).toBe("Be Like Mike");
    expect(variantStem("Regular")).toBe("Regular");
  });
});

describe("pickBaseVariation", () => {
  it("returns the single tracked parent (volume null)", () => {
    const base = pickBaseVariation({
      itemVariations: [
        iv({ squareVariationId: "REG", variationName: "Regular" }),
        iv({ squareVariationId: "REG-CASE", variationName: "Regular - 16oz Case", volumeFlOzPerUnit: 384 }),
      ],
      stem: "Regular",
    });
    expect(base?.squareVariationId).toBe("REG");
  });

  it("disambiguates Regular vs Be Like Mike parents by stem", () => {
    const vars = [
      iv({ squareVariationId: "REG", variationName: "Regular" }),
      iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false }),
    ];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Regular" })?.squareVariationId).toBe("REG");
  });

  it("returns null when the matching parent is not inventory-tracked (Be Like Mike)", () => {
    const vars = [iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Be Like Mike" })).toBeNull();
  });

  it("returns null when ambiguous (multiple tracked parents, no stem match)", () => {
    const vars = [iv({ squareVariationId: "A", variationName: "Alpha" }), iv({ squareVariationId: "B", variationName: "Beta" })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Gamma" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- reconcileSquareCanInventory`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// lib/production/reconcileSquareCanInventory.ts
//
// Cold storage is the source of truth for can inventory; Square tracks loose cans
// on each family's base ("Regular"/loose) variation and derives 4-pack/case
// quantities itself. This reconciler pushes cold storage's loose-can total onto
// that base Square variation whenever they drift, and journals each correction to
// square_inventory_reconciliations so the taproom Inventory subtab can show it.
//
// Grain: one write per (recipe × can-identity family). Cold storage always trumps;
// Square is never read back into cold storage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveCansEach } from "./coldStorageBreak";
import { groupCanFamilies, type FamilyPackagingRow } from "./canIdentityFamily";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { fetchCurrentCounts, setPhysicalCount } from "@/lib/square/inventory";

const DRIFT_THRESHOLD = 0.5;
const INT_EPS = 1e-6;

// ── Base-variation resolution (pure) ─────────────────────────────────────────

export interface ItemVariation {
  squareVariationId: string;
  variationName: string;
  volumeFlOzPerUnit: number | null;
  trackInventory: boolean;
}

/** Stem before the size/format suffix: "Regular - 16oz Case" -> "Regular". */
export function variantStem(variationName: string): string {
  return variationName.split(" - ")[0].trim();
}

/**
 * The family's base (loose-can-tracked) Square variation is the item's PARENT
 * variation — volume_fl_oz_per_unit IS NULL, i.e. "Regular" / "Be Like Mike".
 * When an item has more than one parent (Regular vs a labeled variant),
 * disambiguate by variant stem. Requires track_inventory=true; returns null when
 * no tracked parent matches (e.g. Be Like Mike is untracked) or the match is
 * ambiguous — the caller then skips the family rather than risk a wrong write.
 */
export function pickBaseVariation(input: { itemVariations: ItemVariation[]; stem: string | null }): ItemVariation | null {
  const parents = input.itemVariations.filter((v) => v.volumeFlOzPerUnit == null);
  let candidates = parents;
  if (input.stem) {
    const matched = parents.filter((v) => variantStem(v.variationName) === input.stem);
    if (matched.length > 0) candidates = matched;
  }
  const tracked = candidates.filter((v) => v.trackInventory);
  return tracked.length === 1 ? tracked[0] : null;
}

export interface ReconcileFamilyInput {
  recipeId: string;
  baseSquareVariationId: string | null;
  baseVariationName: string | null;
  cansEachByVar: Record<string, number>;
  onHandByVar: Record<string, number>;
}

export interface ReconcileWrite {
  recipeId: string;
  baseSquareVariationId: string;
  baseVariationName: string | null;
  coldStorageCans: number;
  squareCansBefore: number;
  drift: number; // squareCansBefore - coldStorageCans
}

export interface ReconcilePlan {
  writes: ReconcileWrite[];
  skips: { recipeId: string; reason: string }[];
  warnings: string[];
}

export function planCanReconciliation(input: {
  families: ReconcileFamilyInput[];
  squareCountByVar: Record<string, number>;
  threshold?: number;
}): ReconcilePlan {
  const threshold = input.threshold ?? DRIFT_THRESHOLD;
  const plan: ReconcilePlan = { writes: [], skips: [], warnings: [] };

  for (const fam of input.families) {
    if (!fam.baseSquareVariationId) {
      plan.skips.push({ recipeId: fam.recipeId, reason: "no base Square variation for family" });
      continue;
    }
    let raw = 0;
    for (const [varId, cansEach] of Object.entries(fam.cansEachByVar)) {
      raw += cansEach * (fam.onHandByVar[varId] ?? 0);
    }
    const coldStorageCans = Math.round(raw);
    if (Math.abs(raw - coldStorageCans) > INT_EPS) {
      plan.warnings.push(`${fam.recipeId} ${fam.baseVariationName ?? fam.baseSquareVariationId}: fractional loose-equivalent ${raw.toFixed(3)} rounded to ${coldStorageCans}`);
    }
    const squareCansBefore = input.squareCountByVar[fam.baseSquareVariationId] ?? 0;
    const drift = squareCansBefore - coldStorageCans;
    if (Math.abs(drift) >= threshold) {
      plan.writes.push({
        recipeId: fam.recipeId,
        baseSquareVariationId: fam.baseSquareVariationId,
        baseVariationName: fam.baseVariationName,
        coldStorageCans,
        squareCansBefore,
        drift,
      });
    }
  }
  return plan;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any };

export async function reconcileSquareCanInventory(
  supabase: Db,
  opts: { recipeIds?: string[]; occurredAt?: string } = {},
): Promise<ReconcilePlan & { applied: number }> {
  const occurredAt = opts.occurredAt ?? new Date().toISOString();

  // 1. Load cold-storage can rows (optionally scoped) with the packaging identity + volume.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("cold_storage_inventory")
    .select(
      "recipe_id, variation_id, quantity_on_hand, " +
      "packaging_variations!inner ( id, format, total_volume_fl_oz, container_id, lid_id, label_id, partner_id, packaging_items:container_id ( type ) )",
    );
  if (opts.recipeIds && opts.recipeIds.length > 0) q = q.in("recipe_id", opts.recipeIds);
  const { data, error } = await q as { data: Record<string, unknown>[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);

  // 2. Group rows by recipe, then into can-identity families; accumulate on-hand per variation.
  interface Loaded { row: FamilyPackagingRow; recipeId: string; onHand: number }
  const byRecipe = new Map<string, Loaded[]>();
  for (const r of data ?? []) {
    const pv = r.packaging_variations as unknown as {
      id: string; format: string; total_volume_fl_oz: number | null;
      container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null;
      packaging_items: { type: string } | null;
    } | null;
    if (!pv || pv.packaging_items?.type !== "can" || pv.total_volume_fl_oz == null || r.recipe_id == null) continue;
    const recipeId = r.recipe_id as string;
    const list = byRecipe.get(recipeId) ?? [];
    list.push({
      recipeId,
      onHand: Number(r.quantity_on_hand),
      row: {
        id: pv.id, format: pv.format, container_id: pv.container_id,
        lid_id: pv.lid_id, label_id: pv.label_id, partner_id: pv.partner_id,
        total_volume_fl_oz: Number(pv.total_volume_fl_oz),
      },
    });
    byRecipe.set(recipeId, list);
  }

  const families: ReconcileFamilyInput[] = [];
  const preWarnings: string[] = [];
  const preSkips: { recipeId: string; reason: string }[] = [];

  for (const [recipeId, loaded] of byRecipe) {
    // Sum on-hand per variation (batches collapse) and dedupe the packaging rows.
    const onHandByVar: Record<string, number> = {};
    const rowById = new Map<string, FamilyPackagingRow>();
    for (const l of loaded) {
      onHandByVar[l.row.id] = (onHandByVar[l.row.id] ?? 0) + l.onHand;
      rowById.set(l.row.id, l.row);
    }
    for (const famRows of groupCanFamilies([...rowById.values()])) {
      let derived;
      try {
        derived = deriveCansEach({
          variations: famRows.map((v) => ({ variationId: v.id, format: v.format, totalVolumeFlOz: v.total_volume_fl_oz })),
        });
      } catch {
        preSkips.push({ recipeId, reason: "family has no loose base variation" });
        continue;
      }
      preWarnings.push(...derived.warnings);
      const cansEachByVar: Record<string, number> = {};
      for (const t of derived.tiers) cansEachByVar[t.variationId] = t.cansEach;

      // Resolve the family's base Square variation via the Square ITEM + variant
      // stem (NOT the loose tier's own link, which can be mis-mapped — audited
      // case: a loose link pointing at the 4-Pack sale unit). Resolve each tier's
      // link, take the item id from whichever resolve, take the stem from a
      // NON-loose tier's name when available, then pick the item's tracked parent.
      const tierLinks = (await Promise.all(
        derived.tiers.map(async (t) => ({
          format: t.format,
          sku: await resolveProductSku(supabase, { kind: "packaged", variationId: t.variationId }),
        })),
      )).filter((x) => x.sku);
      const itemId = tierLinks.map((x) => x.sku!.squareItemId).find((id): id is string => !!id) ?? null;
      const stemSource = tierLinks.find((x) => x.format !== "loose") ?? tierLinks[0];
      const stem = stemSource?.sku?.variationName ? variantStem(stemSource.sku.variationName) : null;

      let base: ItemVariation | null = null;
      if (itemId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: itemVars } = await (supabase as any)
          .from("square_catalog_variations")
          .select("square_variation_id, variation_name, volume_fl_oz_per_unit, track_inventory")
          .eq("square_item_id", itemId);
        base = pickBaseVariation({
          itemVariations: ((itemVars ?? []) as Record<string, unknown>[]).map((v) => ({
            squareVariationId: v.square_variation_id as string,
            variationName: (v.variation_name as string) ?? "",
            volumeFlOzPerUnit: (v.volume_fl_oz_per_unit as number | null) ?? null,
            trackInventory: Boolean(v.track_inventory),
          })),
          stem,
        });
      }
      if (!base) {
        preSkips.push({ recipeId, reason: `no inventory-tracked base variation (item ${itemId ?? "?"}, stem ${stem ?? "?"})` });
      }
      families.push({
        recipeId,
        baseSquareVariationId: base?.squareVariationId ?? null,
        baseVariationName: base?.variationName ?? null,
        cansEachByVar,
        onHandByVar,
      });
    }
  }

  // 3. Read current Square counts for the base variations we might write.
  const baseVarIds = [...new Set(families.map((f) => f.baseSquareVariationId).filter((x): x is string => !!x))];
  const counts = baseVarIds.length ? await fetchCurrentCounts(baseVarIds) : new Map<string, number>();
  const squareCountByVar: Record<string, number> = {};
  for (const id of baseVarIds) squareCountByVar[id] = counts.get(id) ?? 0;

  // 4. Plan, then execute writes (cold storage trumps) + journal each correction.
  const plan = planCanReconciliation({ families, squareCountByVar });
  plan.warnings.unshift(...preWarnings);
  plan.skips.unshift(...preSkips);

  let applied = 0;
  for (const w of plan.writes) {
    try {
      await setPhysicalCount(w.baseSquareVariationId, w.coldStorageCans, occurredAt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("square_inventory_reconciliations").insert({
        recipe_id: w.recipeId,
        base_square_variation_id: w.baseSquareVariationId,
        base_variation_name: w.baseVariationName,
        cold_storage_cans: w.coldStorageCans,
        square_cans_before: w.squareCansBefore,
        drift: w.drift,
        occurred_at: occurredAt,
      });
      applied++;
    } catch (e) {
      plan.warnings.push(`write failed for ${w.baseSquareVariationId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ...plan, applied };
}
```

- [ ] **Step 4: Run test to verify the planner passes**

Run: `npm run test -- reconcileSquareCanInventory`
Expected: PASS (planner + `variantStem` + `pickBaseVariation` tests). The IO `reconcileSquareCanInventory` is covered indirectly; its Square/DB calls are exercised via the sync test in Task 8.

- [ ] **Step 5: Commit**

```bash
git add lib/production/reconcileSquareCanInventory.ts lib/production/reconcileSquareCanInventory.test.ts
git commit -m "feat(cold-storage): reconcile Square base can count to cold-storage loose-can total"
```

---

### Task 7: Migration — `square_inventory_reconciliations`

**Files:**
- Create: `supabase/migrations/20260722_square_inventory_reconciliations.sql`

**Interfaces:**
- Produces the table the reconciler journals to (Task 6) and the route reads (Task 3).

- [ ] **Step 1: Write the migration**

```sql
-- Journal of cold-storage → Square can-inventory write-backs.
--
-- Each row is one correction: the reconciler wrote `cold_storage_cans` onto a
-- family's base (loose) Square variation because it drifted from cold storage
-- (the source of truth). Drives the "Square auto-reconciled to cold storage"
-- notice on the taproom Performance > Inventory subtab. Append-only.

create table if not exists public.square_inventory_reconciliations (
  id                        uuid primary key default gen_random_uuid(),
  recipe_id                 uuid references public.recipes(id) on delete set null,
  base_square_variation_id  text not null,
  base_variation_name       text,
  cold_storage_cans         numeric not null,   -- value written to Square (whole cans)
  square_cans_before        numeric not null,   -- Square's count just before the write
  drift                     numeric not null,   -- square_cans_before - cold_storage_cans
  occurred_at               timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index if not exists sq_inv_recon_occurred_idx
  on public.square_inventory_reconciliations (occurred_at desc);
create index if not exists sq_inv_recon_recipe_idx
  on public.square_inventory_reconciliations (recipe_id);
```

- [ ] **Step 2: Do NOT apply to prod here.**

Per repo policy (`feedback_prod_db_migration_authorization`), migrations are applied to prod only by the user/orchestrator after explicit OK + backup. Note in the PR that `20260722` must be applied before the reconciler runs in prod (the reconciler's insert and the route's read both depend on it).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260722_square_inventory_reconciliations.sql
git commit -m "feat(cold-storage): square_inventory_reconciliations journal table"
```

---

### Task 8: Run the reconciler at the tail of the taproom sync

**Files:**
- Modify: `lib/production/taproomConsumptionSync.ts:49-60` (add field to `TaproomSyncResult`), `:208-221` (call reconciler before return)
- Modify: `lib/production/taproomConsumptionSync.test.ts` (mock the reconciler)

**Interfaces:**
- Consumes: `reconcileSquareCanInventory` (Task 6).
- Produces: `TaproomSyncResult.squareWriteback: { applied: number; writes: ReconcileWrite[]; warnings: string[] }`.

- [ ] **Step 1: Extend the test to assert the reconciler runs for can-sale recipes**

Add to `lib/production/taproomConsumptionSync.test.ts` a mock and assertion. At the top with the other `vi.mock` calls:

```ts
vi.mock("@/lib/production/reconcileSquareCanInventory", () => ({
  reconcileSquareCanInventory: vi.fn(async () => ({ writes: [], skips: [], warnings: [], applied: 0 })),
}));
```

Then in a test that already drives a can sale through `runTaproomConsumptionSync`, import and assert:

```ts
import { reconcileSquareCanInventory } from "@/lib/production/reconcileSquareCanInventory";
// …after running the sync with at least one can_sale unit:
expect(reconcileSquareCanInventory).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({ recipeIds: expect.arrayContaining([/* the can-sale recipeId */ "r-can"]) }),
);
```

(If the existing suite has no can-sale fixture, add one modeled on the existing keg/can unit fixtures in that file so a `can_sale` unit with `recipeId: "r-can"` flows through.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- taproomConsumptionSync`
Expected: FAIL — `reconcileSquareCanInventory` not called / field missing.

- [ ] **Step 3: Add the field to `TaproomSyncResult`**

In the `TaproomSyncResult` interface (`taproomConsumptionSync.ts:49-60`) add:

```ts
  squareWriteback: { applied: number; writes: import("./reconcileSquareCanInventory").ReconcileWrite[]; warnings: string[] };
```

- [ ] **Step 4: Call the reconciler before the return**

Add the import near the top of `taproomConsumptionSync.ts`:

```ts
import { reconcileSquareCanInventory } from "@/lib/production/reconcileSquareCanInventory";
```

Between the end of the `for (const u of units)` loop (line 208) and the final `return { … }` (line 210), insert:

```ts
  // Reflect cold storage back onto Square for every can recipe this run touched.
  // Cold storage trumps: this writes the loose-can total onto each family's base
  // Square variation. Best-effort — a Square failure is logged, never fatal.
  const canRecipeIds = [...new Set(units.filter((u) => u.kind === "can_sale").map((u) => u.recipeId))];
  let squareWriteback = { applied: 0, writes: [] as import("./reconcileSquareCanInventory").ReconcileWrite[], warnings: [] as string[] };
  if (canRecipeIds.length > 0) {
    try {
      const rc = await reconcileSquareCanInventory(supabase, { recipeIds: canRecipeIds });
      squareWriteback = { applied: rc.applied, writes: rc.writes, warnings: rc.warnings };
    } catch (e) {
      squareWriteback.warnings.push(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
```

Then add `squareWriteback,` to the returned object literal (line 210-221).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- taproomConsumptionSync`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/production/taproomConsumptionSync.ts lib/production/taproomConsumptionSync.test.ts
git commit -m "feat(cold-storage): reconcile Square can inventory at the tail of the taproom sync"
```

---

# Phase C — UI: reconcile notice on the Inventory subtab

### Task 9: Type the reconcile payload and thread it into `InventoryTab`

**Files:**
- Modify: `app/taproom/components/InventoryTab.tsx:102-151` (fetch type + banner)

**Interfaces:**
- Consumes: the route now returns `{ ...InventoryGrid, reconciliations: ReconEvent[] }` (Task 3).
- Produces: local `interface ReconEvent { recipe_id: string | null; base_variation_name: string | null; cold_storage_cans: number; square_cans_before: number; drift: number; occurred_at: string }` and `type TaproomInventoryResponse = InventoryGrid & { reconciliations: ReconEvent[] }`.

- [ ] **Step 1: Update the query type**

Change the `useQuery` generic (`InventoryTab.tsx:103-106`) from `InventoryGrid` to a response type that includes reconciliations:

```tsx
interface ReconEvent {
  recipe_id: string | null;
  base_variation_name: string | null;
  cold_storage_cans: number;
  square_cans_before: number;
  drift: number;
  occurred_at: string;
}
type TaproomInventoryResponse = InventoryGrid & { reconciliations: ReconEvent[] };

// …
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.taproom.inventory(),
    queryFn: () => fetchJson<TaproomInventoryResponse>("/api/taproom/inventory"),
  });
```

- [ ] **Step 2: Compute a "last reconcile" summary**

After `const q = query.trim().toLowerCase();` add:

```tsx
  const lastReconcile = useMemo(() => {
    const events = data?.reconciliations ?? [];
    if (events.length === 0) return null;
    const latest = events[0].occurred_at;
    // Count corrections from the most recent reconcile batch (same occurred_at).
    const inBatch = events.filter((e) => e.occurred_at === latest);
    return { at: latest, count: inBatch.length, sample: inBatch.slice(0, 3) };
  }, [data]);
```

- [ ] **Step 3: Render the notice with the shared `<Banner>` primitive**

Import the banner (top of file): `import Banner from "@/app/components/ui/Banner";` (default export; props `{ tone?: Tone; className?: string; children }` where `Tone` includes `"info"` — `app/components/ui/tone.ts`). Render it just under the existing header banner (`InventoryTab.tsx:146-151`):

```tsx
      {lastReconcile && (
        <Banner tone="info" className="mb-2">
          Square inventory is auto-synced from cold storage. Last correction{" "}
          {new Date(lastReconcile.at).toLocaleString()} — {lastReconcile.count}{" "}
          {pluralize(lastReconcile.count, "SKU", "SKUs")} adjusted to match cold storage.
        </Banner>
      )}
```

`Banner` renders nothing when `children` is empty, so the `{lastReconcile && …}` guard is what gates it; `tone="info"` maps to the `info` token surface.

- [ ] **Step 4: Verify in the browser**

- With the dev server running, open `/taproom/performance/inventory`.
- If `square_inventory_reconciliations` has recent rows (seed one locally if needed), confirm the info banner renders with the count and timestamp, using token colors (no raw `blue-*`).
- Screenshot as proof.

- [ ] **Step 5: Commit**

```bash
git add app/taproom/components/InventoryTab.tsx
git commit -m "feat(taproom): notice on Inventory subtab when Square was auto-synced from cold storage"
```

---

## Definition of Done

- [ ] `npm run test` passes; `lib/` coverage stays ≥ 86% lines/statements.
- [ ] `npm run lint` and `npm run build` clean.
- [ ] Inventory grid shows cold-storage truth per format (no fractional "cans" for cases); draft still shows bbl on tap.
- [ ] Reconciler writes only the base loose variation, only on drift, only for recipes touched by the sync run; each write is journaled.
- [ ] Migration `20260722` is listed for manual prod apply (with the reconciler code) in the PR description.
- [ ] Inventory subtab shows the auto-sync notice when corrections exist.
- [ ] Pre-flight verification (base-variation assumption) confirmed with the user before Phase B ships.

## Spec-coverage self-check

- Point 1 (source = cold storage): Tasks 1–4. ✅
- Point 2 (cold storage truth for can+keg; break-down already app-side): Tasks 1–2 (keg+can from cold storage); break-down unchanged. ✅
- Point 3 (Square reflects cold storage): Tasks 6, 8. ✅
- Point 4 (sale deducts both; cold storage trumps on drift): consumption path already deducts cold storage; write-back added in Tasks 6, 8; automatic on reconcile. ✅
- Point 5 (reconcile by loose-can total per line item): `planCanReconciliation` + base-loose resolution, Task 6. ✅
- Point 6 (variant packaging differentiated): `groupCanFamilies` by `label_id`, Tasks 5–6. ✅
- Automatic write-back with a clear subtab notice (user's chosen option): Tasks 8 (auto) + 9 (notice). ✅
