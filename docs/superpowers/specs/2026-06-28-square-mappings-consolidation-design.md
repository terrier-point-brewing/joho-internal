# Square Mappings Consolidation — Design Spec

**Date:** 2026-06-28  
**Status:** Approved for implementation

## Overview

Consolidate `SquareLinkManager` (modal) and `RecipeLinkMatrix` (flat list panel) into a single **Square Mappings** subtab under Production > Settings. The new surface is a grid with an inline drawer editor, fixing the broken auto-suggest and adding bulk-accept column actions.

---

## 1. Architecture & Navigation

### New page
`app/production/settings/square-links/page.tsx` — added to `SETTINGS_NAV` in `app/production/nav-config.ts` as "Square Mappings".

### Deleted components
- `app/production/components/SquareLinkManager.tsx`
- `app/production/components/RecipeLinkMatrix.tsx`
- `lib/production/recipeLinkMatrix.ts` (replaced by `lib/production/squareMappingGrid.ts`)

### Entry point changes
Modal trigger buttons in `DraftStatsTab` and `IntakeTab` (wherever `SquareLinkManager` is currently opened) become:
```tsx
<Link href="/production/settings/square-links">Manage Square mappings →</Link>
```

---

## 2. Data Model

### `recipe_square_links` grain (live schema as of 20260710)
- **Draft rows**: `variation_id = NULL`, `packaging = 'draft'`, unique per `recipe_id`. One draft Square link per recipe.
- **Keg/can rows**: `variation_id NOT NULL` → `packaging_variations.id`, unique per `variation_id`. One Square catalog variation per packaging variation.

### Column derivation
Columns are derived from one query:

```sql
SELECT DISTINCT
  pi.type,
  pi.volume_fl_oz,
  pv.format,
  pi.name AS container_name
FROM packaging_variations pv
JOIN packaging_items pi ON pi.id = pv.container_id
JOIN recipe_packaging_variations rpv ON rpv.variation_id = pv.id
WHERE pv.is_active = true
ORDER BY pi.type, pi.volume_fl_oz, pv.format
```

