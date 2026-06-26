import { SupabaseClient } from "@supabase/supabase-js";

interface ColdStorageKey {
  recipeId: string;
  variationId: string;
}

/**
 * Sums quantity_on_hand across every cold_storage_inventory row matching
 * the given recipe/variation — the Export Bay's "how much can I ship" check.
 * Callers reject the request themselves (this returns the raw number, not
 * a NextResponse) so both the regular Ship route and the ad-hoc route can
 * phrase their own "requested X, available Y" message.
 */
export async function getAvailableColdStorageQuantity(
  supabase: SupabaseClient,
  { recipeId, variationId }: ColdStorageKey
): Promise<number> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("quantity_on_hand")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
}

/**
 * Depletes cold_storage_inventory oldest-row-first for the given
 * recipe/variation, up to `quantity` units total. Deletes a row once it
 * hits ~0, otherwise decrements it. Returns one entry per row touched —
 * since (batch_id, variation_id) is unique, each entry already belongs to
 * exactly one batch and needs no further aggregation by the caller.
 *
 * Caller must have already verified `quantity` does not exceed the total
 * available (via getAvailableColdStorageQuantity) — this function does not
 * re-check and will simply deplete everything it finds if asked for more.
 */
export async function depleteColdStorageInventory(
  supabase: SupabaseClient,
  { recipeId, variationId, quantity }: ColdStorageKey & { quantity: number }
): Promise<{ batchId: string; depletedQty: number }[]> {
  const { data: rows, error } = await supabase
    .from("cold_storage_inventory")
    .select("id, batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const depleted: { batchId: string; depletedQty: number }[] = [];
  let qtyLeft = quantity;
  for (const row of rows ?? []) {
    if (qtyLeft <= 0) break;
    const take = Math.min(Number(row.quantity_on_hand), qtyLeft);
    const newQty = Number(row.quantity_on_hand) - take;
    if (newQty <= 0.0001) {
      await supabase.from("cold_storage_inventory").delete().eq("id", row.id);
    } else {
      await supabase.from("cold_storage_inventory").update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    depleted.push({ batchId: row.batch_id, depletedQty: take });
    qtyLeft -= take;
  }
  return depleted;
}
