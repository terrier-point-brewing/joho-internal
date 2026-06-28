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
