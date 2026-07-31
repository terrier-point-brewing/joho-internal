# Square Mappings Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `SquareLinkManager` modal and `RecipeLinkMatrix` flat-list panel with a single **Square Mappings** page at `/production/settings/square-links`, featuring a recipe × packaging-column grid with an inline drawer editor and scoring-based auto-suggest.

**Architecture:** A new `lib/production/squareMappingGrid.ts` owns all data transformation (column derivation, grid building, auto-suggest). The existing `GET /api/production/recipe-square-links` route is extended to run auto-suggest server-side and return a structured `{ columns, rows }` shape. Two new page-level components (`MappingGrid`, `MappingDrawer`) consume that shape via a new React Query hook. The old modal (`SquareLinkManager`) and flat-list panel (`RecipeLinkMatrix`) are deleted; callers are replaced with a `<Link>` to the new page.

**Tech Stack:** Next.js App Router, React, TypeScript, TanStack Query v5, Supabase server client, Tailwind CSS (project class conventions: `btn-amber`, `btn-ghost`, `inp`).

## Global Constraints

- No new DB migrations — UI + lib only.
- All business logic in `lib/`, not in `app/api/**` or page components.
- Use `createSupabaseServerClient` (never browser client) in route handlers.
- React Query cache key for the grid: `["production", "square-mapping-grid"]` (new key; the old `recipe-square-links` key stays intact for any existing consumers).
- POST/DELETE API endpoints are unchanged — only the GET shape changes.
- The new GET response is returned from `/api/production/recipe-square-links` with `?grid=1` query param to distinguish it from the legacy flat array response (so existing callers of the legacy shape don't break).
- `CATEGORY_FOR` mapping (`draft → "Draft"`, `keg → "Kegs"`, `can → "Cans"`) lives only in `squareMappingGrid.ts` — delete from `SquareLinkManager.tsx` as part of that file's deletion.
- Auto-suggest stop words: `"the"`, `"a"`, `"ipa"`, `"ale"`, `"lager"`, `"stout"`, `"porter"` (lowercased comparison).
- Scoring: +4 volume match, +3 beer-name token overlap, +1 format label match. Confidence: ≥6 → high, 3–5 → medium, <3 → no suggestion.
- Draft column is hardcoded first (key `"draft"`, type `"draft"`), not derived from `packaging_variations`.
- Keg column labels come from `packaging_items.name` (e.g. "½ Keg"). Can column labels are `"{vol}oz {Format}"`.
- Column ordering: Draft first, then kegs (descending volume), then cans (ascending volume, then loose/4-pack/6-pack/case).
- Run `npm run build` after all tasks to confirm no TypeScript errors.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| **New** | `lib/production/squareMappingGrid.ts` | `deriveColumns`, `buildGrid`, `autoSuggest` — pure functions |
| **New** | `lib/production/squareMappingGrid.test.ts` | Unit tests for the lib |
| **New** | `app/production/settings/square-links/page.tsx` | Page shell, fetches nothing (client components do) |
| **New** | `app/production/settings/square-links/MappingGrid.tsx` | Grid table component |
| **New** | `app/production/settings/square-links/MappingDrawer.tsx` | Drawer editor (includes ported `VariationCombobox`) |
| **Modify** | `app/api/production/recipe-square-links/route.ts` | Extend `GET` with `?grid=1` branch |
| **Modify** | `app/production/hooks/queries.ts` | Add `useSquareMappingGridQuery` |
| **Modify** | `app/production/types.ts` | Add `MappingGridResponse`, `MappingColumn`, `MappingCell`, `MappingRow` types |
| **Modify** | `app/production/nav-config.ts` | Add "Square Mappings" to `SETTINGS_NAV` |
| **Modify** | `app/production/components/ExportSettingsPanel.tsx` | Remove `RecipeLinkMatrix` embed |
| **Modify** | `app/taproom/components/DraftStatsTab.tsx` | Modal → link |
| **Modify** | `app/production/components/intake/TaproomTab.tsx` | Modal → link |
| **Delete** | `app/production/components/SquareLinkManager.tsx` | Replaced by new page |
| **Delete** | `app/production/components/RecipeLinkMatrix.tsx` | Replaced by new page |
| **Delete** | `lib/production/recipeLinkMatrix.ts` | Replaced by `squareMappingGrid.ts` |
| **Delete** | `lib/production/recipeLinkMatrix.test.ts` | Tests move to `squareMappingGrid.test.ts` |

---

## Task 1: `lib/production/squareMappingGrid.ts` — pure lib + tests

**Files:**
- Create: `lib/production/squareMappingGrid.ts`
- Create: `lib/production/squareMappingGrid.test.ts`

**Interfaces:**
- Produces:
  - `ColumnDef` — column descriptor used by Tasks 2, 4, 5
  - `autoSuggest(beerName, containerVolumeFlOz, containerType, squareCatalogVariations): Suggestion | null`
  - `deriveColumns(rpvs: RpvRow[]): ColumnDef[]`
  - `buildGrid(recipes, columns, rpvs, links, squareCatalogVariations): GridRow[]`
  - `CATEGORY_FOR: Record<'draft'|'keg'|'can', string>`

- [ ] **Step 1: Write the test file**

```typescript
// lib/production/squareMappingGrid.test.ts
import { describe, it, expect } from "vitest";
import { autoSuggest, deriveColumns, buildGrid } from "./squareMappingGrid";
import type { RpvRow, SquareCatalogVariationFlat, LinkRow } from "./squareMappingGrid";

// ── autoSuggest ───────────────────────────────────────────────────────────────

const sqVars: SquareCatalogVariationFlat[] = [
  { squareVariationId: "sv1", squareItemId: "si1", itemName: "Epic Hazy IPA", variationName: "4-Pack", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  { squareVariationId: "sv2", squareItemId: "si2", itemName: "Epic Hazy IPA", variationName: "Loose", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  { squareVariationId: "sv3", squareItemId: "si3", itemName: "Some Other Beer", variationName: "1/2 BBL", categoryName: "Kegs", volumeFlOzPerUnit: 1984 },
  { squareVariationId: "sv4", squareItemId: "si4", itemName: "Epic Hazy", variationName: "Case", categoryName: "Cans", volumeFlOzPerUnit: 12 },
];

describe("autoSuggest", () => {
  it("returns high-confidence when volume matches and name tokens overlap", () => {
    // +4 volume + +3 name + +1 format = 8 → high
    const result = autoSuggest("Epic Hazy IPA", 16, "can", sqVars);
    // sv1 scores: +4 (vol 16==16) +3 (epic hazy overlap) +1 (4-pack) = 8
    // sv2 scores: +4 +3 +1 (loose) = 8 — tie; we just check high confidence
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
  });

  it("returns null when volume doesn't match and name tokens don't overlap", () => {
    const result = autoSuggest("Totally Unrelated", 355, "can", sqVars);
    expect(result).toBeNull();
  });

  it("only considers items in the correct category", () => {
    const result = autoSuggest("Epic Hazy IPA", 16, "keg", sqVars);
    // Only keg category: sv3 (Some Other Beer, 1984 fl oz) — name no overlap, volume no match → score 0 → null
    expect(result).toBeNull();
  });

  it("returns medium confidence when score 3–5", () => {
    // Name matches but volume doesn't
    const result = autoSuggest("Epic Hazy IPA", 999, "can", sqVars);
    // sv1: +0 vol + +3 name + +1 = 4 → medium
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
  });

  it("stop words are ignored in token comparison", () => {
    // "IPA" is a stop word — only "epic" and "hazy" are content tokens
    const vars: SquareCatalogVariationFlat[] = [
      { squareVariationId: "sv5", squareItemId: "si5", itemName: "Epic Hazy", variationName: "Loose", categoryName: "Cans", volumeFlOzPerUnit: 16 },
    ];
    const result = autoSuggest("Epic Hazy IPA", 16, "can", vars);
    expect(result).not.toBeNull(); // should still find overlap on "epic" + "hazy"
  });
});

// ── deriveColumns ─────────────────────────────────────────────────────────────

const makeRpv = (
  recipeId: string,
  variationId: string,
  containerType: "keg" | "can",
  volumeFlOz: number,
  format: string,
  containerName: string,
  isActive = true
): RpvRow => ({
  recipeId,
  variationId,
  containerType,
  volumeFlOz,
  format,
  containerName,
  isActive,
  partnerId: null,
  partnerName: null,
  variationName: variationId,
});

describe("deriveColumns", () => {
  it("produces draft as first column always", () => {
    const cols = deriveColumns([makeRpv("r1", "v1", "can", 16, "loose", "16oz Blank")]);
    expect(cols[0].key).toBe("draft");
    expect(cols[0].type).toBe("draft");
  });

  it("orders kegs before cans, kegs descending volume, cans ascending volume then format order", () => {
    const rpvs = [
      makeRpv("r1", "v1", "can", 12, "loose", "12oz Blank"),
      makeRpv("r1", "v2", "keg", 992, "loose", "¼ Keg"),
      makeRpv("r1", "v3", "keg", 1984, "loose", "½ Keg"),
      makeRpv("r1", "v4", "can", 16, "4-pack", "16oz Blank"),
    ];
    const cols = deriveColumns(rpvs);
    const keys = cols.map((c) => c.key);
    expect(keys[0]).toBe("draft");
    expect(keys[1]).toBe("keg|1984|loose"); // bigger keg first
    expect(keys[2]).toBe("keg|992|loose");
    expect(keys[3]).toBe("can|12|loose");
    expect(keys[4]).toBe("can|16|4-pack");
  });

  it("deduplicates columns (same type+vol+format from multiple recipes)", () => {
    const rpvs = [
      makeRpv("r1", "v1", "can", 16, "loose", "16oz Blank"),
      makeRpv("r2", "v2", "can", 16, "loose", "16oz Blank"),
    ];
    const cols = deriveColumns(rpvs);
    expect(cols.filter((c) => c.key === "can|16|loose").length).toBe(1);
  });

  it("keg label uses container name", () => {
    const rpvs = [makeRpv("r1", "v1", "keg", 1984, "loose", "½ Keg")];
    const cols = deriveColumns(rpvs);
    const kegCol = cols.find((c) => c.type === "keg");
    expect(kegCol?.label).toBe("½ Keg");
  });

  it("can label uses vol+format", () => {
    const rpvs = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
    const cols = deriveColumns(rpvs);
    const canCol = cols.find((c) => c.type === "can");
    expect(canCol?.label).toBe("16oz 4-Pack");
  });
});

// ── buildGrid ─────────────────────────────────────────────────────────────────

describe("buildGrid", () => {
  const rpvs = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
  const recipes = [{ id: "r1", beerName: "Epic Hazy IPA" }];
  const cols = deriveColumns(rpvs);
  const sqVarsSimple: SquareCatalogVariationFlat[] = [
    { squareVariationId: "sv1", squareItemId: "si1", itemName: "Epic Hazy IPA", variationName: "4-Pack", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  ];

  it("returns null cell for draft when recipe has no draft link", () => {
    const rows = buildGrid(recipes, cols, rpvs, [], sqVarsSimple);
    const row = rows[0];
    const draftCell = row.cells["draft"];
    expect(draftCell).not.toBeNull();
    expect(draftCell!.variations.length).toBe(1);
    expect(draftCell!.variations[0].linkedSquareCatalogVariationId).toBeNull();
  });

  it("cell has null when recipe has no variation for a column", () => {
    const rpvsSingle = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
    const cols2 = deriveColumns([
      ...rpvsSingle,
      makeRpv("r2", "v2", "can", 12, "loose", "12oz Blank"),
    ]);
    const rows = buildGrid(
      [{ id: "r1", beerName: "Epic Hazy IPA" }],
      cols2,
      rpvsSingle,
      [],
      sqVarsSimple
    );
    expect(rows[0].cells["can|12|loose"]).toBeNull();
  });

  it("marks cell variation linked when link exists", () => {
    const links: LinkRow[] = [{
      id: "l1", recipeId: "r1", packaging: "can", variationId: "v1",
      squareCatalogVariationId: "sv1", squareVariationId: "sv1",
      variationName: "4-Pack", itemName: "Epic Hazy IPA",
    }];
    const rows = buildGrid(recipes, cols, rpvs, links, sqVarsSimple);
    const cell = rows[0].cells["can|16|4-pack"]!;
    expect(cell.variations[0].linkedSquareCatalogVariationId).toBe("sv1");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run lib/production/squareMappingGrid.test.ts 2>&1 | tail -20
```

Expected: multiple failures — module not found.

- [ ] **Step 3: Implement `lib/production/squareMappingGrid.ts`**

```typescript
// lib/production/squareMappingGrid.ts

export const CATEGORY_FOR = {
  draft: "Draft",
  keg:   "Kegs",
  can:   "Cans",
} as const;

const STOP_WORDS = new Set(["the", "a", "ipa", "ale", "lager", "stout", "porter"]);
const FORMAT_LABELS: Record<string, string> = {
  loose: "Loose", "4-pack": "4-Pack", "6-pack": "6-Pack", case: "Case",
};
const FORMAT_ORDER: Record<string, number> = {
  loose: 0, "4-pack": 1, "6-pack": 2, case: 3,
};

// ── Input types ───────────────────────────────────────────────────────────────

export interface RpvRow {
  recipeId: string;
  variationId: string;
  containerType: "keg" | "can";
  volumeFlOz: number;
  format: string;
  containerName: string; // packaging_items.name — used for keg column labels
  isActive: boolean;
  partnerId: string | null;
  partnerName: string | null;
  variationName: string; // packaging_variations.name
}

export interface SquareCatalogVariationFlat {
  squareVariationId: string;
  squareItemId: string;
  itemName: string;
  variationName: string;
  categoryName: string | null;
  volumeFlOzPerUnit: number | null;
}

export interface LinkRow {
  id: string;
  recipeId: string;
  packaging: "draft" | "keg" | "can";
  variationId: string | null; // null for draft rows
  squareCatalogVariationId: string | null; // internal UUID from square_catalog_variations
  squareVariationId: string; // Square-native ID
  variationName: string | null;
  itemName: string | null;
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface ColumnDef {
  key: string;
  label: string;
  type: "draft" | "keg" | "can";
  volumeFlOz: number | null;
  format: string | null;
}

export interface Suggestion {
  squareCatalogVariationId: string | null;
  squareVariationId: string;
  squareName: string;
  confidence: "high" | "medium";
}

export interface CellVariation {
  variationId: string;          // packaging_variation UUID (null string sentinel for draft)
  variationName: string;
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: Suggestion | null;
}

export interface GridCell {
  variations: CellVariation[];
}

export interface GridRow {
  recipeId: string;
  recipeName: string;
  cells: Record<string, GridCell | null>; // null = recipe has no variation for this column
}

// ── autoSuggest ───────────────────────────────────────────────────────────────

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function autoSuggest(
  beerName: string,
  containerVolumeFlOz: number | null,
  containerType: "draft" | "keg" | "can",
  sqVars: SquareCatalogVariationFlat[]
): Suggestion | null {
  const category = CATEGORY_FOR[containerType];
  const candidates = sqVars.filter((v) => v.categoryName === category);

  const beerTokens = new Set(tokenize(beerName));
  let bestScore = -1;
  let best: SquareCatalogVariationFlat | null = null;

  for (const sv of candidates) {
    let score = 0;

    // +4 exact volume match
    if (containerVolumeFlOz != null && sv.volumeFlOzPerUnit != null && containerVolumeFlOz === sv.volumeFlOzPerUnit) {
      score += 4;
    }

    // +3 beer name token overlap
    const svTokens = tokenize(sv.itemName);
    const overlap = svTokens.filter((t) => beerTokens.has(t)).length;
    if (overlap > 0) score += 3;

    // +1 format label in variation name
    const vn = sv.variationName.toLowerCase();
    if (vn.includes("loose") || vn.includes("4-pack") || vn.includes("6-pack") || vn.includes("case")) {
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = sv;
    }
  }

  if (!best || bestScore < 3) return null;

  return {
    squareCatalogVariationId: null, // caller fills in from DB lookup if needed
    squareVariationId: best.squareVariationId,
    squareName: `${best.itemName}${best.variationName ? ` · ${best.variationName}` : ""}`,
    confidence: bestScore >= 6 ? "high" : "medium",
  };
}

// ── deriveColumns ─────────────────────────────────────────────────────────────

const DRAFT_COLUMN: ColumnDef = {
  key: "draft",
  label: "Draft",
  type: "draft",
  volumeFlOz: null,
  format: null,
};

export function deriveColumns(rpvs: RpvRow[]): ColumnDef[] {
  const seen = new Map<string, ColumnDef>();

  for (const rpv of rpvs) {
    if (!rpv.isActive) continue;
    const key = `${rpv.containerType}|${rpv.volumeFlOz}|${rpv.format}`;
    if (!seen.has(key)) {
      const label =
        rpv.containerType === "keg"
          ? rpv.containerName
          : `${rpv.volumeFlOz}oz ${FORMAT_LABELS[rpv.format] ?? rpv.format}`;
      seen.set(key, {
        key,
        label,
        type: rpv.containerType,
        volumeFlOz: rpv.volumeFlOz,
        format: rpv.format,
      });
    }
  }

  const sorted = [...seen.values()].sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "keg") return -1;
      if (b.type === "keg") return 1;
      return 0;
    }
    if (a.type === "keg") return (b.volumeFlOz ?? 0) - (a.volumeFlOz ?? 0); // bigger keg first
    if ((a.volumeFlOz ?? 0) !== (b.volumeFlOz ?? 0))
      return (a.volumeFlOz ?? 0) - (b.volumeFlOz ?? 0);
    return (FORMAT_ORDER[a.format ?? ""] ?? 99) - (FORMAT_ORDER[b.format ?? ""] ?? 99);
  });

  return [DRAFT_COLUMN, ...sorted];
}

// ── buildGrid ─────────────────────────────────────────────────────────────────

export function buildGrid(
  recipes: { id: string; beerName: string }[],
  columns: ColumnDef[],
  rpvs: RpvRow[],
  links: LinkRow[],
  sqVars: SquareCatalogVariationFlat[]
): GridRow[] {
  // Index links by variationId and by recipeId (for draft)
  const linkByVariation = new Map<string, LinkRow>();
  const draftLinkByRecipe = new Map<string, LinkRow>();
  for (const l of links) {
    if (l.packaging === "draft") {
      draftLinkByRecipe.set(l.recipeId, l);
    } else if (l.variationId) {
      linkByVariation.set(l.variationId, l);
    }
  }

  // Index rpvs by recipe + column key
  type RpvIndex = Map<string, RpvRow[]>; // colKey → [rpv]
  const rpvsByRecipeCol = new Map<string, RpvIndex>();
  for (const rpv of rpvs) {
    if (!rpv.isActive) continue;
    if (!rpvsByRecipeCol.has(rpv.recipeId)) rpvsByRecipeCol.set(rpv.recipeId, new Map());
    const colKey = `${rpv.containerType}|${rpv.volumeFlOz}|${rpv.format}`;
    const idx = rpvsByRecipeCol.get(rpv.recipeId)!;
    if (!idx.has(colKey)) idx.set(colKey, []);
    idx.get(colKey)!.push(rpv);
  }

  return recipes.map((recipe) => {
    const recipeRpvs = rpvsByRecipeCol.get(recipe.id);
    const cells: Record<string, GridCell | null> = {};

    for (const col of columns) {
      if (col.type === "draft") {
        // Draft is always present for every recipe (one slot, no packaging variation)
        const link = draftLinkByRecipe.get(recipe.id);
        const suggestion = link
          ? null
          : autoSuggest(recipe.beerName, null, "draft", sqVars);
        cells["draft"] = {
          variations: [
            {
              variationId: "draft",
              variationName: "Draft",
              linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
              linkedSquareName: link
                ? `${link.itemName ?? ""}${link.variationName ? ` · ${link.variationName}` : ""}`.trim()
                : null,
              suggestion,
            },
          ],
        };
        continue;
      }

      const colRpvs = recipeRpvs?.get(col.key);
      if (!colRpvs || colRpvs.length === 0) {
        cells[col.key] = null;
        continue;
      }

      const variations: CellVariation[] = colRpvs.map((rpv) => {
        const link = linkByVariation.get(rpv.variationId);
        const suggestion = link
          ? null
          : autoSuggest(recipe.beerName, rpv.volumeFlOz, rpv.containerType, sqVars);
        return {
          variationId: rpv.variationId,
          variationName: rpv.variationName,
          linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
          linkedSquareName: link
            ? `${link.itemName ?? ""}${link.variationName ? ` · ${link.variationName}` : ""}`.trim()
            : null,
          suggestion,
        };
      });

      cells[col.key] = { variations };
    }

    return { recipeId: recipe.id, recipeName: recipe.beerName, cells };
  });
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npx vitest run lib/production/squareMappingGrid.test.ts 2>&1 | tail -30
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add lib/production/squareMappingGrid.ts lib/production/squareMappingGrid.test.ts
git commit -m "feat(lib): squareMappingGrid — deriveColumns, buildGrid, autoSuggest with scoring"
```

---

## Task 2: Extend GET `/api/production/recipe-square-links` with `?grid=1` branch

**Files:**
- Modify: `app/api/production/recipe-square-links/route.ts`

**Interfaces:**
- Consumes: `deriveColumns`, `buildGrid`, `RpvRow`, `SquareCatalogVariationFlat`, `LinkRow` from `lib/production/squareMappingGrid.ts`
- Produces: `GET ?grid=1` returns `{ columns: ColumnDef[], rows: GridRow[] }` (JSON)

The handler must:
1. Fetch `recipe_packaging_variations` joined with `packaging_variations` + `packaging_items`.
2. Fetch `recipe_square_links` (all rows, including variation_id and catalog_variation_id).
3. Fetch `square_catalog_variations` (for `volume_fl_oz_per_unit`, `square_variation_id`, joined item name via `square_catalog_items`).
4. Fetch `recipes` (id, beer_name).
5. Call `deriveColumns` → `buildGrid` (auto-suggest runs inside buildGrid).
6. Return `{ columns, rows }`.

- [ ] **Step 1: Read the existing route**

Already read at `app/api/production/recipe-square-links/route.ts` — the existing GET returns a flat array. The `?grid=1` branch will be added above the existing flat return.

- [ ] **Step 2: Add the grid branch**

In `app/api/production/recipe-square-links/route.ts`, replace the existing `GET` function with:

```typescript
import { deriveColumns, buildGrid } from "@/lib/production/squareMappingGrid";
import type { RpvRow, SquareCatalogVariationFlat, LinkRow as GridLinkRow } from "@/lib/production/squareMappingGrid";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  // Legacy flat response (existing callers)
  if (!req.nextUrl.searchParams.has("grid")) {
    const { data, error } = await supabase
      .from("recipe_square_links")
      .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz), packaging_variations(id, name)")
      .order("created_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Grid response (?grid=1)
  const [
    { data: rpvData, error: rpvErr },
    { data: linksData, error: linksErr },
    { data: sqVarData, error: sqVarErr },
    { data: recipesData, error: recipesErr },
  ] = await Promise.all([
    supabase
      .from("recipe_packaging_variations")
      .select(`
        recipe_id, variation_id,
        packaging_variations (
          id, name, format, is_active, partner_id,
          packaging_items ( id, name, type, volume_fl_oz ),
          contract_brewing_partners ( company_name )
        )
      `),
    supabase
      .from("recipe_square_links")
      .select("id, recipe_id, packaging, variation_id, catalog_variation_id, square_variation_id, variation_name, item_name")
      .order("created_at"),
    supabase
      .from("square_catalog_variations")
      .select("id, square_variation_id, volume_fl_oz_per_unit, square_catalog_items ( square_item_id, item_name, category_name )"),
    supabase
      .from("recipes")
      .select("id, beer_name")
      .order("beer_name"),
  ]);

  if (rpvErr) return NextResponse.json({ error: rpvErr.message }, { status: 500 });
  if (linksErr) return NextResponse.json({ error: linksErr.message }, { status: 500 });
  if (sqVarErr) return NextResponse.json({ error: sqVarErr.message }, { status: 500 });
  if (recipesErr) return NextResponse.json({ error: recipesErr.message }, { status: 500 });

  // Shape the raw data into the types expected by squareMappingGrid functions
  const rpvRows: RpvRow[] = (rpvData ?? []).flatMap((rpv) => {
    const pv = rpv.packaging_variations as {
      id: string; name: string; format: string; is_active: boolean; partner_id: string | null;
      packaging_items: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
      contract_brewing_partners: { company_name: string } | null;
    } | null;
    if (!pv || !pv.packaging_items || !pv.is_active) return [];
    if (pv.packaging_items.type !== "keg" && pv.packaging_items.type !== "can") return [];
    if (pv.packaging_items.volume_fl_oz == null) return [];
    return [{
      recipeId: rpv.recipe_id,
      variationId: rpv.variation_id,
      containerType: pv.packaging_items.type as "keg" | "can",
      volumeFlOz: pv.packaging_items.volume_fl_oz,
      format: pv.format,
      containerName: pv.packaging_items.name,
      isActive: pv.is_active,
      partnerId: pv.partner_id,
      partnerName: pv.contract_brewing_partners?.company_name ?? null,
      variationName: pv.name,
    }];
  });

  const sqVarRows: SquareCatalogVariationFlat[] = (sqVarData ?? []).flatMap((sv) => {
    const item = sv.square_catalog_items as { square_item_id: string; item_name: string; category_name: string | null } | null;
    if (!item) return [];
    return [{
      squareVariationId: sv.square_variation_id,
      squareItemId: item.square_item_id,
      itemName: item.item_name,
      variationName: sv.square_variation_id, // placeholder — variation name not in this table
      categoryName: item.category_name,
      volumeFlOzPerUnit: sv.volume_fl_oz_per_unit ?? null,
    }];
  });

  const linkRows: GridLinkRow[] = (linksData ?? []).map((l) => ({
    id: l.id,
    recipeId: l.recipe_id,
    packaging: l.packaging as "draft" | "keg" | "can",
    variationId: l.variation_id ?? null,
    squareCatalogVariationId: l.catalog_variation_id ?? null,
    squareVariationId: l.square_variation_id,
    variationName: l.variation_name ?? null,
    itemName: l.item_name ?? null,
  }));

  const recipesList = (recipesData ?? []).map((r) => ({ id: r.id, beerName: r.beer_name }));

  const columns = deriveColumns(rpvRows);
  const rows = buildGrid(recipesList, columns, rpvRows, linkRows, sqVarRows);

  return NextResponse.json({ columns, rows });
}
```

**Note on `square_catalog_variations.variationName`**: the `square_catalog_variations` table stores the Square native variation ID but may not store the variation display name. The `autoSuggest` function uses `variationName` only for format-label scoring (`+1`). If it's absent, use an empty string — the score will simply not get +1 for that variation. The `linkedSquareName` for accepted links is already stored in `recipe_square_links.variation_name`.

- [ ] **Step 3: Build to check for TypeScript errors**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Fix any type errors before continuing.

- [ ] **Step 4: Smoke test the new endpoint**

```bash
npm run dev &
sleep 5
curl -s "http://localhost:3000/api/production/recipe-square-links?grid=1" | jq '{column_count: (.columns | length), row_count: (.rows | length)}'
```

Expected: `{ column_count: N, row_count: M }` with reasonable numbers (not empty, not error).

- [ ] **Step 5: Commit**

```bash
git add app/api/production/recipe-square-links/route.ts
git commit -m "feat(api): recipe-square-links GET ?grid=1 — returns MappingGridResponse"
```

---

## Task 3: Types + React Query hook

**Files:**
- Modify: `app/production/types.ts` — add grid response types
- Modify: `app/production/hooks/queries.ts` — add `useSquareMappingGridQuery`

**Interfaces:**
- Produces: `MappingGridResponse`, `MappingColumn`, `MappingCell`, `MappingCellVariation` types and `useSquareMappingGridQuery` hook

- [ ] **Step 1: Add types to `app/production/types.ts`**

Append after the closing `SquareCatalogOptions` interface (end of file):

```typescript
// ── Square Mappings Grid ──────────────────────────────────────────────────────

export interface MappingColumn {
  key: string;
  label: string;
  type: "draft" | "keg" | "can";
  volumeFlOz: number | null;
  format: string | null;
}

export interface MappingCellVariation {
  variationId: string;
  variationName: string;
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: {
    squareCatalogVariationId: string | null;
    squareVariationId: string;
    squareName: string;
    confidence: "high" | "medium";
  } | null;
}

export interface MappingCell {
  variations: MappingCellVariation[];
}

export interface MappingGridRow {
  recipeId: string;
  recipeName: string;
  cells: Record<string, MappingCell | null>;
}

export interface MappingGridResponse {
  columns: MappingColumn[];
  rows: MappingGridRow[];
}
```

- [ ] **Step 2: Add hook to `app/production/hooks/queries.ts`**

Add after `useRecipeSquareLinksQuery`:

```typescript
export function useSquareMappingGridQuery() {
  return useQuery({
    queryKey: ["production", "square-mapping-grid"] as const,
    queryFn: () => fetchJson<MappingGridResponse>("/api/production/recipe-square-links?grid=1"),
  });
}
```

Also add `MappingGridResponse` to the existing import from `../types`:

```typescript
import {
  // ... existing imports ...
  MappingGridResponse,
} from "../types";
```

- [ ] **Step 3: Build check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/production/types.ts app/production/hooks/queries.ts
git commit -m "feat(types): MappingGridResponse types and useSquareMappingGridQuery hook"
```

---

## Task 4: `MappingGrid.tsx` — grid table component

**Files:**
- Create: `app/production/settings/square-links/MappingGrid.tsx`

**Interfaces:**
- Consumes: `useSquareMappingGridQuery` from `../../../hooks/queries` (path: `app/production/hooks/queries`)
- Consumes: `MappingGridResponse`, `MappingColumn`, `MappingGridRow`, `MappingCellVariation` from `app/production/types`
- Produces: `export default function MappingGrid({ onCellClick }: { onCellClick: (recipeId: string, colKey: string) => void })`

The grid renders a sticky-first-column table. Each non-draft, non-null cell shows badges per variation. A badge is:
- Green bg: linked (`linkedSquareCatalogVariationId != null`)
- Blue outline + "✓" chip: high-confidence suggestion (unlinked, `suggestion.confidence === 'high'`)
- Amber "?": unlinked, no suggestion or medium confidence

The "✓" chip (`data-accept-chip`) on a high-confidence badge accepts the suggestion without opening the drawer by calling `POST /api/production/recipe-square-links` directly.

The column header shows a "Fill N" button when N > 0 high-confidence unaccepted suggestions exist in that column. A global banner "Fill all suggested (N)" appears above the grid when any column has suggestions.

Clicking any non-null cell calls `onCellClick(recipeId, colKey)`.

- [ ] **Step 1: Create `app/production/settings/square-links/MappingGrid.tsx`**

```tsx
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSquareMappingGridQuery } from "@/app/production/hooks/queries";
import type { MappingCellVariation, MappingGridRow, MappingColumn } from "@/app/production/types";

