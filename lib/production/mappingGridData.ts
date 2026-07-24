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
} from "@/lib/production/squareMappingGrid";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

export interface MappingGrid {
  columns: ColumnDef[];
  rows: GridRow[];
  catalogSyncedAt: string | null;
}

export async function fetchMappingGrid(supabase: DbClient): Promise<MappingGrid> {
  const [
    { data: rpvData, error: rpvErr },
    { data: linksData, error: linksErr },
    { data: sqVarData, error: sqVarErr },
    { data: recipesData, error: recipesErr },
    { data: genericKegData, error: genericKegErr },
    { data: ignoreData, error: ignoreErr },
  ] = await Promise.all([
    supabase
      .from("recipe_packaging_variations")
      .select(`
        recipe_id, variation_id,
        packaging_variations (
          id, name, format, is_active, partner_id,
          packaging_items:container_id ( id, name, type, volume_fl_oz ),
          contract_brewing_partners ( company_name )
        )
      `),
    supabase
      .from("recipe_square_links")
      .select("id, recipe_id, packaging, variation_id, catalog_variation_id, square_variation_id, variation_name, item_name")
      .order("created_at"),
    supabase
      .from("square_catalog_variations")
      .select("id, square_variation_id, variation_name, volume_fl_oz_per_unit, synced_at, square_catalog_items ( square_item_id, item_name, category_name )"),
    supabase
      .from("recipes")
      .select("id, beer_name, contract_brewing_partners(company_name)")
      .order("beer_name"),
    // Generic keg variations (no partner) are not recipe-scoped — fetch them directly
    // so they can be offered as linkable slots for every recipe in the grid.
    supabase
      .from("packaging_variations")
      .select("id, name, format, is_active, packaging_items:container_id ( id, name, type, volume_fl_oz )")
      .is("partner_id", null)
      .eq("is_active", true),
    supabase
      .from("recipe_square_link_ignores")
      .select("id, recipe_id, packaging, variation_id"),
  ]);

  if (rpvErr) throw new Error(rpvErr.message);
  if (linksErr) throw new Error(linksErr.message);
  if (sqVarErr) throw new Error(sqVarErr.message);
  if (recipesErr) throw new Error(recipesErr.message);
  if (genericKegErr) throw new Error(genericKegErr.message);
  if (ignoreErr) throw new Error(ignoreErr.message);

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
  const rows = buildGrid(recipesList, columns, allRpvRows, linkRows, sqVarRows, ignoreRows);

  return { columns, rows, catalogSyncedAt };
}
