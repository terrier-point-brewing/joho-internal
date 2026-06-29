// lib/production/squareMappingGrid.ts

export const CATEGORY_FOR = {
  draft: "Draft",
  keg:   "Kegs",
  can:   "Cans",
} as const;

const STOP_WORDS = new Set(["the", "a", "ipa", "ale", "lager", "stout", "porter"]);

// Standard keg sizes: fl oz → fraction string that appears in Square variation names.
const KEG_FRACTION: Record<number, string> = {
  1984: "1/2",
  992:  "1/4",
  661:  "1/6",
  440:  "1/8",
};
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
  squareItemId: string | null;
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
  recipePartnerName: string | null;
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
  format: string | null,
  sqVars: SquareCatalogVariationFlat[]
): Suggestion | null {
  const category = CATEGORY_FOR[containerType];
  const candidates = sqVars.filter((v) => v.categoryName === category);

  const beerTokens = new Set(tokenize(beerName));
  let bestScore = -1;
  let best: SquareCatalogVariationFlat | null = null;

  for (const sv of candidates) {
    // Skip items with known mismatched volume (when volumeFlOzPerUnit is populated).
    if (
      containerVolumeFlOz != null &&
      sv.volumeFlOzPerUnit != null &&
      containerVolumeFlOz !== sv.volumeFlOzPerUnit
    ) {
      continue;
    }

    // Fallback: for kegs, use the keg-size fraction in the variation name to filter
    // when volumeFlOzPerUnit is null (common when the catalog sync didn't populate it).
    if (containerType === "keg" && containerVolumeFlOz != null && sv.volumeFlOzPerUnit == null) {
      const expectedFraction = KEG_FRACTION[containerVolumeFlOz];
      if (expectedFraction) {
        const fractionMatch = sv.variationName.match(/\d\/\d/);
        if (fractionMatch && !sv.variationName.includes(expectedFraction)) continue;
      }
    }

    // Fallback: for cans, filter by oz parsed from variation name when volumeFlOzPerUnit is null.
    // "Regular 16oz 4-Pack" should be excluded from a 12oz column.
    if (containerType === "can" && containerVolumeFlOz != null && sv.volumeFlOzPerUnit == null) {
      const ozMatch = sv.variationName.match(/(\d+)\s*oz/i) ?? sv.itemName.match(/(\d+)\s*oz/i);
      if (ozMatch && parseInt(ozMatch[1]) !== containerVolumeFlOz) continue;
    }

    let score = 0;

    // +5 exact volume match from volumeFlOzPerUnit
    if (containerVolumeFlOz != null && sv.volumeFlOzPerUnit != null && containerVolumeFlOz === sv.volumeFlOzPerUnit) {
      score += 5;
    }

    // +3 per overlapping beer-name token (proportional — was binary: overlap > 0 → +3)
    const svTokens = tokenize(sv.itemName);
    const overlap = svTokens.filter((t) => beerTokens.has(t)).length;
    score += overlap * 3;

    // +2 when variation name contains a format keyword matching the slot's format
    if (format && containerType === "can") {
      const vn = sv.variationName.toLowerCase();
      const formatKeywords: Record<string, string[]> = {
        loose: ["loose", "single"],
        "4-pack": ["4-pack", "4pack"],
        "6-pack": ["6-pack", "6pack"],
        case: ["case"],
      };
      const keywords = formatKeywords[format] ?? [];
      if (keywords.some((k) => vn.includes(k))) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = sv;
    }
  }

  // Require at least 1 overlapping name token (score < 3 → no useful match)
  if (!best || bestScore < 3) return null;

  return {
    squareCatalogVariationId: null,
    squareVariationId: best.squareVariationId,
    squareItemId: best.squareItemId,
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
    // Kegs: one column per size regardless of partner — generic and partner-specific
    // variations all belong to the same "1/2 Keg" / "1/4 Keg" / "1/6 Keg" column.
    const key = rpv.containerType === "keg"
      ? `keg|${rpv.volumeFlOz}`
      : `${rpv.containerType}|${rpv.volumeFlOz}|${rpv.format}`;
    if (!seen.has(key)) {
      const label =
        rpv.containerType === "keg"
          ? rpv.containerName
          : `${rpv.volumeFlOz}oz ${FORMAT_LABELS[rpv.format] ?? rpv.format}`;
      seen.set(key, { key, label, type: rpv.containerType, volumeFlOz: rpv.volumeFlOz, format: rpv.format });
    } else if (rpv.containerType === "keg" && rpv.partnerId === null) {
      // Prefer the generic container name (e.g. "1/2 Keg") over a partner-specific one
      // (e.g. "Fortnight 1/2 Keg") for the column label.
      seen.get(key)!.label = rpv.containerName;
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
  recipes: { id: string; beerName: string; partnerName?: string | null }[],
  columns: ColumnDef[],
  rpvs: RpvRow[],
  links: LinkRow[],
  sqVars: SquareCatalogVariationFlat[]
): GridRow[] {
  // Index links by `${variationId}::${recipeId}` (composite) and by recipeId (for draft).
  // Keying by variationId alone causes all recipes sharing a generic keg variation
  // to appear linked whenever any one recipe links it.
  const linkByVariation = new Map<string, LinkRow>(); // key: `${variationId}::${recipeId}`
  const draftLinkByRecipe = new Map<string, LinkRow>();
  for (const l of links) {
    if (l.packaging === "draft") {
      draftLinkByRecipe.set(l.recipeId, l);
    } else if (l.variationId) {
      linkByVariation.set(`${l.variationId}::${l.recipeId}`, l);
    }
  }

  // Index rpvs by recipe + column key
  type RpvIndex = Map<string, RpvRow[]>; // colKey → [rpv]
  const rpvsByRecipeCol = new Map<string, RpvIndex>();
  for (const rpv of rpvs) {
    if (!rpv.isActive) continue;
    if (!rpvsByRecipeCol.has(rpv.recipeId)) rpvsByRecipeCol.set(rpv.recipeId, new Map());
    const colKey = rpv.containerType === "keg"
      ? `keg|${rpv.volumeFlOz}`
      : `${rpv.containerType}|${rpv.volumeFlOz}|${rpv.format}`;
    const idx = rpvsByRecipeCol.get(rpv.recipeId)!;
    if (!idx.has(colKey)) idx.set(colKey, []);
    idx.get(colKey)!.push(rpv);
  }

  // Generic keg variations (partner_id = null) are usable for any recipe without an explicit
  // recipe_packaging_variations row, so we collect one representative per volume and inject
  // it into every recipe's keg cell if the recipe doesn't already list it.
  const genericKegByVolume = new Map<number, RpvRow>();
  for (const rpv of rpvs) {
    if (rpv.containerType !== "keg" || rpv.partnerId !== null || !rpv.isActive) continue;
    if (!genericKegByVolume.has(rpv.volumeFlOz)) genericKegByVolume.set(rpv.volumeFlOz, rpv);
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
          : autoSuggest(recipe.beerName, null, "draft", null, sqVars);
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

      const ownRpvs = recipeRpvs?.get(col.key) ?? [];

      let colRpvs: RpvRow[];
      if (col.type === "keg" && col.volumeFlOz != null) {
        const generic = genericKegByVolume.get(col.volumeFlOz);
        const alreadyHasGeneric = generic && ownRpvs.some((r) => r.variationId === generic.variationId);
        colRpvs = generic && !alreadyHasGeneric ? [...ownRpvs, generic] : ownRpvs;
      } else {
        colRpvs = ownRpvs;
      }

      if (colRpvs.length === 0) {
        cells[col.key] = null;
        continue;
      }

      const variations: CellVariation[] = colRpvs.map((rpv) => {
        const link = linkByVariation.get(`${rpv.variationId}::${recipe.id}`);
        const suggestion = link
          ? null
          : autoSuggest(recipe.beerName, rpv.volumeFlOz, rpv.containerType, rpv.format, sqVars);
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

    return { recipeId: recipe.id, recipeName: recipe.beerName, recipePartnerName: recipe.partnerName ?? null, cells };
  });
}
