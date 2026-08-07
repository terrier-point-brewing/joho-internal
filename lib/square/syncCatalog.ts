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

/**
 * An existing variation whose CURRENT Square name implies a different fl oz than
 * the mirror stores. Reported, never applied — see `syncSquareCatalog`.
 */
export interface VolumeMismatch {
  squareVariationId: string;
  variationName: string;
  stored: number | null;
  impliedByName: number | null;
}

export interface CatalogSyncResult {
  items: number;
  variations: number;
  /** Variations the mirror had never seen. These get their derived volume. */
  variationsInserted: number;
  /** Variations already mirrored. Their derived volume is left alone. */
  variationsUpdated: number;
  itemsMarkedDeleted: number;
  variationsMarkedDeleted: number;
  /** Set when the deletion pass was deliberately skipped; see `markDeleted`. */
  deletionPassSkipped?: string;
  /** Renames that would have moved a stored volume. Reported for a human. */
  volumeMismatches: VolumeMismatch[];
  /** Set when the link FK backfill failed. Non-fatal, but never silent. */
  linkBackfillError?: string;
}

export interface CatalogSyncOptions {
  /**
   * Restrict the sync to these Square item ids. Used when a link is created
   * against an item the mirror has never seen, so the backend can resolve it
   * immediately instead of waiting for a full sync.
   *
   * The deletion pass is SKIPPED whenever this is set: it flags every mirror row
   * a run did not touch, and a run that deliberately touched one item would
   * otherwise bury the entire catalog.
   */
  onlyItemIds?: string[];
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
interface StoredDerived {
  volume_fl_oz_per_unit: number | null;
  inventory_unit: string | null;
}

/**
 * Read the derived columns already stored for these variations, so a sync can
 * tell a first sighting from a refresh and carry the stored values through
 * untouched. Chunked to stay well under PostgREST's URL length limit.
 */
async function fetchExistingDerived(db: Db, squareVariationIds: string[]): Promise<Map<string, StoredDerived>> {
  const byId = new Map<string, StoredDerived>();
  for (let i = 0; i < squareVariationIds.length; i += 200) {
    const chunk = squareVariationIds.slice(i, i + 200);
    if (chunk.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("square_catalog_variations")
      .select("square_variation_id, volume_fl_oz_per_unit, inventory_unit")
      .in("square_variation_id", chunk);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as ({ square_variation_id: string } & StoredDerived)[]) {
      byId.set(r.square_variation_id, {
        volume_fl_oz_per_unit: r.volume_fl_oz_per_unit,
        inventory_unit: r.inventory_unit,
      });
    }
  }
  return byId;
}

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

/**
 * Mirror Square's catalog into square_catalog_items / square_catalog_variations.
 *
 * DERIVED VOLUMES ARE FORWARD-ONLY. `volume_fl_oz_per_unit` and `inventory_unit`
 * are not Square fields — they are parsed from the variation NAME. Sell-through
 * and the pour sums read that column against HISTORICAL sales, so overwriting it
 * silently restates past numbers: rename "Draft - 16oz" to "Draft - 12oz" in
 * Square and every pour ever recorded against it is suddenly re-measured. This
 * function therefore derives those columns when it first inserts a variation
 * (forward-looking by definition) and never touches them again. A name that now
 * implies a different volume comes back in `volumeMismatches` for a human to act
 * on. Making a genuinely changed pour size correct going forward without
 * corrupting the past needs the volume to be effective-dated, which is its own
 * piece of work.
 *
 * Everything else Square owns — names, prices, sku/upc, the inventory flags — is
 * refreshed normally.
 */
export async function syncSquareCatalog(
  db: Db,
  opts: CatalogSyncOptions = {},
): Promise<CatalogSyncResult> {
  const [allItems, categories, taxes] = await Promise.all([
    fetchCatalogItems(),
    fetchCatalogCategories(),
    fetchCatalogTaxes(),
  ]);

  const scoped = opts.onlyItemIds ? new Set(opts.onlyItemIds) : null;
  const items = scoped ? allItems.filter((i) => scoped.has(i.id)) : allItems;

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

  // Split new from already-mirrored. A new variation is written whole, derived
  // volume included. An existing one is refreshed on Square's own fields only —
  // its derived volume is history's measuring stick and stays put.
  const existingByVarId = await fetchExistingDerived(db, variationRows.map((r) => r.square_variation_id));

  const insertRows = variationRows.filter((r) => !existingByVarId.has(r.square_variation_id));
  const updateRows = variationRows
    .filter((r) => existingByVarId.has(r.square_variation_id))
    .map((r) => {
      const prior = existingByVarId.get(r.square_variation_id)!;
      // The stored values are carried through verbatim rather than omitted, so
      // this stays a plain upsert: if the row were deleted between the read and
      // this write, the insert branch writes back exactly what was there.
      return { ...r, volume_fl_oz_per_unit: prior.volume_fl_oz_per_unit, inventory_unit: prior.inventory_unit };
    });

  const volumeMismatches: VolumeMismatch[] = [];
  for (const r of variationRows) {
    const prior = existingByVarId.get(r.square_variation_id);
    if (!prior) continue;
    const implied = r.volume_fl_oz_per_unit;
    const stored = prior.volume_fl_oz_per_unit;
    if (implied != null && stored != null && Number(implied) !== Number(stored)) {
      volumeMismatches.push({
        squareVariationId: r.square_variation_id,
        variationName:     r.variation_name ?? "",
        stored:            Number(stored),
        impliedByName:     Number(implied),
      });
    }
  }

  let variationsWritten = 0;
  for (const [rows, label] of [[insertRows, "insert"], [updateRows, "update"]] as const) {
    if (rows.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("square_catalog_variations")
      .upsert(rows, { onConflict: "square_variation_id" })
      .select("id");
    if (error) throw new Error(`${label} variations: ${error.message}`);
    variationsWritten += (data ?? []).length;
  }
  const upsertedVariations = { length: variationsWritten };

  // ── Mark what Square no longer returns ─────────────────────────────────────
  const result: CatalogSyncResult = {
    items: (upsertedItems ?? []).length,
    variations: upsertedVariations.length,
    variationsInserted: insertRows.length,
    variationsUpdated: updateRows.length,
    itemsMarkedDeleted: 0,
    variationsMarkedDeleted: 0,
    volumeMismatches,
  };

  if (scoped) {
    // A scoped run touched one item on purpose. markMissingAsDeleted flags every
    // row it did not touch, which here would be the entire rest of the catalog.
    result.deletionPassSkipped = "Scoped to specific items; the deletion pass only makes sense on a full run";
  } else if (items.length === 0) {
    result.deletionPassSkipped = "Square returned an empty catalog; refusing to flag every mirror row";
  } else {
    result.itemsMarkedDeleted      = await markMissingAsDeleted(db, "square_catalog_items", now);
    result.variationsMarkedDeleted = await markMissingAsDeleted(db, "square_catalog_variations", now);
  }

  // Resolve catalog_variation_id on any link that lacks one — including links
  // re-pointed at a variation the mirror had not yet seen.
  //
  // AWAITED, not fired and forgotten. A supabase-js builder is lazy: the request
  // is only sent when something calls `then`, so the previous `void db.rpc(...)`
  // never issued it at all. The backfill had therefore never run from a sync,
  // and 42 of 115 links sat with a null catalog_variation_id while every one of
  // them was resolvable. Still non-fatal — a failed backfill is not worth losing
  // the sync over — but now it fails loudly instead of silently not happening.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).rpc("backfill_recipe_link_variation_ids");
    if (error) throw new Error(error.message);
  } catch (e) {
    result.linkBackfillError = e instanceof Error ? e.message : String(e);
  }

  return result;
}
