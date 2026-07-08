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
