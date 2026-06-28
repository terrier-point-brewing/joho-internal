# Export Settings UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 15+ row PackagingFeeSection with a volume-class–grouped UI (~9 rows), and replace the SquareLinkManager flat-list modal with an inline partner-grouped matrix where rows = recipes and columns = container buckets.

**Architecture:** Part A adds a new `/api/production/export-settings/packaging-fee-class` bulk-upsert route that resolves all `packaging_items` in a volume class and writes one `invoice_item_mappings` row per item. Part B expands the `recipe-packaging-variations` join to carry `packaging_items` and `contract_brewing_partners`, derives matrix columns from that data client-side via pure helper functions in `lib/production/recipeLinkMatrix.ts`, and renders the matrix as an inline section in `ExportSettingsPanel.tsx`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (JS v2 client), React Query v5 (@tanstack/react-query), Supabase server client in route handlers.

## Global Constraints

- Business logic lives in `lib/`, never in `app/api/**` or page components
- Route handlers use `createSupabaseServerClient` (read) or `createSupabaseAdminClient` (write) — never browser client
- Auth checks via `requireRole()` from `lib/auth.ts` — wrap the call in `try/catch { return res as Response }` per project pattern
- Do NOT touch `recipes.brewery` for partner grouping — derive from `packaging_variations.partner_id → contract_brewing_partners`
- Do NOT modify existing migration files; no new schema changes needed for this UI work
- Do NOT add a column to `recipe_square_links` — the composite key `(recipe_id, packaging_item_id, packaging_format)` is final
- Do NOT render one UI row per `packaging_items` row in the PackagingFeeSection
- After every mutation, invalidate the relevant React Query key
- `invoice_item_mappings` constraint: for `packaging_fee`, `packaging_item_id IS NOT NULL`, `square_catalog_item_id IS NOT NULL`, `square_catalog_variation_id IS NOT NULL`, `square_catalog_discount_id IS NULL`
- The `invoice_item_mappings` unique constraint is `UNIQUE NULLS NOT DISTINCT (service_type, partner_id, packaging_item_id, packaging_format)` — use `onConflict: 'service_type,partner_id,packaging_item_id,packaging_format'` in upserts

---

## File Map

**New files:**
- `app/api/production/export-settings/packaging-fee-class/route.ts` — POST bulk-upsert invoice_item_mappings by volume class
- `lib/production/recipeLinkMatrix.ts` — pure functions: derive columns, group by partner, resolve cell state, auto-suggest

**Modified files:**
- `app/api/production/recipe-packaging-variations/route.ts:7-14` — expand GET select to join through packaging_items and contract_brewing_partners
- `app/production/types.ts:72-79` — add `RecipePackagingVariationExpanded` (new interface alongside existing `RecipePackagingVariation`)
- `app/production/hooks/queries.ts:140-145` — update `useRecipePackagingVariationsQuery` return type; add `useRecipeSquareLinksQuery`
- `app/production/components/ExportSettingsPanel.tsx:285-345` — rewrite `PackagingFeeSection` using volume-class grouping; add `RecipeLinkMatrix` section
- `app/production/components/ExportTab.tsx:4-8,56-102,173-182` — remove SquareLinkManager import/usage

---

## Task 1: Expand recipe-packaging-variations API join + add RecipePackagingVariationExpanded type

**Files:**
- Modify: `app/api/production/recipe-packaging-variations/route.ts`
- Modify: `app/production/types.ts`

**Interfaces:**
- Produces: `RecipePackagingVariationExpanded` type consumed by Tasks 2 and 3

- [ ] **Step 1: Add `RecipePackagingVariationExpanded` to types.ts**

Open `app/production/types.ts`. After the existing `RecipePackagingVariation` interface (currently ends at line 79), add:

```ts
/** Expanded join used by the RecipeLinkMatrix — includes packaging_items and partner info. */
export interface PackagingVariationExpanded {
  id: string;
  container_id: string;
  format: PackagingVariationFormat;
  partner_id: string | null;
  total_volume_fl_oz: number;
  is_active: boolean;
  packaging_items: {
    id: string;
    name: string;
    type: PackagingItemType;
    volume_fl_oz: number | null;
  } | null;
  contract_brewing_partners: {
    id: string;
    company_name: string;
  } | null;
}

export interface RecipePackagingVariationExpanded {
  id: string;
  recipe_id: string;
  variation_id: string;
  created_at: string;
  packaging_variations: PackagingVariationExpanded | null;
}
```

- [ ] **Step 2: Expand the GET query in `app/api/production/recipe-packaging-variations/route.ts`**

Replace the existing `GET` function:

```ts
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select(`
      id, recipe_id, variation_id, created_at,
      packaging_variations(
        id, container_id, format, partner_id, total_volume_fl_oz, is_active,
        packaging_items:container_id(id, name, type, volume_fl_oz),
        contract_brewing_partners(id, company_name)
      )
    `)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

- [ ] **Step 3: Verify the join works**

Run `npm run dev` and curl (or open in browser):
```
GET /api/production/recipe-packaging-variations
```
Expected: each row has `packaging_variations.packaging_items` (object with id/name/type/volume_fl_oz) and `packaging_variations.contract_brewing_partners` (object or null). Not a nested array — Supabase returns the related row as an object for to-one joins.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/recipe-packaging-variations/route.ts app/production/types.ts
git commit -m "feat: expand recipe-packaging-variations join + RecipePackagingVariationExpanded type"
```

---

## Task 2: Update useRecipePackagingVariationsQuery + add useRecipeSquareLinksQuery

**Files:**
- Modify: `app/production/hooks/queries.ts`

**Interfaces:**
- Consumes: `RecipePackagingVariationExpanded` from Task 1
- Produces: `useRecipePackagingVariationsQuery()` returning `RecipePackagingVariationExpanded[]`; `useRecipeSquareLinksQuery()` returning `LinkRow[]`

Note: `LinkRow` is currently defined in `app/production/components/SquareLinkManager.tsx`. We need it here. Rather than moving it, import it or redefine a minimal version in `types.ts`. Because Task 7 keeps `SquareLinkManager.tsx` in place but stops importing it, the cleanest path is to add `RecipeSquareLink` export to `types.ts` (it already exists as `RecipeSquareLink`). The `LinkRow` type used by hooks can match the shape returned by the API — use an inline interface in the hook file.

