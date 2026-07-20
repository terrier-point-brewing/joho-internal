import { SupabaseClient } from "@supabase/supabase-js";
import { depleteColdStorageInventory } from "./coldStorageDepletion";
import { checkAndCompleteBatch } from "./batchCompletion";
import { resolveSwapVariationId } from "./phantomExportAlerts";

/**
 * Actions on an open phantom-export alert (a taproom keg swap that booked
 * barrel excise with no cold-storage stock to deduct).
 *
 * - Reconcile: retroactively perform the cold-storage depletion that never
 *   happened, against one operator-chosen batch that now has the stock. Writes
 *   NO new export/excise (the phantom row already carries it); backfills the
 *   phantom row's `batch_id` to the reconciling batch and acknowledges the
 *   alert. `is_phantom` stays true — a permanent origin marker.
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
  is_phantom: boolean;
  alert_acknowledged_at: string | null;
}

/** Load an open (phantom, unacknowledged) export row or throw a 400-worthy error. */
async function loadOpenPhantom(supabase: SupabaseClient, exportTransactionId: string): Promise<PhantomRow> {
  const { data, error } = await supabase
    .from("export_transactions")
    .select("id, recipe_id, packaging_item_id, packaging_format, quantity, is_phantom, alert_acknowledged_at")
    .eq("id", exportTransactionId);
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as unknown as PhantomRow[])[0];
  if (!row) throw new PhantomReconcileError("Export transaction not found.");
  if (!row.is_phantom) throw new PhantomReconcileError("Export transaction is not a phantom alert.");
  if (row.alert_acknowledged_at) throw new PhantomReconcileError("Alert has already been resolved.");
  return row;
}

export async function reconcilePhantomExport(
  supabase: SupabaseClient,
  { exportTransactionId, batchId }: { exportTransactionId: string; batchId: string },
): Promise<void> {
  const row = await loadOpenPhantom(supabase, exportTransactionId);

  const variationId = await resolveSwapVariationId(supabase, {
    recipeId: row.recipe_id,
    containerId: row.packaging_item_id,
    format: row.packaging_format,
  });
  if (!variationId) throw new PhantomReconcileError("Could not resolve the swap variation for this export.");

  // The chosen batch must hold enough of this recipe/variation on hand to cover
  // the full swap — targeted depletion never takes a batch below zero.
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

  const { error: updErr } = await supabase
    .from("export_transactions")
    .update({ batch_id: batchId, alert_acknowledged_at: new Date().toISOString() })
    .eq("id", exportTransactionId);
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
