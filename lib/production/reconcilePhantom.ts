import { SupabaseClient } from "@supabase/supabase-js";
import { depleteColdStorageInventory } from "./coldStorageDepletion";
import { checkAndCompleteBatch } from "./batchCompletion";
import { swapPerKegFlOz, SWAP_VOLUME_TOLERANCE_FL_OZ } from "./phantomExportAlerts";

/**
 * Actions on an open phantom-export alert (a taproom keg swap that booked
 * barrel excise with no cold-storage stock to deduct).
 *
 * - Reconcile: retroactively perform the cold-storage depletion that never
 *   happened, against one operator-chosen lot (variation + batch) that now has
 *   the stock. Writes NO new export/excise (the phantom row already carries it);
 *   backfills the phantom row's `batch_id`, and — when the chosen keg differs
 *   from what was booked (e.g. a mislinked partner variation resolved against
 *   the real generic keg) — corrects the row's variation label. Only same-size
 *   kegs are accepted, so excise/volume never drift. `is_phantom` stays true —
 *   a permanent origin marker.
 * - Dismiss: acknowledge without depletion, for swaps where there genuinely was
 *   no cold-storage keg to draw down.
 *
 * Validation failures throw `PhantomReconcileError` (the route maps these to
 * HTTP 400); unexpected DB errors throw plain `Error` (mapped to 500).
 */
export class PhantomReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhantomReconcileError";
  }
}

interface PhantomRow {
  id: string;
  recipe_id: string;
  packaging_item_id: string;
  packaging_format: string | null;
  quantity: number;
  volume_bbl: number;
  is_phantom: boolean;
  alert_acknowledged_at: string | null;
}

/** Load an open (phantom, unacknowledged) export row or throw a 400-worthy error. */
async function loadOpenPhantom(supabase: SupabaseClient, exportTransactionId: string): Promise<PhantomRow> {
  const { data, error } = await supabase
    .from("export_transactions")
    .select("id, recipe_id, packaging_item_id, packaging_format, quantity, volume_bbl, is_phantom, alert_acknowledged_at")
    .eq("id", exportTransactionId);
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as unknown as PhantomRow[])[0];
  if (!row) throw new PhantomReconcileError("Export transaction not found.");
  if (!row.is_phantom) throw new PhantomReconcileError("Export transaction is not a phantom alert.");
  if (row.alert_acknowledged_at) throw new PhantomReconcileError("Alert has already been resolved.");
  return row;
}

interface ChosenVariationRow {
  id: string;
  name: string;
  container_id: string;
  format: string | null;
  total_volume_fl_oz: number | null;
  container: { type: string } | null;
}

export async function reconcilePhantomExport(
  supabase: SupabaseClient,
  { exportTransactionId, variationId, batchId }: { exportTransactionId: string; variationId: string; batchId: string },
): Promise<void> {
  const row = await loadOpenPhantom(supabase, exportTransactionId);

  // Load the operator-chosen variation (the keg they actually drained).
  const { data: pvData, error: pvErr } = await supabase
    .from("packaging_variations")
    .select(
      "id, name, container_id, format, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(type)",
    )
    .eq("id", variationId);
  if (pvErr) throw new Error(pvErr.message);
  const variation = ((pvData ?? []) as unknown as ChosenVariationRow[])[0];
  if (!variation) throw new PhantomReconcileError("Selected packaging variation not found.");
  if (variation.container?.type !== "keg") throw new PhantomReconcileError("Selected variation is not a keg.");

  // Same-size guard: excise/volume were booked for this keg size and are never
  // recomputed, so only a same-volume keg may resolve the alert.
  const perKeg = swapPerKegFlOz(row.volume_bbl, row.quantity);
  if (
    variation.total_volume_fl_oz == null ||
    Math.abs(Number(variation.total_volume_fl_oz) - perKeg) > SWAP_VOLUME_TOLERANCE_FL_OZ
  ) {
    throw new PhantomReconcileError("Selected keg is a different size than the booked swap.");
  }

  // The chosen lot must hold enough of this recipe/variation/batch to cover the
  // full swap — targeted depletion never takes a batch below zero.
  const { data: lots, error: lotErr } = await supabase
    .from("cold_storage_inventory")
    .select("quantity_on_hand")
    .eq("recipe_id", row.recipe_id)
    .eq("variation_id", variationId)
    .eq("batch_id", batchId);
  if (lotErr) throw new Error(lotErr.message);
  const onHand = ((lots ?? []) as { quantity_on_hand: number }[]).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
  if (onHand < row.quantity) {
    throw new PhantomReconcileError(`Selected batch has ${onHand} on hand but the swap needs ${row.quantity}.`);
  }

  await depleteColdStorageInventory(supabase, {
    recipeId: row.recipe_id,
    variationId,
    quantity: row.quantity,
    batchId,
  });

  // Backfill the batch + acknowledge; correct the record's variation when the
  // chosen keg differs from what was booked (e.g. a mislinked partner variation
  // resolved against the real generic keg). Excise/volume stay as booked.
  const variationChanged =
    variation.container_id !== row.packaging_item_id ||
    (variation.format ?? null) !== (row.packaging_format ?? null);
  const update: Record<string, unknown> = {
    batch_id: batchId,
    alert_acknowledged_at: new Date().toISOString(),
  };
  if (variationChanged) {
    update.packaging_item_id = variation.container_id;
    update.packaging_format = variation.format;
    update.variant_label = variation.name;
  }
  const { error: updErr } = await supabase.from("export_transactions").update(update).eq("id", exportTransactionId);
  if (updErr) throw new Error(updErr.message);

  await checkAndCompleteBatch(supabase, batchId);
}

export async function dismissPhantomExport(
  supabase: SupabaseClient,
  { exportTransactionId }: { exportTransactionId: string },
): Promise<void> {
  const row = await loadOpenPhantom(supabase, exportTransactionId);
  const { error } = await supabase
    .from("export_transactions")
    .update({ alert_acknowledged_at: new Date().toISOString() })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
}