- [ ] **Step 1: Add `RecipeSquareLinkRow` to `app/production/types.ts`**

After the existing `RecipeSquareLink` interface add:

```ts
/** Shape returned by GET /api/production/recipe-square-links (includes joined recipe + packaging_items). */
export interface RecipeSquareLinkRow {
  id: string;
  recipe_id: string;
  packaging: "draft" | "keg" | "can";
  packaging_item_id: string | null;
  packaging_format: string | null;
  square_variation_id: string;
  square_item_id: string | null;
  variation_name: string | null;
  item_name: string | null;
  created_at: string;
  recipes?: { beer_name: string } | null;
  packaging_items?: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
}
```

- [ ] **Step 2: Update `useRecipePackagingVariationsQuery` in queries.ts**

Change the import at the top of `app/production/hooks/queries.ts` — add `RecipePackagingVariationExpanded, RecipeSquareLinkRow` to the import from `"../types"`:

```ts
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier, ExciseTaxRate, ExportServiceMapping, SquareCatalogOptions,
  PackagingVariation, RecipePackagingVariation, RecipePackagingVariationExpanded,
  RecipeSquareLinkRow, BatchConversion,
} from "../types";
```

Then update `useRecipePackagingVariationsQuery` (currently at lines 140–145):

```ts
export function useRecipePackagingVariationsQuery() {
  return useQuery({
    queryKey: productionKeys.recipePackagingVariations,
    queryFn: () => fetchJson<RecipePackagingVariationExpanded[]>("/api/production/recipe-packaging-variations"),
  });
}
```

- [ ] **Step 3: Add `useRecipeSquareLinksQuery` hook**

At the end of `app/production/hooks/queries.ts`, add:

```ts
export function useRecipeSquareLinksQuery() {
  return useQuery({
    queryKey: queryKeys.production.recipeSquareLinks(),
    queryFn: () => fetchJson<RecipeSquareLinkRow[]>("/api/production/recipe-square-links"),
  });
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "error TS|Type error" | head -20
```

Expected: no errors referencing the changed files.

- [ ] **Step 5: Commit**

```bash
git add app/production/hooks/queries.ts app/production/types.ts
git commit -m "feat: update RecipePackagingVariations hook to expanded type + add RecipeSquareLinks hook"
```

---

## Task 3: Matrix derivation helpers in lib/production/recipeLinkMatrix.ts

**Files:**
- Create: `lib/production/recipeLinkMatrix.ts`

**Interfaces:**
- Consumes: `RecipePackagingVariationExpanded` (Task 1), `RecipeSquareLinkRow` (Task 2), `Recipe`, `SquareCatalogOptions` from `app/production/types.ts`
- Produces: `MatrixColumn`, `MatrixGroup`, `MatrixCell`, `buildMatrix()`, `autoSuggest()`, `resolvePackagingItemId()`

The matrix columns are `DISTINCT (pi.type, pi.volume_fl_oz, pv.format)` across all active recipe_packaging_variations. A column uniquely identifies a container bucket. For kegs, `pv.format` differentiates variation types (though in practice kegs typically have only one format per size). For cans, `pv.format` is 'loose'/'4-pack'/'6-pack'/'case'.

When saving a `recipe_square_link` for a cell:
- keg: `packaging_format = null`, `packaging_item_id = rpv.packaging_variations.container_id`
- can: `packaging_format = pv.format`, `packaging_item_id = rpv.packaging_variations.container_id`

- [ ] **Step 1: Create `lib/production/recipeLinkMatrix.ts`**