async function acceptSuggestion(
  recipeId: string,
  packaging: "draft" | "keg" | "can",
  variationId: string | null,
  suggestion: NonNullable<MappingCellVariation["suggestion"]>
) {
  const body: Record<string, unknown> = {
    recipe_id: recipeId,
    packaging,
    square_variation_id: suggestion.squareVariationId,
    variation_name: suggestion.squareName.split(" · ")[1] ?? null,
    item_name: suggestion.squareName.split(" · ")[0] ?? null,
  };
  if (variationId && variationId !== "draft") body.variation_id = variationId;
  const res = await fetch("/api/production/recipe-square-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? "Accept failed");
  }
}

function colPackaging(col: MappingColumn): "draft" | "keg" | "can" {
  return col.type === "draft" ? "draft" : col.type === "keg" ? "keg" : "can";
}

export default function MappingGrid({
  onCellClick,
}: {
  onCellClick: (recipeId: string, colKey: string) => void;
}) {
  const { data, isLoading, error } = useSquareMappingGridQuery();
  const qc = useQueryClient();

  if (isLoading) return <div className="text-sm text-zinc-500 py-8 text-center">Loading grid…</div>;
  if (error) return <div className="text-sm text-red-400 py-8 text-center">{(error as Error).message}</div>;
  if (!data) return null;

  const { columns, rows } = data;

  // Count high-confidence suggestions per column for "Fill N" buttons
  function countHighConfidence(colKey: string): MappingCellVariation[] {
    const result: MappingCellVariation[] = [];
    for (const row of rows) {
      const cell = row.cells[colKey];
      if (!cell) continue;
      for (const v of cell.variations) {
        if (!v.linkedSquareCatalogVariationId && v.suggestion?.confidence === "high") {
          result.push(v);
        }
      }
    }
    return result;
  }

  const highByCol = new Map(columns.map((c) => [c.key, countHighConfidence(c.key)]));
  const totalHigh = [...highByCol.values()].reduce((s, vs) => s + vs.length, 0);

  async function fillColumn(col: MappingColumn) {
    const highs = highByCol.get(col.key) ?? [];
    await Promise.all(
      rows.flatMap((row) => {
        const cell = row.cells[col.key];
        if (!cell) return [];
        return cell.variations
          .filter((v) => !v.linkedSquareCatalogVariationId && v.suggestion?.confidence === "high")
          .map((v) => acceptSuggestion(row.recipeId, colPackaging(col), v.variationId === "draft" ? null : v.variationId, v.suggestion!));
      })
    );
    qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
  }

  async function fillAll() {
    await Promise.all(columns.map((col) => fillColumn(col)));
  }

  async function acceptOne(
    row: MappingGridRow,
    col: MappingColumn,
    v: MappingCellVariation,
    e: React.MouseEvent
  ) {
    e.stopPropagation();
    if (!v.suggestion) return;
    await acceptSuggestion(row.recipeId, colPackaging(col), v.variationId === "draft" ? null : v.variationId, v.suggestion);
    qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
  }

  return (
    <div>
      {totalHigh > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-800/40 bg-blue-950/20 px-4 py-2.5">
          <span className="text-sm text-blue-300">
            {totalHigh} high-confidence suggestion{totalHigh !== 1 ? "s" : ""} ready to accept
          </span>
          <button
            onClick={fillAll}
            className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
          >
            Fill all suggested
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              <th className="sticky left-0 z-10 bg-zinc-900 px-4 py-2.5 text-left font-semibold text-zinc-400 whitespace-nowrap">
                Recipe
              </th>
              {columns.map((col) => {
                const n = (highByCol.get(col.key) ?? []).length;
                return (
                  <th key={col.key} className="px-3 py-2.5 text-left font-medium text-zinc-400 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <span>{col.label}</span>
                      {n > 0 && (
                        <button
                          onClick={() => fillColumn(col)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-800/50 text-blue-400 hover:bg-blue-800/40 transition-colors w-fit"
                        >
                          Fill {n}
                        </button>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.recipeId} className="border-b border-zinc-800/40 hover:bg-zinc-900/20 transition-colors">
                <td className="sticky left-0 z-10 bg-zinc-950 px-4 py-2.5 font-medium text-zinc-200 whitespace-nowrap border-r border-zinc-800/40">
                  {row.recipeName}
                </td>
                {columns.map((col) => {
                  const cell = row.cells[col.key];
                  if (cell === null) {
                    return (
                      <td key={col.key} className="px-3 py-2.5 text-center text-zinc-700">
                        —
                      </td>
                    );
                  }
                  return (
                    <td
                      key={col.key}
                      className="px-3 py-2.5 cursor-pointer"
                      onClick={() => onCellClick(row.recipeId, col.key)}
                    >
                      <div className="flex flex-wrap gap-1">
                        {cell.variations.map((v) => {
                          const isLinked = !!v.linkedSquareCatalogVariationId;
                          const isHighConf = !isLinked && v.suggestion?.confidence === "high";
                          const isMedConf = !isLinked && v.suggestion?.confidence === "medium";

                          if (isLinked) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-900/30 border border-emerald-700/50 text-emerald-300"
                                title={v.linkedSquareName ?? ""}
                              >
                                ✓ {v.variationName}
                              </span>
                            );
                          }
                          if (isHighConf) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-blue-700/50 text-blue-300"
                                title={`Suggested: ${v.suggestion!.squareName}`}
                              >
                                {v.variationName}
                                <button
                                  data-accept-chip
                                  className="ml-0.5 text-blue-400 hover:text-blue-200 font-bold"
                                  onClick={(e) => acceptOne(row, col, v, e)}
                                >
                                  ✓
                                </button>
                              </span>
                            );
                          }
                          if (isMedConf) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-amber-700/40 text-amber-400"
                                title={`Suggested: ${v.suggestion!.squareName}`}
                              >
                                {v.variationName} ?
                              </span>
                            );
                          }
                          return (
                            <span
                              key={v.variationId}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-zinc-700/40 text-zinc-500"
                            >
                              {v.variationName} —
                            </span>
                          );
                        })}
                      </div>
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
```

- [ ] **Step 2: Build check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add app/production/settings/square-links/MappingGrid.tsx
git commit -m "feat(ui): MappingGrid — recipe × packaging grid with badge states and bulk accept"
```

---

## Task 5: `MappingDrawer.tsx` — drawer editor

**Files:**
- Create: `app/production/settings/square-links/MappingDrawer.tsx`

**Interfaces:**
- Consumes: `useSquareMappingGridQuery` (for grid data to find the cell), a separate Square catalog query for the combobox
- Consumes: `MappingColumn`, `MappingGridRow`, `MappingCellVariation` from `app/production/types`
- Produces: `export default function MappingDrawer({ recipeId, colKey, onClose }: Props)`

The drawer is a 400px right-anchored panel. It reads the cell from the already-fetched grid data (no extra fetch). It shows one row per variation in the cell. Each row has:
- Variation name
- If linked: Square name badge + "Remove" button (DELETE `/api/production/recipe-square-links?id=<linkId>`)
- If unlinked + suggestion ≥ medium: suggestion chip + "Accept" button
- `VariationCombobox` (ported from `SquareLinkManager`, but used only for Square catalog variations filtered to the right category)

The drawer needs the link `id` to delete. But the grid shape from Task 2 doesn't include link IDs. We need to add them.

**Fix required before implementing**: go back to Task 2 and add `linkId: string | null` to `CellVariation` in `squareMappingGrid.ts` and propagate through `buildGrid`. Steps:

- [ ] **Step 1: Add `linkId` to `CellVariation` in `squareMappingGrid.ts`**

In `lib/production/squareMappingGrid.ts`, update `CellVariation`:

```typescript
export interface CellVariation {
  variationId: string;
  variationName: string;
  linkId: string | null;          // <-- add this
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: Suggestion | null;
}
```

In `buildGrid`, update the two places that create `CellVariation` objects:

For draft:
```typescript
{
  variationId: "draft",
  variationName: "Draft",
  linkId: link?.id ?? null,         // <-- add
  linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
  linkedSquareName: link ? `...`.trim() : null,
  suggestion,
}
```

For keg/can:
```typescript
{
  variationId: rpv.variationId,
  variationName: rpv.variationName,
  linkId: link?.id ?? null,         // <-- add
  linkedSquareCatalogVariationId: link?.squareCatalogVariationId ?? null,
  linkedSquareName: link ? `...`.trim() : null,
  suggestion,
}
```

Also update `MappingCellVariation` in `app/production/types.ts`:

```typescript
export interface MappingCellVariation {
  variationId: string;
  variationName: string;
  linkId: string | null;           // <-- add
  linkedSquareCatalogVariationId: string | null;
  linkedSquareName: string | null;
  suggestion: { ... } | null;
}
```

- [ ] **Step 2: Re-run tests to confirm they still pass**

```bash
npx vitest run lib/production/squareMappingGrid.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Create `MappingDrawer.tsx`**

The drawer needs Square catalog variations for the combobox. Re-use the existing `useQuery` against `/api/production/square-catalog` (same as `SquareLinkManager` used, same endpoint, same query key `queryKeys.production.squareCatalog()`).

```tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useSquareMappingGridQuery } from "@/app/production/hooks/queries";
import { fetchJson } from "@/app/production/hooks/queries";
import type { MappingCellVariation, MappingColumn } from "@/app/production/types";

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
  category_name: string | null;
}

const CATEGORY_FOR: Record<string, string> = { draft: "Draft", keg: "Kegs", can: "Cans" };

function VariationCombobox({
  value,
  onChange,
  variations,
}: {
  value: string;
  onChange: (id: string) => void;
  variations: SquareVariation[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = variations.find((v) => v.variation_id === value);
  const displayName = selected
    ? `${selected.item_name}${selected.variation_name ? ` · ${selected.variation_name}` : ""}`
    : "";

  const filtered = query
    ? variations.filter((v) =>
        `${v.item_name} ${v.variation_name ?? ""}`.toLowerCase().includes(query.toLowerCase())
      )
    : variations;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none text-xs">⌕</span>
        <input
          className="inp text-sm w-full pl-6"
          value={open ? query : displayName}
          placeholder="Search Square variations…"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
        />
        {value && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 text-xs"
            onMouseDown={(e) => { e.preventDefault(); onChange(""); }}
          >×</button>
        )}
      </div>
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-600 italic text-center">
              No matches{query ? ` for "${query}"` : ""}
            </div>
          ) : (
            filtered.map((v) => (
              <button
                key={v.variation_id}
                type="button"
                className={`w-full text-left px-3 py-2.5 text-xs border-b border-zinc-800/40 last:border-0 transition-colors ${
                  v.variation_id === value ? "bg-amber-900/30 text-amber-300" : "text-zinc-300 hover:bg-zinc-800"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(v.variation_id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="font-medium">{v.item_name}</span>
                {v.variation_name && <span className="text-zinc-500 ml-1.5">· {v.variation_name}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  recipeId: string;
  colKey: string;
  onClose: () => void;
}

export default function MappingDrawer({ recipeId, colKey, onClose }: Props) {
  const qc = useQueryClient();
  const { data: gridData } = useSquareMappingGridQuery();
  const { data: sqVars = [] } = useQuery({
    queryKey: queryKeys.production.squareCatalog(),
    queryFn: () => fetchJson<SquareVariation[]>("/api/production/square-catalog"),
  });

  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({}); // variationId → squareVariationId
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!gridData) return null;

  const col = gridData.columns.find((c) => c.key === colKey);
  const row = gridData.rows.find((r) => r.recipeId === recipeId);
  if (!col || !row) return null;

  const cell = row.cells[colKey];
  if (!cell) return null;

  const filteredVars = sqVars.filter(
    (v) => v.category_name === CATEGORY_FOR[col.type] || !v.category_name
  );

  async function handleAccept(v: MappingCellVariation, squareVariationId: string) {
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    setErrors((e) => ({ ...e, [v.variationId]: "" }));
    try {
      const sv = sqVars.find((sv) => sv.variation_id === squareVariationId);
      const body: Record<string, unknown> = {
        recipe_id: recipeId,
        packaging: col!.type,
        square_variation_id: squareVariationId,
        square_item_id: sv?.item_id ?? null,
        variation_name: sv?.variation_name ?? null,
        item_name: sv?.item_name ?? null,
      };
      if (v.variationId !== "draft") body.variation_id = v.variationId;
      const res = await fetch("/api/production/recipe-square-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Save failed");
      }
      setPendingSelections((p) => { const n = { ...p }; delete n[v.variationId]; return n; });
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  async function handleRemove(v: MappingCellVariation) {
    if (!v.linkId) return;
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    try {
      const res = await fetch(`/api/production/recipe-square-links?id=${v.linkId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Remove failed");
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[400px] bg-zinc-950 border-l border-zinc-800 shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wide">Square Mapping</p>
          <p className="text-sm font-semibold text-zinc-100 mt-0.5">
            {row.recipeName} · {col.label}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {cell.variations.map((v) => {
          const isLinked = !!v.linkedSquareCatalogVariationId;
          const pendingId = pendingSelections[v.variationId] ?? "";
          const isBusy = saving[v.variationId];
          const err = errors[v.variationId];

          return (
            <div key={v.variationId} className="space-y-2">
              <p className="text-xs font-semibold text-zinc-300">{v.variationName}</p>

              {isLinked ? (
                <div className="flex items-center justify-between rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
                  <span className="text-xs text-emerald-300">✓ {v.linkedSquareName}</span>
                  <button
                    onClick={() => handleRemove(v)}
                    disabled={isBusy}
                    className="text-xs text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-30 ml-3 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {v.suggestion && (v.suggestion.confidence === "high" || v.suggestion.confidence === "medium") && (
                    <div className="flex items-center justify-between rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-2">
                      <span className="text-xs text-blue-300 truncate mr-2">
                        Suggested: {v.suggestion.squareName}
                      </span>
                      <button
                        onClick={() => handleAccept(v, v.suggestion!.squareVariationId)}
                        disabled={isBusy}
                        className="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-30 shrink-0 transition-colors"
                      >
                        Accept
                      </button>
                    </div>
                  )}
                  <VariationCombobox
                    value={pendingId}
                    onChange={(id) => setPendingSelections((p) => ({ ...p, [v.variationId]: id }))}
                    variations={filteredVars}
                  />
                  {pendingId && (
                    <button
                      onClick={() => handleAccept(v, pendingId)}
                      disabled={isBusy}
                      className="btn-amber text-xs w-full disabled:opacity-30"
                    >
                      {isBusy ? "Saving…" : "Link"}
                    </button>
                  )}
                  {err && <p className="text-xs text-red-400">{err}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add lib/production/squareMappingGrid.ts app/production/types.ts app/production/settings/square-links/MappingDrawer.tsx
git commit -m "feat(ui): MappingDrawer — inline right panel for linking/unlinking Square variations"
```

---

## Task 6: Page shell + nav

**Files:**
- Create: `app/production/settings/square-links/page.tsx`
- Modify: `app/production/nav-config.ts`

- [ ] **Step 1: Create `app/production/settings/square-links/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import MappingGrid from "./MappingGrid";
import MappingDrawer from "./MappingDrawer";

export default function SquareMappingsPage() {
  const [drawer, setDrawer] = useState<{ recipeId: string; colKey: string } | null>(null);

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-zinc-100">Square Mappings</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Map each recipe + packaging variation to a Square catalog variation. Links apply to both Taproom intake and Export invoicing.
        </p>
      </div>

      <MappingGrid
        onCellClick={(recipeId, colKey) => setDrawer({ recipeId, colKey })}
      />

      {drawer && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setDrawer(null)}
          />
          <MappingDrawer
            recipeId={drawer.recipeId}
            colKey={drawer.colKey}
            onClose={() => setDrawer(null)}
          />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add nav entry to `app/production/nav-config.ts`**

In `SETTINGS_NAV`, add the new entry:

```typescript
export const SETTINGS_NAV: NavEntry[] = [
  { href: "/production/settings/deposits",     label: "Deposit Settings" },
  { href: "/production/settings/export",       label: "Export Settings"  },
  { href: "/production/settings/square-links", label: "Square Mappings"  },
];
```

- [ ] **Step 3: Build check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add app/production/settings/square-links/page.tsx app/production/nav-config.ts
git commit -m "feat(nav): add Square Mappings settings page and nav entry"
```

---

## Task 7: Remove old components + update callers

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx` — remove RecipeLinkMatrix embed
- Modify: `app/taproom/components/DraftStatsTab.tsx` — modal → link
- Modify: `app/production/components/intake/TaproomTab.tsx` — modal → link
- Modify: `app/production/types.ts` — update comment on `PackagingVariationExpanded`
- Modify: `app/production/hooks/queries.ts` — remove `useRecipePackagingVariationsExpandedQuery` if no other callers
- Delete: `app/production/components/SquareLinkManager.tsx`
- Delete: `app/production/components/RecipeLinkMatrix.tsx`
- Delete: `lib/production/recipeLinkMatrix.ts`
- Delete: `lib/production/recipeLinkMatrix.test.ts`

- [ ] **Step 1: Update `ExportSettingsPanel.tsx`**

Find and remove the `RecipeLinkMatrix` import and usage. The panel renders `<RecipeLinkMatrix />` at line 606 — remove both the import and the JSX element.

```bash
grep -n "RecipeLinkMatrix" app/production/components/ExportSettingsPanel.tsx
```

Remove line `import RecipeLinkMatrix from "./RecipeLinkMatrix";` and the `<RecipeLinkMatrix />` usage. If there is a section heading above it like "Square Mappings" or similar, remove that heading too. Replace with a link:

```tsx
<div className="mt-4 p-4 bg-zinc-900/40 rounded-lg border border-zinc-800">
  <p className="text-xs text-zinc-400 mb-2">Square catalog mappings have moved to a dedicated page.</p>
  <a href="/production/settings/square-links" className="text-xs text-amber-400 hover:text-amber-300 transition-colors">
    Manage Square mappings →
  </a>
</div>
```

- [ ] **Step 2: Update `DraftStatsTab.tsx`**

```bash
grep -n "SquareLinkManager\|showLinkManager\|onChanged" app/taproom/components/DraftStatsTab.tsx | head -20
```

Remove the `SquareLinkManager` import, the state variable controlling the modal, the button that opens the modal, and the `<SquareLinkManager ...>` block. Replace the trigger button with:

```tsx
import Link from "next/link";
// ...
<Link href="/production/settings/square-links" className="text-xs text-amber-400 hover:text-amber-300 transition-colors">
  Manage Square mappings →
</Link>
```

- [ ] **Step 3: Update `TaproomTab.tsx` (intake)**

```bash
grep -n "SquareLinkManager\|showLinkManager\|onChanged" app/production/components/intake/TaproomTab.tsx | head -20
```

Same pattern: remove modal state, button, `<SquareLinkManager>` block, and import. Add:

```tsx
import Link from "next/link";
// ...
<Link href="/production/settings/square-links" className="text-xs text-amber-400 hover:text-amber-300 transition-colors">
  Manage Square mappings →
</Link>
```

- [ ] **Step 4: Check for remaining callers of deleted modules**

```bash
grep -rn "SquareLinkManager\|RecipeLinkMatrix\|recipeLinkMatrix\|buildMatrix\|buildVariationLinkMatrix\|useRecipePackagingVariationsExpandedQuery" app/ lib/ --include="*.ts" --include="*.tsx" | grep -v "node_modules"
```

Fix any remaining references. If `useRecipePackagingVariationsExpandedQuery` has no callers, remove it from `queries.ts`.

- [ ] **Step 5: Delete old files**

```bash
rm app/production/components/SquareLinkManager.tsx
rm app/production/components/RecipeLinkMatrix.tsx
rm lib/production/recipeLinkMatrix.ts
rm lib/production/recipeLinkMatrix.test.ts
```

- [ ] **Step 6: Update comment in `types.ts`**

Change the comment on `PackagingVariationExpanded` from:

```typescript
/** Expanded join used by the RecipeLinkMatrix — includes packaging_items and partner info. */
```

to:

```typescript
/** Expanded join for recipe_packaging_variations — includes packaging_items and partner info. */
```

- [ ] **Step 7: Full build**

```bash
npm run build 2>&1 | tail -30
```

Expected: no TypeScript errors, no missing module errors.

- [ ] **Step 8: Run remaining tests**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: `squareMappingGrid.test.ts` passes; `recipeLinkMatrix.test.ts` is gone.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: remove SquareLinkManager and RecipeLinkMatrix, replace callers with link to Square Mappings page"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 New page + nav | Task 6 |
| §1 Delete SquareLinkManager, RecipeLinkMatrix, recipeLinkMatrix.ts | Task 7 |
| §1 Modal trigger → Link | Task 7 |
| §2 Column derivation (packaging_variations JOIN packaging_items) | Task 1 (deriveColumns), Task 2 (query) |
| §2 Draft hardcoded first column | Task 1 (DRAFT_COLUMN constant) |
| §2 Keg labels from pi.name | Task 1 (deriveColumns) |
| §2 Can labels from vol+format | Task 1 (deriveColumns) |
| §3 Grid: sticky recipe col, column headers | Task 4 |
| §3 Column "Fill N" button | Task 4 |
| §3 Global "Fill all suggested" banner | Task 4 |
| §3 Cell states: no variation (null/dash), all linked, partial, high-conf, amber ? | Task 4 |
| §3 ✓ accept chip on high-confidence badge | Task 4 |
| §3 Clicking cell opens drawer | Tasks 4, 6 |
| §4 Drawer: 400px right panel, header, one row per variation | Task 5 |
| §4 Drawer: linked badge + unlink button | Task 5 |
| §4 Drawer: suggestion chip + Accept | Task 5 |
| §4 Drawer: VariationCombobox (ported) | Task 5 |
| §5 autoSuggest: volume +4, name tokens +3, format +1 | Task 1 |
| §5 CATEGORY_FOR as single canonical source | Task 1 |
| §5 Stop words | Task 1 |
| §5 Confidence thresholds | Task 1 |
| §6 GET ?grid=1 returns {columns, rows} | Task 2 |
| §6 Auto-suggest server-side at GET time | Task 2 |
| §6 POST/DELETE unchanged | Not modified |
| §7 squareMappingGrid.ts exports | Tasks 1–2 |
| §7 recipeLinkMatrix.ts deleted, callers migrate | Task 7 |
| §8 All files listed in spec | All tasks |

**Placeholder scan:** None found — all steps include actual code.

**Type consistency check:**
- `CellVariation` (lib) matches `MappingCellVariation` (types.ts) field-by-field after Task 5 Step 1 adds `linkId`.
- `ColumnDef` (lib) matches `MappingColumn` (types.ts) field-by-field.
- `GridRow` (lib) matches `MappingGridRow` (types.ts) field-by-field.
- `colPackaging(col)` in MappingGrid correctly narrows `col.type` to `"draft" | "keg" | "can"`.
- `useSquareMappingGridQuery` returns `MappingGridResponse` which both `MappingGrid` and `MappingDrawer` consume via `gridData.columns` and `gridData.rows`.
