// lib/production/coldStorageUpsert.ts
//
// Booking finished goods into the cold room. One function, because there is
// exactly one right answer to "which lot does this beer join?" and the packaging
// route and the refund-restock path must not drift apart on it.
//
// IDENTITY IS BATCH + VARIATION + RECIPE. Batch + variation used to be enough,
// because one batch was one beer. An in-keg conversion breaks that: the same
// batch can fill 1/6 kegs of Carolina Mule and 1/6 kegs of Transfusion Pilsner
// on the same day, and merging them would put half the cellar under the wrong
// beer. `cold_storage_inventory_batch_variation_recipe_idx` is the database's
// statement of the same rule; the two must agree.
//
// NOTHING HERE IS BEST-EFFORT. A packaging deduction that fails costs the
// brewery an inaccurate count of lids. A cold-storage write that fails means
// the beer does not exist: it cannot be shipped, it is not on the excise
// record, and nobody finds out until somebody walks the cold room with a
// clipboard. That happened on 2026-08-31 — B-057 kegged 3 x 1/6 Keg of
// Transfusion Pilsner, the insert hit a stale unique index, and the error went
// to console.error inside a catch that also covered the lid count. The run
// reported success. So every error this function can see, it raises.

import { SupabaseClient } from "@supabase/supabase-js";

export interface ColdStorageUpsertArgs {
  batchId: string;
  /** The beer that came out of the filler — NOT necessarily the batch's own. */
  recipeId: string | null;
  variationId: string;
  /** Units to add. Negative draws down; callers that mean "no-op" pass 0. */
  quantityDelta: number;
  /** The packaging run that produced these units, when there is one. */
  sourceTransferId?: string | null;
}

/**
 * Add `quantityDelta` units to the batch + variation + recipe lot, creating it
 * if this is the first time that beer arrived in that container.
 *
 * Throws on any database error, including the lookup: a `.maybeSingle()` that
 * matches more than one row is itself a signal that the lot grain is broken,
 * and treating it as "no existing row" would quietly write a duplicate.
 */
export async function upsertColdStorageInventory(
  supabase: SupabaseClient,
  args: ColdStorageUpsertArgs,
): Promise<void> {
  const { batchId, recipeId, variationId, quantityDelta, sourceTransferId } = args;
  if (quantityDelta === 0) return;

  let lookup = supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batchId)
    .eq("variation_id", variationId);
  lookup = recipeId ? lookup.eq("recipe_id", recipeId) : lookup.is("recipe_id", null);

  const { data: existing, error: lookupError } = await lookup.maybeSingle();
  if (lookupError) {
    throw new Error(`Could not read the cold-storage lot for this beer: ${lookupError.message}`);
  }

  if (existing) {
    const patch: Record<string, unknown> = {
      quantity_on_hand: Number(existing.quantity_on_hand) + quantityDelta,
    };
    // Only stamp provenance when this call has some. A refund restock joining an
    // existing lot must not overwrite the packaging run that created it.
    if (sourceTransferId) patch.source_transfer_id = sourceTransferId;

    const { error } = await supabase
      .from("cold_storage_inventory")
      .update(patch)
      .eq("id", existing.id);
    if (error) {
      throw new Error(`Could not add ${quantityDelta} unit(s) to the cold-storage lot: ${error.message}`);
    }
    return;
  }

  const { error } = await supabase.from("cold_storage_inventory").insert({
    batch_id: batchId,
    recipe_id: recipeId,
    variation_id: variationId,
    quantity_on_hand: quantityDelta,
    source_transfer_id: sourceTransferId ?? null,
  });
  if (error) {
    throw new Error(`Could not create the cold-storage lot for this beer: ${error.message}`);
  }
}