```ts
import type {
  RecipePackagingVariationExpanded,
  RecipeSquareLinkRow,
  Recipe,
  SquareCatalogOptions,
  PackagingItemType,
  PackagingVariationFormat,
} from "@/app/production/types";

// ─── Column ──────────────────────────────────────────────────────────────────

export interface MatrixColumn {
  /** Stable string key: `${piType}|${volumeFlOz}|${pvFormat}` */
  key: string;
  piType: PackagingItemType;
  volumeFlOz: number;
  pvFormat: PackagingVariationFormat;
  label: string;
}

function colKey(piType: PackagingItemType, volumeFlOz: number, pvFormat: PackagingVariationFormat): string {
  return `${piType}|${volumeFlOz}|${pvFormat}`;
}

const KEG_VOL_LABELS: Record<number, string> = { 1984: "1/2 BBL", 992: "1/4 BBL", 661: "1/6 BBL" };

function colLabel(piType: PackagingItemType, volumeFlOz: number, pvFormat: PackagingVariationFormat): string {
  if (piType === "keg") {
    const size = KEG_VOL_LABELS[volumeFlOz] ?? `${volumeFlOz} fl oz`;
    return `${size} Keg`;
  }
  const formatLabel: Record<PackagingVariationFormat, string> = {
    loose: "Loose",
    "4-pack": "4-Pack",
    "6-pack": "6-Pack",
    case: "Case",
  };
  return `${volumeFlOz}oz ${formatLabel[pvFormat] ?? pvFormat}`;
}

/** Derive the ordered set of columns from active recipe_packaging_variations. */
export function deriveColumns(rpvs: RecipePackagingVariationExpanded[]): MatrixColumn[] {
  const seen = new Map<string, MatrixColumn>();
  for (const rpv of rpvs) {
    const pv = rpv.packaging_variations;
    if (!pv || !pv.is_active) continue;
    const pi = pv.packaging_items;
    if (!pi || pi.volume_fl_oz == null) continue;
    if (pi.type !== "keg" && pi.type !== "can") continue;
    const k = colKey(pi.type, pi.volume_fl_oz, pv.format);
    if (!seen.has(k)) {
      seen.set(k, {
        key: k,
        piType: pi.type,
        volumeFlOz: pi.volume_fl_oz,
        pvFormat: pv.format,
        label: colLabel(pi.type, pi.volume_fl_oz, pv.format),
      });
    }
  }
  // Order: kegs (descending volume) then cans (ascending volume, then loose/4-pack/6-pack/case)
  const FORMAT_ORDER: Record<PackagingVariationFormat, number> = { loose: 0, "4-pack": 1, "6-pack": 2, case: 3 };
  return [...seen.values()].sort((a, b) => {
    if (a.piType !== b.piType) return a.piType === "keg" ? -1 : 1;
    if (a.piType === "keg") return b.volumeFlOz - a.volumeFlOz; // bigger keg first
    if (a.volumeFlOz !== b.volumeFlOz) return a.volumeFlOz - b.volumeFlOz;
    return (FORMAT_ORDER[a.pvFormat] ?? 99) - (FORMAT_ORDER[b.pvFormat] ?? 99);
  });
}

// ─── Cell ────────────────────────────────────────────────────────────────────

export type CellState = "linked" | "suggested" | "empty" | "na";

export interface CellSuggestion {
  itemId: string;
  variationId: string;
  itemName: string;
  variationName: string;
}

export interface MatrixCell {
  state: CellState;
  /** packaging_item_id to use when POSTing a recipe_square_link for this cell */
  packagingItemId: string | null;
  /** packaging_format to use when POSTing (null for kegs) */
  packagingFormat: PackagingVariationFormat | null;
  /** Set when state === "linked" */
  linkId: string | null;
  variationId: string | null;
  variationName: string | null;
  itemName: string | null;
  /** Set when state === "suggested" */
  suggestion: CellSuggestion | null;
}

// ─── Row / Group ─────────────────────────────────────────────────────────────

export interface MatrixRow {
  recipeId: string;
  beerName: string;
  cells: Map<string, MatrixCell>; // colKey → cell
}

export interface MatrixGroup {
  partnerId: string | null;
  partnerName: string;
  rows: MatrixRow[];
}

// ─── Auto-suggest ─────────────────────────────────────────────────────────────

export function autoSuggest(beerName: string, catalog: SquareCatalogOptions): CellSuggestion | null {
  const lower = beerName.toLowerCase();
  for (const item of catalog.items) {
    if (item.itemName.toLowerCase().includes(lower)) {
      const v = item.variations[0];
      if (v) {
        return {
          itemId: item.itemId,
          variationId: v.variationId,
          itemName: item.itemName,
          variationName: v.variationName,
        };
      }
    }
  }
  return null;
}

// ─── Cell resolver ────────────────────────────────────────────────────────────

/**
 * Given a recipe + column, find the packaging_item_id from recipe_packaging_variations.
 * Returns null if this recipe has no variation matching the column.
 */
export function resolvePackagingItemId(
  recipeId: string,
  col: MatrixColumn,
  rpvs: RecipePackagingVariationExpanded[]
): string | null {
  const match = rpvs.find(
    (rpv) =>
      rpv.recipe_id === recipeId &&
      rpv.packaging_variations?.is_active === true &&
      rpv.packaging_variations?.packaging_items?.type === col.piType &&
      rpv.packaging_variations?.packaging_items?.volume_fl_oz === col.volumeFlOz &&
      rpv.packaging_variations?.format === col.pvFormat
  );
  return match?.packaging_variations?.container_id ?? null;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildMatrix(
  recipes: Recipe[],
  rpvs: RecipePackagingVariationExpanded[],
  links: RecipeSquareLinkRow[],
  catalog: SquareCatalogOptions,
  columns: MatrixColumn[]
): MatrixGroup[] {
  // Build a lookup: `${recipe_id}|${packaging_item_id}|${packaging_format ?? ""}` → link row
  const linkMap = new Map<string, RecipeSquareLinkRow>();
  for (const l of links) {
    if (!l.packaging_item_id) continue;
    const key = `${l.recipe_id}|${l.packaging_item_id}|${l.packaging_format ?? ""}`;
    linkMap.set(key, l);
  }

  // Determine which recipes have which variations (recipe_id → Set<colKey>)
  const recipeColKeys = new Map<string, Set<string>>();
  for (const rpv of rpvs) {
    const pv = rpv.packaging_variations;
    if (!pv || !pv.is_active) continue;
    const pi = pv.packaging_items;
    if (!pi || pi.volume_fl_oz == null) continue;
    if (pi.type !== "keg" && pi.type !== "can") continue;
    const k = colKey(pi.type, pi.volume_fl_oz, pv.format);
    if (!recipeColKeys.has(rpv.recipe_id)) recipeColKeys.set(rpv.recipe_id, new Set());
    recipeColKeys.get(rpv.recipe_id)!.add(k);
  }

  // Determine partner for each recipe (via packaging_variations.partner_id)
  // A recipe may appear in multiple partner groups if it has variations for multiple partners.
  // Group by first/primary partner found; house beers have partner_id = null.
  const recipePartner = new Map<string, { partnerId: string | null; partnerName: string }>();
  for (const rpv of rpvs) {
    const pv = rpv.packaging_variations;
    if (!pv || !pv.is_active) continue;
    if (recipePartner.has(rpv.recipe_id)) continue;
    recipePartner.set(rpv.recipe_id, {
      partnerId: pv.partner_id,
      partnerName: pv.contract_brewing_partners?.company_name ?? "House Beers",
    });
  }

  // Build groups
  const groups = new Map<string | null, MatrixGroup>();
  for (const recipe of recipes) {
    const partnerInfo = recipePartner.get(recipe.id) ?? { partnerId: null, partnerName: "House Beers" };
    const { partnerId, partnerName } = partnerInfo;

    if (!groups.has(partnerId)) {
      groups.set(partnerId, { partnerId, partnerName, rows: [] });
    }

    const colKeysForRecipe = recipeColKeys.get(recipe.id) ?? new Set<string>();
    if (colKeysForRecipe.size === 0) continue; // recipe has no active packaging variations

    const cells = new Map<string, MatrixCell>();
    for (const col of columns) {
      if (!colKeysForRecipe.has(col.key)) {
        cells.set(col.key, { state: "na", packagingItemId: null, packagingFormat: null, linkId: null, variationId: null, variationName: null, itemName: null, suggestion: null });
        continue;
      }

      const piId = resolvePackagingItemId(recipe.id, col, rpvs);
      if (!piId) {
        cells.set(col.key, { state: "na", packagingItemId: null, packagingFormat: null, linkId: null, variationId: null, variationName: null, itemName: null, suggestion: null });
        continue;
      }

      const pfmt = col.piType === "can" ? col.pvFormat : null;
      const linkKey = `${recipe.id}|${piId}|${pfmt ?? ""}`;
      const link = linkMap.get(linkKey);

      if (link) {
        cells.set(col.key, {
          state: "linked",
          packagingItemId: piId,
          packagingFormat: pfmt,
          linkId: link.id,
          variationId: link.square_variation_id,
          variationName: link.variation_name,
          itemName: link.item_name,
          suggestion: null,
        });
      } else {
        const suggestion = autoSuggest(recipe.beer_name, catalog);
        cells.set(col.key, {
          state: suggestion ? "suggested" : "empty",
          packagingItemId: piId,
          packagingFormat: pfmt,
          linkId: null,
          variationId: null,
          variationName: null,
          itemName: null,
          suggestion,
        });
      }
    }

    groups.get(partnerId)!.rows.push({
      recipeId: recipe.id,
      beerName: recipe.beer_name,
      cells,
    });
  }

  // Sort: house beers (null partnerId) first, then partners alphabetically
  return [...groups.values()].sort((a, b) => {
    if (a.partnerId === null) return -1;
    if (b.partnerId === null) return 1;
    return a.partnerName.localeCompare(b.partnerName);
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "error TS|Type error" | head -20
```

