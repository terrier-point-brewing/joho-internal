// lib/production/mappingGridData.ts
//
// Fetches the raw recipe / packaging-variation / Square-catalog data and shapes
// it through the pure squareMappingGrid builders into a { columns, rows } grid.
//
// This is the single source of truth for the Square-mapping grid structure. Both
// the production Square Item Mappings screen (/api/production/recipe-square-links
// ?grid=1) and the taproom cold-storage Inventory grid (/api/taproom/inventory)
// consume it, so the two views always share the same columns and cell membership.

import { deriveColumns, buildGrid } from "@/lib/production/squareMappingGrid";
import type {
  RpvRow,
  SquareCatalogVariationFlat,
  LinkRow,
  IgnoreRow,
  ColumnDef,
  GridRow,
  FungibleContext,
} from "@/lib/production/squareMappingGrid";

type DbClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string) => PromiseLike<{ data: any; error: { message: string } | null }>;
};

export interface MappingGrid {
  columns: ColumnDef[];
  rows: GridRow[];
  catalogSyncedAt: string | null;
}

type Raw = Record<string, unknown>;

export async function fetchMappingGrid(supabase: DbClient): Promise<MappingGrid> {
  // One round trip. The grid used to read these tables with eight separate API
  // calls and waited for the slowest; see the square_mapping_grid_source migration.
  const { data: source, error } = await supabase.rpc("square_mapping_grid_source");
  if (error) throw new Error(error.message);

  const src = (source ?? {}) as Record<string, Raw[] | undefined>;
  const rpvData = src.rpv ?? [];
  const linksData = src.links ?? [];
  const sqVarData = src.sq_vars ?? [];
  const recipesData = src.recipes ?? [];
  const genericKegData = src.generic_kegs ?? [];
  const ignoreData = src.ignores ?? [];

  // Shape the raw data into the types expected by squareMappingGrid functions
  const rpvRows: RpvRow[] = (rpvData ?? []).flatMap((rpv: Record<string, unknown>) => {
    const pv = rpv.packaging_variations as unknown as {
      id: string; name: string; format: string; is_active: boolean; partner_id: string | null;
      packaging_items: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
      contract_brewing_partners: { company_name: string } | null;
    } | null;
    if (!pv || !pv.packaging_items || !pv.is_active) return [];
    if (pv.packaging_items.type !== "keg" && pv.packaging_items.type !== "can") return [];
    if (pv.packaging_items.volume_fl_oz == null) return [];
    return [{
      recipeId: rpv.recipe_id as string,
      variationId: rpv.variation_id as string,
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

  // Append generic keg variations with a sentinel recipeId so deriveColumns can
  // set the correct label ("1/2 Keg") and buildGrid can inject them into every recipe.
  const genericKegRows: RpvRow[] = (genericKegData ?? []).flatMap((pv: Record<string, unknown>) => {
    const pi = pv.packaging_items as unknown as { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
    if (!pi || pi.type !== "keg" || pi.volume_fl_oz == null) return [];
    return [{
      recipeId: "",
      variationId: pv.id as string,
      containerType: "keg" as const,
      volumeFlOz: pi.volume_fl_oz,
      format: pv.format as string,
      containerName: pi.name,
      isActive: pv.is_active as boolean,
      partnerId: null,
      partnerName: null,
      variationName: pv.name as string,
    }];
  });
  const allRpvRows = [...rpvRows, ...genericKegRows];

  const sqVarRows: SquareCatalogVariationFlat[] = (sqVarData ?? []).flatMap((sv: Record<string, unknown>) => {
    const item = sv.square_catalog_items as unknown as { square_item_id: string; item_name: string; category_name: string | null } | null;
    if (!item) return [];
    return [{
      squareVariationId: sv.square_variation_id as string,
      squareItemId: item.square_item_id,
      itemName: item.item_name,
      variationName: (sv as unknown as { variation_name: string }).variation_name ?? "",
      categoryName: item.category_name,
      volumeFlOzPerUnit: (sv.volume_fl_oz_per_unit as number | null) ?? null,
    }];
  });

  const linkRows: LinkRow[] = (linksData ?? []).map((l: Record<string, unknown>) => ({
    id: l.id as string,
    recipeId: l.recipe_id as string,
    packaging: l.packaging as "draft" | "keg" | "can",
    variationId: (l.variation_id as string | null) ?? null,
    squareCatalogVariationId: (l.catalog_variation_id as string | null) ?? null,
    squareVariationId: l.square_variation_id as string,
    variationName: (l.variation_name as string | null) ?? null,
    itemName: (l.item_name as string | null) ?? null,
  }));

  const ignoreRows: IgnoreRow[] = (ignoreData ?? []).map((ig: Record<string, unknown>) => ({
    id: ig.id as string,
    recipeId: ig.recipe_id as string,
    packaging: ig.packaging as "draft" | "keg" | "can",
    variationId: (ig.variation_id as string | null) ?? null,
  }));

  let catalogSyncedAt: string | null = null;
  for (const sv of (sqVarData ?? []) as Array<{ synced_at: string | null }>) {
    const t = sv.synced_at ?? null;
    if (t && (!catalogSyncedAt || t > catalogSyncedAt)) catalogSyncedAt = t;
  }

  const recipesList = (recipesData ?? [])
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      beerName: r.beer_name as string,
      partnerName: (r.contract_brewing_partners as unknown as { company_name: string } | null)?.company_name ?? null,
    }))
    .sort((a: { beerName: string; partnerName: string | null }, b: { beerName: string; partnerName: string | null }) => {
      if (a.partnerName !== b.partnerName) {
        if (a.partnerName === null) return -1;
        if (b.partnerName === null) return 1;
        return a.partnerName.localeCompare(b.partnerName);
      }
      return a.beerName.localeCompare(b.beerName);
    });

  const columns = deriveColumns(allRpvRows);
  const rows = buildGrid(
    recipesList, columns, allRpvRows, linkRows, sqVarRows, ignoreRows,
    buildFungibleContext(src.fungible ?? [], src.lots ?? []),
  );

  return { columns, rows, catalogSyncedAt };
}

/**
 * Declared fungible SKUs plus the stock ages that order their drain. The lots
 * arrive already scoped to the member variations of a declared shared button.
 */
function buildFungibleContext(fungible: Raw[], lots: Raw[]): FungibleContext {
  const declared = new Set(
    (fungible as { recipe_id: string; square_variation_id: string }[]).map(
      (r) => `${r.recipe_id}\t${r.square_variation_id}`,
    ),
  );
  const stockAgeByVariation = new Map<string, string>();
  const onHandByVariation = new Map<string, number>();

  for (const lot of lots as { variation_id: string; quantity_on_hand: number | string; created_at: string }[]) {
    const qty = Number(lot.quantity_on_hand);
    if (!(qty > 0)) continue; // an empty lot is not stock, and has no age worth ranking
    onHandByVariation.set(lot.variation_id, (onHandByVariation.get(lot.variation_id) ?? 0) + qty);
    const seen = stockAgeByVariation.get(lot.variation_id);
    if (seen === undefined || lot.created_at.localeCompare(seen) < 0) {
      stockAgeByVariation.set(lot.variation_id, lot.created_at);
    }
  }

  return { declared, stockAgeByVariation, onHandByVariation };
}