Grouping key: `(pi.type, pi.volume_fl_oz, pv.format)`. Draft is a hardcoded first column (not derived from packaging_variations — it's recipe-grain with `variation_id = NULL`).

Column labels:
- **Kegs**: `pi.name` (e.g. "½ Keg", "¼ Keg", "⅙ Keg") — raw fl oz is not user-readable
- **Cans**: `"{volume_fl_oz}oz {Format}"` (e.g. "16oz Loose", "12oz 4-Pack", "16oz Case")

Columns only render if at least one active recipe has a variation of that type. Typical live set:

> Draft · ½ Keg · ¼ Keg · ⅙ Keg · 12oz Loose · 16oz Loose · 12oz 4-Pack · 16oz 4-Pack · 12oz Case · 16oz Case

---

## 3. Grid Component

**File:** `app/production/settings/square-links/MappingGrid.tsx`

### Structure
- Sticky first column: recipe name
- Remaining columns: one per derived column (see §2), ordered by type then volume then format
- Column header: label + "Fill N" bulk button (N = count of high-confidence unaccepted suggestions in that column)
- Global "Fill all suggested" banner above grid when any column has unaccepted suggestions

### Cell
A cell represents the bucket of all `packaging_variations` for a given `(recipe_id, type, volume_fl_oz, format)` tuple. For Draft cells, the bucket is the single recipe-level draft link.

Each cell renders compact badges — one per packaging variation in the bucket. A badge shows the variation's short name and its link state.

### Cell states

| State | Badge style | Condition |
|---|---|---|
| **No variation** | Gray dash | Recipe has no packaging variation in this column bucket |
| **All linked** | Green | Every variation in cell has a Square link |
| **Partially linked** | Yellow | ≥1 linked and ≥1 unlinked |
| **High-confidence suggestion** | Blue outline + "✓" accept chip | Unlinked, auto-suggest confidence ≥ high; click chip to accept without opening drawer |
| **Unlinked, no good suggest** | Amber "?" | Unlinked, confidence < medium |

Clicking any non-dash cell opens the drawer (§4). The "✓" accept chip on a high-confidence badge can be clicked directly to accept that suggestion without opening the drawer.

### Bulk actions
- **Column "Fill N"**: batch-accepts all high-confidence suggestions in that column across all recipes
- **Global "Fill all suggested"**: fires all columns simultaneously; count shown in banner

Bulk accepts POST to `/api/production/recipe-square-links` for each accepted suggestion.

---

## 4. Drawer Component

**File:** `app/production/settings/square-links/MappingDrawer.tsx`

A 400px right-side panel that opens without closing the grid. The grid shifts left or the drawer overlays — whichever fits the viewport.

**Header:** `[Recipe Name] · [Column Label]`

**Body:** one row per packaging variation in the clicked cell (Draft cells have one row). Each row:
- Variation name (full, e.g. "Epic Hazy IPA 16oz Printed Can")
- **If linked:** Square variation badge + ✕ unlink button
- **If unlinked:**
  - Auto-suggest chip at top: "Suggested: [Square variation name]" + "Accept" button (shown only if confidence ≥ medium)
  - `VariationCombobox` (ported from `SquareLinkManager`) — searchable, pre-filtered to matching Square category — for manual pick or override

One Square link per packaging variation row (enforced by `rsl_variation_uniq`). Draft rows similarly one link per recipe (`rsl_draft_uniq`). No "add another" option within a row.

---

## 5. Auto-suggest Algorithm

**Location:** `lib/production/squareMappingGrid.ts` — `autoSuggest()` function, replacing the broken implementation in `recipeLinkMatrix.ts`.

```
autoSuggest(recipe, packagingVariation, squareCatalogItems):

1. Determine Square category:
     packaging = 'draft'          → "Draft"
     packaging_items.type = 'keg' → "Kegs"
     packaging_items.type = 'can' → "Cans"

2. Filter squareCatalogItems to that category.

3. Score each candidate Square variation:
     +4  packaging_variation.container.volume_fl_oz
         == square_catalog_variation.volume_fl_oz_per_unit   (exact volume match)
     +3  Square item name tokens overlap recipe.beer_name tokens
         (stop-word filter: "the", "a", "IPA", "ale", "lager", "stout", "porter")
     +1  Square variation name contains format label
         ("loose", "4-pack", "6-pack", "case")

4. Return highest scorer.
   Confidence: score ≥ 6 → high | 3–5 → medium | < 3 → skip (no suggestion shown)
```

The `CATEGORY_FOR` mapping (`draft → "Draft"`, `keg → "Kegs"`, `can → "Cans"`) from `SquareLinkManager.filterVariations()` is ported here and becomes the single canonical implementation. The old location is deleted.

Volume equality (`volume_fl_oz_per_unit` from migration `20260709_catalog_variation_units.sql`) is the primary signal, replacing the previous broken approach of always returning `variations[0]`.

---

## 6. API Changes

**`GET /api/production/recipe-square-links`** — extended to return the full grid data shape:

```ts
{
  columns: Array<{
    key: string;           // e.g. "keg_1984_loose", "can_16_4-pack", "draft"
    label: string;         // e.g. "½ Keg", "16oz 4-Pack", "Draft"
    type: 'keg' | 'can' | 'draft';
    volumeFlOz: number | null;  // null for draft
    format: string | null;      // null for draft
  }>;
  rows: Array<{
    recipeId: string;
    recipeName: string;
    cells: Record<string, {           // keyed by column.key
      variations: Array<{
        variationId: string;
        variationName: string;
        linkedSquareCatalogVariationId: string | null;
        linkedSquareName: string | null;
        suggestion: {
          squareCatalogVariationId: string;
          squareName: string;
          confidence: 'high' | 'medium';
        } | null;
      }>;
    } | null>;  // null = no variation of this type for this recipe
  }>;
}
```

Auto-suggest runs server-side at GET time (one pass over catalog items per recipe variation) so the client doesn't need to hold the full Square catalog.

**`POST /api/production/recipe-square-links`** — unchanged (handles add link)  
**`DELETE /api/production/recipe-square-links/[id]`** — unchanged (handles remove link)

---

## 7. New `lib/production/squareMappingGrid.ts`

Exports:
- `deriveColumns(packagingVariations, packagingItems): ColumnDef[]`
- `buildGrid(recipes, columns, packagingVariations, links, squareCatalogItems): GridRow[]`
- `autoSuggest(recipe, variation, containerItem, squareCatalogItems): Suggestion | null`

`recipeLinkMatrix.ts` is deleted. Any callers of `buildMatrix` or `buildVariationLinkMatrix` migrate to `buildGrid`.

---

## 8. Files Changed

| Action | Path |
|---|---|
| **New** | `app/production/settings/square-links/page.tsx` |
| **New** | `app/production/settings/square-links/MappingGrid.tsx` |
| **New** | `app/production/settings/square-links/MappingDrawer.tsx` |
| **New** | `lib/production/squareMappingGrid.ts` |
| **Modify** | `app/production/nav-config.ts` — add "Square Mappings" to `SETTINGS_NAV` |
| **Modify** | `app/api/production/recipe-square-links/route.ts` — extend GET |
| **Modify** | `app/production/components/ExportSettingsPanel.tsx` — remove `RecipeLinkMatrix` embed |
| **Modify** | `app/taproom/components/DraftStatsTab.tsx` — modal → link |
| **Modify** | `app/production/components/intake/TaproomTab.tsx` — modal → link |
| **Modify** | `app/production/types.ts` — update/remove RecipeLinkMatrix type |
| **Modify** | `app/production/hooks/queries.ts` — update/extend recipe-square-links query hook |
| **Delete** | `app/production/components/SquareLinkManager.tsx` |
| **Delete** | `app/production/components/RecipeLinkMatrix.tsx` |
| **Delete** | `lib/production/recipeLinkMatrix.ts` |

---

## 9. Out of Scope

- Editing `packaging_variations` themselves (name, components) — that's a separate settings surface
- Square catalog sync — already handled by existing catalog sync route
- Taproom sell-through — reads `recipe_square_links` via `lib/square/skuMappings.ts`; no changes needed there
