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
  linkId: string | null;
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
              linkId: link?.id ?? null,
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
          linkId: link?.id ?? null,
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