Expected: no errors in `lib/production/recipeLinkMatrix.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/production/recipeLinkMatrix.ts
git commit -m "feat: matrix derivation helpers in lib/production/recipeLinkMatrix.ts"
```

---

## Task 4: New packaging-fee-class bulk upsert route

**Files:**
- Create: `app/api/production/export-settings/packaging-fee-class/route.ts`

**Interfaces:**
- Consumes: `invoice_item_mappings` table, `packaging_items` table
- Produces: POST endpoint that upserts one row per matching packaging_item

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    type: "keg" | "can";
    volume_fl_oz: number;
    format: "case" | "loose" | null;
    partner_id: string | null;
    square_catalog_item_id: string;
    square_catalog_variation_id: string;
    display_name: string;
  };

  if (!body.type || body.volume_fl_oz == null) {
    return NextResponse.json({ error: "type and volume_fl_oz are required" }, { status: 400 });
  }
  if (!body.square_catalog_item_id || !body.square_catalog_variation_id) {
    return NextResponse.json({ error: "square_catalog_item_id and square_catalog_variation_id are required" }, { status: 400 });
  }
  if (body.type === "can" && !body.format) {
    return NextResponse.json({ error: "format ('case' or 'loose') is required for can items" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Find all packaging_items in this volume class
  const { data: items, error: itemsErr } = await supabase
    .from("packaging_items")
    .select("id")
    .eq("type", body.type)
    .eq("volume_fl_oz", body.volume_fl_oz);

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json({ error: `No packaging_items found for type=${body.type} volume_fl_oz=${body.volume_fl_oz}` }, { status: 404 });
  }

  const rows = items.map((item) => ({
    service_type: "packaging_fee" as const,
    partner_id: body.partner_id ?? null,
    packaging_item_id: item.id,
    packaging_format: body.format ?? null,
    square_catalog_item_id: body.square_catalog_item_id,
    square_catalog_variation_id: body.square_catalog_variation_id,
    square_catalog_discount_id: null,
    display_name: body.display_name,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertErr } = await supabase
    .from("invoice_item_mappings")
    .upsert(rows, { onConflict: "service_type,partner_id,packaging_item_id,packaging_format" });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  return NextResponse.json({ updated: rows.length });
}
```

- [ ] **Step 2: Test the route manually**

Run the dev server and send:
```bash
curl -X POST http://localhost:3000/api/production/export-settings/packaging-fee-class \
  -H 'Content-Type: application/json' \
  -d '{"type":"keg","volume_fl_oz":661,"format":null,"partner_id":null,"square_catalog_item_id":"FAKE","square_catalog_variation_id":"FAKE","display_name":"Packaging Fee"}'
```

Expected: `{ "updated": N }` where N = number of 1/6 keg packaging_items in DB (typically 3–4: generic + partner-specific).

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export-settings/packaging-fee-class/route.ts
git commit -m "feat: packaging-fee-class bulk upsert API route"
```

---

## Task 5: RecipeLinkMatrix component

**Files:**
- Create: `app/production/components/RecipeLinkMatrix.tsx`

**Interfaces:**
- Consumes: `buildMatrix`, `deriveColumns`, `MatrixGroup`, `MatrixCell`, `MatrixColumn` from Task 3; `useRecipePackagingVariationsQuery`, `useRecipesQuery`, `useRecipeSquareLinksQuery`, `useExportSquareCatalogQuery` from queries.ts (Tasks 1–2); `SquareCatalogSelect` from `@/app/components/SquareCatalogSelect`
- Produces: `RecipeLinkMatrix` default export, inline section (no modal)

This component renders a partner-grouped matrix. Each cell can be:
- **linked** (green): existing recipe_square_link found — show variation name + trash icon
- **suggested** (amber): auto-suggest found but not confirmed — show "Accept" button
- **empty** (gray "—"): no match, click opens SquareCatalogSelect inline
- **n/a** (dimmed): recipe has no variation for this column — show "—" grayed out, no interaction

- [ ] **Step 1: Create `app/production/components/RecipeLinkMatrix.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useRecipePackagingVariationsQuery,
  useRecipesQuery,
  useRecipeSquareLinksQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import { buildMatrix, deriveColumns } from "@/lib/production/recipeLinkMatrix";
import type { MatrixColumn, MatrixCell, MatrixGroup } from "@/lib/production/recipeLinkMatrix";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

// ─── Cell component ──────────────────────────────────────────────────────────

function MatrixCellView({
  cell,
  col,
  onLink,
  onDelete,
}: {
  cell: MatrixCell;
  col: MatrixColumn;
  onLink: (variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: catalog } = useExportSquareCatalogQuery();
  const items = catalog?.items ?? [];

  if (cell.state === "na") {
    return <span className="text-zinc-800 text-xs select-none">—</span>;
  }

  if (cell.state === "linked") {
    return (
      <div className="flex items-center gap-1 group">
        <span className="text-emerald-400 text-[11px] leading-tight">
          ✓ {cell.variationName ?? cell.itemName ?? "linked"}
        </span>
        <button
          className="text-zinc-700 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
          onClick={async () => {
            if (!cell.linkId) return;
            setSaving(true);
            await onDelete(cell.linkId);
            setSaving(false);
          }}
          disabled={saving}
          title="Remove link"
        >
          ×
        </button>
      </div>
    );
  }

  if (cell.state === "suggested" && !editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-amber-400 text-[11px] leading-tight">
          ~ {cell.suggestion?.variationName ?? cell.suggestion?.itemName ?? "suggested"}
        </span>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-amber-500 hover:text-amber-300 underline"
            disabled={saving}
            onClick={async () => {
              if (!cell.suggestion) return;
              setSaving(true);
              await onLink(
                cell.suggestion.variationId,
                cell.suggestion.itemId,
                cell.suggestion.variationName,
                cell.suggestion.itemName
              );
              setSaving(false);
            }}
          >
            Accept
          </button>
          <button
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  if (editing || cell.state === "empty") {
    if (!editing) {
      return (
        <button
          className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors"
          onClick={() => setEditing(true)}
        >
          + link
        </button>
      );
    }
    return (
      <div className="min-w-[200px]">
        <SquareCatalogSelect
          items={items}
          itemId={null}
          variationId={null}
          onChange={async (itemId, variationId) => {
            if (!variationId || !itemId) { setEditing(false); return; }
            const catalogItem = items.find((i) => i.itemId === itemId);
            const catalogVariation = catalogItem?.variations.find((v) => v.variationId === variationId);
            setSaving(true);
            await onLink(
              variationId,
              itemId,
              catalogVariation?.variationName ?? "",
              catalogItem?.itemName ?? ""
            );
            setSaving(false);
            setEditing(false);
          }}
        />
        <button
          className="text-[10px] text-zinc-600 hover:text-zinc-400 mt-0.5"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return null;
}

// ─── Group row table ──────────────────────────────────────────────────────────

function MatrixGroupTable({
  group,
  columns,
  onLink,
  onDelete,
  onAcceptAll,
}: {
  group: MatrixGroup;
  columns: MatrixColumn[];
  onLink: (recipeId: string, cell: MatrixCell, variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
  onAcceptAll: (group: MatrixGroup) => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const hasSuggestions = group.rows.some((r) =>
    [...r.cells.values()].some((c) => c.state === "suggested")
  );

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          {group.partnerName}
        </h4>
        {hasSuggestions && (
          <button
            disabled={accepting}
            onClick={async () => {
              setAccepting(true);
              await onAcceptAll(group);
              setAccepting(false);
            }}
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
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap w-40">Recipe</th>
              {columns.map((col) => (
                <th key={col.key} className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.recipeId} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/20">
                <td className="px-3 py-2.5 text-zinc-200 font-medium whitespace-nowrap">{row.beerName}</td>
                {columns.map((col) => {
                  const cell = row.cells.get(col.key) ?? {
                    state: "na" as const, packagingItemId: null, packagingFormat: null,
                    linkId: null, variationId: null, variationName: null, itemName: null, suggestion: null,
                  };
                  return (
                    <td key={col.key} className="px-3 py-2.5 align-top">
                      <MatrixCellView
                        cell={cell}
                        col={col}
                        onLink={(vId, iId, vName, iName) =>
                          onLink(row.recipeId, cell, vId, iId, vName, iName)
                        }
                        onDelete={onDelete}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function RecipeLinkMatrix() {
  const qc = useQueryClient();
  const { data: rpvs = [] } = useRecipePackagingVariationsQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: links = [] } = useRecipeSquareLinksQuery();
  const { data: catalog } = useExportSquareCatalogQuery();

  const columns = deriveColumns(rpvs);
  const groups: MatrixGroup[] = catalog
    ? buildMatrix(recipes, rpvs, links, catalog, columns)
    : [];

  async function refreshLinks() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
  }

  async function handleLink(
    recipeId: string,
    cell: MatrixCell,
    variationId: string,
    itemId: string,
    variationName: string,
    itemName: string
  ) {
    if (!cell.packagingItemId) return;
    const res = await fetch("/api/production/recipe-square-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_id: recipeId,
        packaging: cell.packagingItemId ? "can" : "keg", // resolved below
        packaging_item_id: cell.packagingItemId,
        packaging_format: cell.packagingFormat ?? null,
        square_variation_id: variationId,
        square_item_id: itemId,
        variation_name: variationName,
        item_name: itemName,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to save link");
      return;
    }
    await refreshLinks();
  }

  async function handleLinkWithType(
    recipeId: string,
    cell: MatrixCell,
    col: MatrixColumn,
    variationId: string,
    itemId: string,
    variationName: string,
    itemName: string
  ) {
    if (!cell.packagingItemId) return;
    const packaging = col.piType === "keg" ? "keg" : "can";
    const res = await fetch("/api/production/recipe-square-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_id: recipeId,
        packaging,
        packaging_item_id: cell.packagingItemId,
        packaging_format: cell.packagingFormat ?? null,
        square_variation_id: variationId,
        square_item_id: itemId,
        variation_name: variationName,
        item_name: itemName,
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

  async function handleAcceptAll(group: MatrixGroup) {
    const toSave: Array<{ recipeId: string; cell: MatrixCell; col: MatrixColumn }> = [];
    for (const row of group.rows) {
      for (const col of columns) {
        const cell = row.cells.get(col.key);
        if (cell?.state === "suggested" && cell.suggestion && cell.packagingItemId) {
          toSave.push({ recipeId: row.recipeId, cell, col });
        }
      }
    }
    await Promise.all(
      toSave.map(({ recipeId, cell, col }) =>
        handleLinkWithType(
          recipeId,
          cell,
          col,
          cell.suggestion!.variationId,
          cell.suggestion!.itemId,
          cell.suggestion!.variationName,
          cell.suggestion!.itemName
        )
      )
    );
  }

  if (columns.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic">
        No active packaging variations found. Add recipe–variation links in the Packaging tab first.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-4">
        Map each recipe + container format to a Square catalog variation. Green = linked, amber = auto-suggested (review before accepting), + link = unlinked.
      </p>
      {groups.map((group) => (
        <MatrixGroupTable
          key={group.partnerId ?? "__house__"}
          group={group}
          columns={columns}
          onLink={(recipeId, cell, vId, iId, vName, iName) => {
            const col = columns.find((c) => {
              const cellFromMap = group.rows
                .find((r) => r.recipeId === recipeId)
                ?.cells.get(c.key);
              return cellFromMap === cell;
            });
            if (!col) return Promise.resolve();
            return handleLinkWithType(recipeId, cell, col, vId, iId, vName, iName);
          }}
          onDelete={handleDelete}
          onAcceptAll={handleAcceptAll}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Fix the `onLink` closure — find col by cell reference won't work reliably**

The `onLink` prop passed to `MatrixGroupTable` needs access to the column. Refactor `MatrixGroupTable` to pass `col` alongside `cell` in the `onLink` callback:

Update `MatrixGroupTable`'s `onLink` prop type:
```ts
onLink: (recipeId: string, cell: MatrixCell, col: MatrixColumn, variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
```

Update the call in `MatrixGroupTable`:
```tsx
onLink={(vId, iId, vName, iName) =>
  onLink(row.recipeId, cell, col, vId, iId, vName, iName)
}
```

Update the `MatrixCellView` props and its `onLink` callback accordingly:
```ts
// MatrixCellView: keep the same signature
onLink: (variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
```

Then update `RecipeLinkMatrix`'s usage of `MatrixGroupTable`:
```tsx
onLink={(recipeId, cell, col, vId, iId, vName, iName) =>
  handleLinkWithType(recipeId, cell, col, vId, iId, vName, iName)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "error TS|Type error" | head -20
```

Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/RecipeLinkMatrix.tsx
git commit -m "feat: RecipeLinkMatrix inline partner-grouped matrix component"
```

---

## Task 6: Rewrite PackagingFeeSection + wire RecipeLinkMatrix into ExportSettingsPanel

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx`

**Goal:**
1. Replace `PackagingFeeContainerSection` / `PackagingFeeSection` (current lines 199–345) with a volume-class–grouped UI
2. Add a "Product Square Links" section under `scope === "full"` rendering `RecipeLinkMatrix`

### Understanding the new PackagingFeeSection

Volume class = `(pi.type, pi.volume_fl_oz, format)` where format ∈ {'loose','case',null}. We derive the set of volume classes from `usePackagingQuery()`:

```ts
type VolumeClass = {
  piType: "keg" | "can";
  volumeFlOz: number;
  format: "loose" | "case" | null;
  label: string;
};
```

For each `packaging_item` of type keg/can, compute its volume class. Kegs have format=null. Cans get two rows (format='loose', format='case').

To look up the current Square mapping for a volume class: find any `invoice_item_mappings` row where `service_type='packaging_fee'` and `packaging_item_id` is in the set of items for that volume class and `packaging_format = class.format`.

On save: POST to `/api/production/export-settings/packaging-fee-class`.

- [ ] **Step 1: Add imports at the top of ExportSettingsPanel.tsx**

```tsx
import RecipeLinkMatrix from "./RecipeLinkMatrix";
import { usePackagingVariationsQuery, useRecipePackagingVariationsQuery } from "../hooks/queries";
```

(Note: `usePackagingVariationsQuery` and `usePackagingQuery` are already imported — just add `RecipeLinkMatrix` and any missing hooks.)

- [ ] **Step 2: Replace PackagingFeeContainerSection and PackagingFeeSection with new implementations**

Remove `PackagingFeeContainerSection` (lines 199–283) and `PackagingFeeSection` (lines 285–345) entirely. Insert:

```tsx
const KEG_VOL_LABELS: Record<number, string> = { 1984: "1/2 BBL", 992: "1/4 BBL", 661: "1/6 BBL" };
const CAN_FORMAT_LABELS: Record<"loose" | "case", string> = { loose: "Loose Can", case: "Case" };

interface VolumeClass {
  piType: "keg" | "can";
  volumeFlOz: number;
  format: "loose" | "case" | null;
  label: string;
}

function deriveVolumeClasses(packagingItems: { id: string; type: string; volume_fl_oz: number | null }[]): VolumeClass[] {
  const seen = new Map<string, VolumeClass>();
  for (const pi of packagingItems) {
    if ((pi.type !== "keg" && pi.type !== "can") || pi.volume_fl_oz == null) continue;
    const piType = pi.type as "keg" | "can";
    const vol = pi.volume_fl_oz;
    if (piType === "keg") {
      const k = `keg|${vol}|null`;
      if (!seen.has(k)) {
        const size = KEG_VOL_LABELS[vol] ?? `${vol} fl oz`;
        seen.set(k, { piType, volumeFlOz: vol, format: null, label: `${size} Keg` });
      }
    } else {
      for (const fmt of ["loose", "case"] as const) {
        const k = `can|${vol}|${fmt}`;
        if (!seen.has(k)) {
          seen.set(k, { piType, volumeFlOz: vol, format: fmt, label: `${vol}oz Can · ${CAN_FORMAT_LABELS[fmt]}` });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.piType !== b.piType) return a.piType === "keg" ? -1 : 1;
    if (a.piType === "keg") return b.volumeFlOz - a.volumeFlOz;
    if (a.volumeFlOz !== b.volumeFlOz) return a.volumeFlOz - b.volumeFlOz;
    return (a.format === "loose" ? 0 : 1) - (b.format === "loose" ? 0 : 1);
  });
}

function VolumeClassRow({
  vc,
  packagingItems,
  feeRows,
  partners,
  items,
  onSave,
}: {
  vc: VolumeClass;
  packagingItems: { id: string; type: string; volume_fl_oz: number | null }[];
  feeRows: ExportServiceMapping[];
  partners: { id: string; company_name: string }[];
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  onSave: (payload: {
    type: "keg" | "can"; volume_fl_oz: number; format: "case" | "loose" | null;
    partner_id: string | null; square_catalog_item_id: string | null; square_catalog_variation_id: string | null;
    display_name: string;
  }) => Promise<void>;
}) {
  const classItemIds = new Set(
    packagingItems
      .filter((pi) => pi.type === vc.piType && pi.volume_fl_oz === vc.volumeFlOz)
      .map((pi) => pi.id)
  );

  function getMapping(partnerId: string | null): ExportServiceMapping | null {
    return (
      feeRows.find(
        (m) => m.packaging_item_id !== null && classItemIds.has(m.packaging_item_id) &&
          m.packaging_format === vc.format && m.partner_id === partnerId
      ) ?? null
    );
  }

  const defaultRow = getMapping(null);
  const overridePartnerIds = new Set(
    feeRows
      .filter((m) => m.packaging_item_id !== null && classItemIds.has(m.packaging_item_id) && m.packaging_format === vc.format && m.partner_id !== null)
      .map((m) => m.partner_id!)
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-zinc-300">{vc.label}</span>
      <div className="flex items-center gap-2 pl-3">
        <span className="text-xs text-zinc-500 italic w-28">Default</span>
        <SquareCatalogSelect
          items={items}
          itemId={defaultRow?.square_catalog_item_id ?? null}
          variationId={defaultRow?.square_catalog_variation_id ?? null}
          onChange={(itemId, variationId) =>
            onSave({
              type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
              partner_id: null, square_catalog_item_id: itemId, square_catalog_variation_id: variationId,
              display_name: "Packaging Fee",
            })
          }
        />
      </div>
      {[...overridePartnerIds].map((partnerId) => {
        const partner = partners.find((p) => p.id === partnerId);
        const overrideRow = getMapping(partnerId);
        return (
          <div key={partnerId} className="flex items-center gap-2 pl-3">
            <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown"}</span>
            <SquareCatalogSelect
              items={items}
              itemId={overrideRow?.square_catalog_item_id ?? null}
              variationId={overrideRow?.square_catalog_variation_id ?? null}
              onChange={(itemId, variationId) =>
                onSave({
                  type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
                  partner_id: partnerId, square_catalog_item_id: itemId, square_catalog_variation_id: variationId,
                  display_name: "Packaging Fee",
                })
              }
            />
          </div>
        );
      })}
      <div className="pl-3">
        <PartnerOverridePicker
          partners={partners}
          excludeIds={overridePartnerIds}
          onAdd={(partnerId) =>
            onSave({
              type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format,
              partner_id: partnerId, square_catalog_item_id: null, square_catalog_variation_id: null,
              display_name: "Packaging Fee",
            })
          }
        />
      </div>
    </div>
  );
}

function PackagingFeeSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");
  const volumeClasses = deriveVolumeClasses(packagingItems);

  async function save(payload: {
    type: "keg" | "can"; volume_fl_oz: number; format: "case" | "loose" | null;
    partner_id: string | null; square_catalog_item_id: string | null; square_catalog_variation_id: string | null;
    display_name: string;
  }) {
    if (!payload.square_catalog_item_id || !payload.square_catalog_variation_id) return;
    await fetch("/api/production/export-settings/packaging-fee-class", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Packaging Fee</h4>
      <p className="text-xs text-zinc-600 mb-3">
        One mapping per container volume class. Saving a class updates all matching packaging items (e.g. saving "1/6 BBL Keg" updates both generic and partner-specific 1/6 keg items). Cans require separate Case and Loose mappings.
      </p>
      <div className="flex flex-col gap-5">
        {volumeClasses.map((vc) => (
          <VolumeClassRow
            key={`${vc.piType}|${vc.volumeFlOz}|${vc.format}`}
            vc={vc}
            packagingItems={packagingItems}
            feeRows={feeRows}
            partners={partners}
            items={items}
            onSave={save}
          />
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add RecipeLinkMatrix section to ExportSettingsPanel's `scope === "full"` block**

In the `ExportSettingsPanel` default export (currently at the bottom of the file), inside the `scope === "full"` block, add a new section after `<InvoiceTermsSection />`:

```tsx
{scope === "full" && (
  <>
    {/* ... existing sections ... */}
    <InvoiceTermsSection />
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Product Square Links</h3>
      <p className="text-xs text-zinc-600 mb-3">
        Map each recipe + container format to a Square catalog variation for invoice line items.
      </p>
      <RecipeLinkMatrix />
    </section>
  </>
)}
```

- [ ] **Step 4: Verify TypeScript + build**

```bash
npm run build 2>&1 | grep -E "error TS|Type error" | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx
git commit -m "feat: rewrite PackagingFeeSection as volume-class grouped UI + add RecipeLinkMatrix section"
```

---

## Task 7: Remove SquareLinkManager wiring from ExportTab

**Files:**
- Modify: `app/production/components/ExportTab.tsx`

The `SquareLinkManager` is currently rendered inside `ExportsChannelTab` for the "taproom" channel behind a `showLinks` state toggle. Remove the import, the `links` query, the `showLinks` state, and the modal rendering. Keep the rest of `ExportsChannelTab` intact.

- [ ] **Step 1: Remove SquareLinkManager from ExportTab.tsx**

In `app/production/components/ExportTab.tsx`:

1. Remove line 7: `import { SquareLinkManager, LinkRow } from "./SquareLinkManager";`
2. Remove the `links` query (lines 193–196 in the root `ExportTab` component)
3. Remove `links` from the `ExportsChannelTab` prop interface and the `<ExportsChannelTab ... links={links} ...>` call
4. Remove the `showLinks` state from `ExportsChannelTab`
5. Remove the "Link to Square" button block (currently lines 87–101 of `ExportsChannelTab`)
6. Remove the `SquareLinkManager` modal render block (currently lines 173–180)
7. Remove the `onLinksChanged` prop (it's now a no-op)

After the edit, `ExportsChannelTab` should be a simpler component that just shows the transaction table and totals.

Full replacement for `ExportsChannelTab`:

```tsx
function ExportsChannelTab({ channel, exports }: {
  channel: ExportChannel;
  exports: ExportTransactionRow[];
}) {
  const qc = useQueryClient();
  const channelExports = exports.filter(e => e.channel === channel);
  const channelMeta = CHANNEL_TABS.find(c => c.key === channel)!;

  const totalBbl  = channelExports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);
  const totalGal  = totalBbl * BBL_TO_GAL;
  const totalTax  = channelExports.reduce((s, e) => s + (e.total_excise_tax_usd ?? 0), 0);

  async function remove(id: string) {
    if (!confirm("Delete this export record?")) return;
    await fetch(`/api/production/exports/${id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <>
      <p className="text-xs text-zinc-600 mb-4">{channelMeta.description}</p>
      {channelExports.length === 0 ? (
        <p className="text-sm text-zinc-600">No {channelMeta.label.toLowerCase()} exports recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Gallons</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">BBL</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Excise Tax</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {channelExports.map(e => (
                <tr key={e.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(e.created_at)}</td>
                  <td className="px-4 py-2.5 text-zinc-200">
                    {e.brew_batches ? `#${e.brew_batches.batch_number} ${e.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{e.variant_label}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">{e.quantity}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? (e.volume_bbl * BBL_TO_GAL).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? e.volume_bbl.toFixed(4) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">{fmtUsd(e.total_excise_tax_usd)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      e.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                      : e.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                      : "bg-zinc-800 text-zinc-400"
                    }`}>
                      {e.status === "invoice_required" ? "Invoice Required" : e.status === "unpaid" ? "Unpaid" : "Paid"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs">{e.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => remove(e.id)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {channelExports.length > 0 && totalBbl > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 px-3 py-2.5 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
          <span className="text-zinc-500">Total volume</span>
          <span className="text-zinc-300 font-medium tabular-nums">
            {totalGal.toFixed(2)} gal &nbsp;/&nbsp; {totalBbl.toFixed(4)} BBL
          </span>
          <span className="text-zinc-400 font-medium border-t border-zinc-800 pt-1 mt-0.5">Total excise tax</span>
          <span className="text-amber-300 font-semibold tabular-nums border-t border-zinc-800 pt-1 mt-0.5">{fmtUsd(totalTax)}</span>
        </div>
      )}
    </>
  );
}
```

Update the root `ExportTab` to no longer fetch `links` or `recipes`, and pass only `exports` to `ExportsChannelTab`:

```tsx
export default function ExportTab() {
  const { data: exports = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ExportTransactionRow[]>("/api/production/exports"),
  });
  const [tab, setTab] = useState<TopTab>("export_bay");

  return (
    <>
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Commitments and fulfillment — track what has been allocated and what has shipped.</p>
      </div>
      <div className="flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
        {TOP_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            {key === "taproom" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
          </button>
        ))}
      </div>
      {tab === "export_bay" && <ExportBayTab />}
      {tab === "export_transactions" && <ExportTransactionsTab />}
      {tab === "taproom" && (
        <ExportsChannelTab key={tab} channel="taproom" exports={exports} />
      )}
    </>
  );
}
```

Also remove the unused imports: `useRecipesQuery`, `fetchJson` (if no longer used), `SquareLinkManager`, `LinkRow`, `Recipe`, `queryKeys.production.recipeSquareLinks()` reference. Keep `useQuery`, `useQueryClient`, `queryKeys`, `fmtUsd`, `ExportBayTab`, `ExportTransactionsTab`.

- [ ] **Step 2: Final build check**

```bash
npm run build 2>&1 | grep -E "error TS|Type error" | head -20
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/production/components/ExportTab.tsx
git commit -m "refactor: remove SquareLinkManager modal from ExportTab (links now in ExportSettingsPanel)"
```

---

## Self-Review Checklist

### 1. Spec coverage

| Requirement | Task covering it |
|---|---|
| Volume-class grouped PackagingFeeSection | Task 6 |
| Bulk upsert all items in class on save | Task 4 |
| Partner override per volume class | Task 6 (`VolumeClassRow`) |
| Expand RPV join to packaging_items + partners | Task 1 |
| Partner grouping via `packaging_variations.partner_id` (NOT `recipes.brewery`) | Task 3 (`buildMatrix`) |
| RecipeLinkMatrix inline in ExportSettingsPanel | Tasks 5 + 6 |
| Auto-suggest by beer name | Task 3 (`autoSuggest`) |
| "Accept all suggestions" per group | Task 5 (`handleAcceptAll`) |
| Cell states: linked / suggested / empty / n/a | Task 5 (`MatrixCellView`) |
| POST to recipe-square-links uses actual packaging_item_id | Task 3 (`resolvePackagingItemId`), Task 5 (`handleLinkWithType`) |
| Kegs: packaging_format = null in recipe_square_links | Task 3 (cell resolution), Task 5 |
| Cans: packaging_format = pv.format | Task 3 (cell resolution), Task 5 |
| Remove SquareLinkManager wiring from ExportTab | Task 7 |
| scope="full" guard on new sections | Task 6 |
| Invalidate queryKeys after mutations | Tasks 4, 5, 6 |

### 2. Placeholder scan

No TBDs, TODOs, or "fill in later" found.

### 3. Type consistency

- `RecipePackagingVariationExpanded` defined in Task 1, consumed by Tasks 2 (query return type) and 3 (matrix builder)
- `RecipeSquareLinkRow` defined in Task 1's Step 1, consumed by Task 2's hook and Task 3's `buildMatrix`
- `MatrixColumn`, `MatrixCell`, `MatrixGroup` defined in Task 3, consumed by Task 5
- `VolumeClass` defined inline in Task 6 (local to ExportSettingsPanel — not exported)
- `PartnerOverridePicker` already exported from `ExportSettingsPanel.tsx` — used in Task 6's `VolumeClassRow`
- `ExportServiceMapping` already imported in `ExportSettingsPanel.tsx`

### 4. Key invariants verified

- `exportInvoicePreview.ts` looks up `recipe_square_links` by `${recipe_id}|${packaging_item_id}|${packaging_format}` (line 96–100). The matrix POSTs with the exact `container_id` from `recipe_packaging_variations.packaging_variations.container_id` — not a generic item ID. ✓
- `invoice_item_mappings` constraint: `packaging_fee` rows must have non-null `packaging_item_id`, `square_catalog_item_id`, `square_catalog_variation_id`. The bulk route (Task 4) validates this and only upserts when both Square IDs are provided. ✓
- Partner grouping uses `packaging_variations.partner_id → contract_brewing_partners.company_name` — never `recipes.brewery`. ✓

---

## Execution Notes

**Parallel execution opportunity:** Tasks 1+2 and Task 3 and Task 4 are independent and can run in parallel. Task 5 depends on 1+2+3. Task 6 depends on 4+5. Task 7 depends on 6.

**Suggested subagent grouping:**
- Wave 1 (parallel): Agent A = Tasks 1+2, Agent B = Tasks 3+4
- Wave 2 (after Wave 1): Agent C = Task 5
- Wave 3 (after Wave 2): Agent D = Tasks 6+7
