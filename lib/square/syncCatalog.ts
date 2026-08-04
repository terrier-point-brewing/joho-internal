// lib/square/syncCatalog.ts
//
// Mirrors Square's catalog into square_catalog_items / square_catalog_variations.
//
// Lives here rather than in the route so the deletion-marking pass is unit
// testable. That pass flags every mirror row a run did not touch, which makes it
// the one piece of this sync that can do wide damage if its guard is wrong — a
// bad run could mark the whole catalog dead.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalogItems, fetchCatalogCategories, fetchCatalogTaxes } from "./catalog";
import { volumeFlOzPerUnit, inferInventoryUnit } from "./catalogUnits";

export interface CatalogSyncResult {
  items: number;
  variations: number;
  itemsMarkedDeleted: number;
  variationsMarkedDeleted: number;
  /** Set when the deletion pass was deliberately skipped; see `markDeleted`. */
  deletionPassSkipped?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient | { from: (t: string) => any; rpc: (fn: string) => any };

/**
 * Flag mirror rows this run did not touch.
 *
 * `/catalog/list` returns live objects only, so a row whose `synced_at` predates
 * `runStartedAt` is absent from Square. It is flagged, never deleted: a mapping
 * still points at it, and that mapping has to stay inspectable until a human
 * re-points it.
 *
 * REFUSES TO RUN ON AN EMPTY FETCH. `squareGetAll` throws on a failed page, so
 * zero items means Square genuinely returned an empty catalog — but the only
 * safe reading of "Square has no items" is that something is wrong upstream, not
 * that every product was deleted. Flagging on that would take out every mapping
 * at once.
 */
export async function markMissingAsDeleted(
  db: Db,
  table: "square_catalog_items" | "square_catalog_variations",
  runStartedAt: string,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from(table)
    .update({ is_deleted: true })
    .lt("synced_at", runStartedAt)
    .eq("is_deleted", false)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

export async function syncSquareCatalog(db: Db): Promise<CatalogSyncResult> {
  const [items, categories, taxes] = await Promise.all([
    fetchCatalogItems(),
    fetchCatalogCategories(),
    fetchCatalogTaxes(),
  ]);

  const categoryMap = new Map(categories.map((c) => [c.id, c.category_data]));
  const taxMap      = new Map(taxes.map((t) => [t.id, t.tax_data]));

  const now = new Date().toISOString();

  // ── Upsert items ───────────────────────────────────────────────────────────
  const itemRows = items.map((item) => {
    const categoryId = item.item_data.reporting_category?.id ?? null;
    const taxIds     = item.item_data.tax_ids ?? [];
    const applicableTaxes = taxIds.flatMap((id) => {
      const t = taxMap.get(id);
      return t ? [{ id, name: t.name, percentage: t.percentage ?? null, inclusion_type: t.inclusion_type ?? null }] : [];
    });

    const catData       = categoryId ? (categoryMap.get(categoryId) ?? null) : null;
    const parentId      = catData?.parent_category?.id ?? null;
    const parentCatData = parentId ? (categoryMap.get(parentId) ?? null) : null;

    return {
      square_item_id:        item.id,
      item_name:             item.item_data.name,
      description:           item.item_data.description ?? null,
      product_type:          item.item_data.product_type ?? null,
      category_id:           categoryId,
      category_name:         catData?.name ?? null,
      parent_category_id:    parentId,
      parent_category_name:  parentCatData?.name ?? null,
      is_top_level_category: catData?.is_top_level ?? null,
      tax_ids:               taxIds.length > 0 ? taxIds : null,
      applicable_taxes:      applicableTaxes.length > 0 ? applicableTaxes : null,
      is_archived:           item.item_data.is_archived ?? false,
      // Square returned it, so it is live. Set explicitly rather than left alone:
      // an object deleted and later recreated under the same id must be revived,
      // not stay flagged forever.
      is_deleted:            false,
      synced_at:             now,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: upsertedItems, error: itemsError } = await (db as any)
    .from("square_catalog_items")
    .upsert(itemRows, { onConflict: "square_item_id" })
    .select("id, square_item_id");
  if (itemsError) throw new Error(itemsError.message);

  const itemIdMap = new Map(
    ((upsertedItems ?? []) as { id: string; square_item_id: string }[]).map((r) => [r.square_item_id, r.id]),
  );

  // ── Upsert variations ──────────────────────────────────────────────────────
  const variationRows = items.flatMap((item) => {
    const catalogItemId = itemIdMap.get(item.id);
    if (!catalogItemId) return [];

    return (item.item_data.variations ?? []).map((v) => {
      const variationName = v.item_variation_data.name;
      return {
        square_variation_id:   v.id,
        catalog_item_id:       catalogItemId,
        square_item_id:        item.id,
        variation_name:        variationName,
        sku:                   v.item_variation_data.sku ?? null,
        upc:                   v.item_variation_data.upc ?? null,
        price_amount:          v.item_variation_data.price_money?.amount ?? null,
        price_currency:        v.item_variation_data.price_money?.currency ?? null,
        pricing_type:          v.item_variation_data.pricing_type ?? null,
        track_inventory:       v.item_variation_data.track_inventory ?? null,
        sellable:              v.item_variation_data.sellable ?? null,
        stockable:             v.item_variation_data.stockable ?? null,
        service_duration_ms:   v.item_variation_data.service_duration ?? null,
        inventory_unit:        inferInventoryUnit(variationName),
        volume_fl_oz_per_unit: volumeFlOzPerUnit(variationName),
        is_deleted:            false,
        synced_at:             now,
      };
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: upsertedVariations, error: varError } = await (db as any)
    .from("square_catalog_variations")
    .upsert(variationRows, { onConflict: "square_variation_id" })
    .select("id");
  if (varError) throw new Error(varError.message);

  // ── Mark what Square no longer returns ─────────────────────────────────────
  const result: CatalogSyncResult = {
    items: (upsertedItems ?? []).length,
    variations: (upsertedVariations ?? []).length,
    itemsMarkedDeleted: 0,
    variationsMarkedDeleted: 0,
  };

  if (items.length === 0) {
    result.deletionPassSkipped = "Square returned an empty catalog; refusing to flag every mirror row";
  } else {
    result.itemsMarkedDeleted      = await markMissingAsDeleted(db, "square_catalog_items", now);
    result.variationsMarkedDeleted = await markMissingAsDeleted(db, "square_catalog_variations", now);
  }

  // Resolve catalog_variation_id on any link that lacks one — including links
  // re-pointed at a variation the mirror had not yet seen.
  // Fire-and-forget; a failed backfill is not worth failing the sync over.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (db as any).rpc("backfill_recipe_link_variation_ids");

  return result;
}
