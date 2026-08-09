import { SupabaseClient } from "@supabase/supabase-js";
import { depleteColdStorageInventory } from "./coldStorageDepletion";
import { checkAndCompleteBatch } from "./batchCompletion";
import {
  fetchLotOptions,
  phantomPerUnitFlOz,
  resolveSwapVariationId,
  SWAP_VOLUME_TOLERANCE_FL_OZ,
} from "./phantomExportAlerts";

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

/** Container type the phantom row was booked against, or null if unreadable. */
async function fetchBookedContainerType(
  supabase: SupabaseClient,
  packagingItemId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("packaging_items")
    .select("type")
    .eq("id", packagingItemId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { type: string | null }[];
  return rows[0]?.type ?? null;
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

  // Same-container-type guard. This used to insist on a keg, which made a can
  // sale that outran cold storage unresolvable even against the exact matching
  // cans. The rule was never really "must be a keg" — it is "must be the same
  // kind of thing the row was booked against".
  const bookedType = await fetchBookedContainerType(supabase, row.packaging_item_id);
  if (!bookedType || variation.container?.type !== bookedType) {
    throw new PhantomReconcileError(
      `Selected variation is a ${variation.container?.type ?? "unknown"} but the booking was a ${bookedType ?? "unknown"}.`,
    );
  }

  // Same-size guard: excise/volume were booked for this unit size and are never
  // recomputed, so only a same-volume unit may resolve the alert. A near miss is
  // resolved by putting the right stock in cold storage first, never by relaxing
  // this — the booked excise has to stay true to what left.
  const perUnit = phantomPerUnitFlOz(row.volume_bbl, row.quantity);
  if (
    variation.total_volume_fl_oz == null ||
    Math.abs(Number(variation.total_volume_fl_oz) - perUnit) > SWAP_VOLUME_TOLERANCE_FL_OZ
  ) {
    throw new PhantomReconcileError("Selected stock is a different size than what was booked.");
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

/**
 * Reshape a wrong-shape cold-storage lot into the variation the alert was
 * booked against — break the case of cans into the cans that were rung — so the
 * unchanged reconcile path above can then find an exact match.
 *
 * The caller passes only the LOT to spend. The counts are re-derived here from
 * the alert and the lot's own stored volumes, never taken from the request:
 * from/to unit counts are how much beer gets destroyed, and a client that could
 * name them could turn a case into one can and journal the rest as shrinkage.
 *
 * This is a second, more privileged act stapled to a reconcile, not part of it —
 * the route demands `export: operate` on top of the reconcile's own permission
 * before calling here. Returns the lot to reconcile against, plus the recipe so
 * the route can restate Square exactly as the standalone transform route does.
 */
export async function transformForPhantomExport(
  supabase: SupabaseClient,
  { exportTransactionId, lotId }: { exportTransactionId: string; lotId: string },
): Promise<{ variationId: string; batchId: string; recipeId: string }> {
  const row = await loadOpenPhantom(supabase, exportTransactionId);
  const containerType = await fetchBookedContainerType(supabase, row.packaging_item_id);
  const variationId = await resolveSwapVariationId(supabase, {
    recipeId: row.recipe_id,
    containerId: row.packaging_item_id,
    format: row.packaging_format,
  });

  const { transforms } = await fetchLotOptions(supabase, {
    exportTransactionId: row.id,
    recipeId: row.recipe_id,
    beerName: "",
    origin: null,
    tapNumber: null,
    variationId,
    variationName: "",
    containerType,
    quantityKegs: row.quantity,
    volumeBbl: row.volume_bbl,
    exciseUsd: 0,
    occurredAt: "",
  });

  const plan = transforms.find((t) => t.lotId === lotId);
  if (!plan) {
    throw new PhantomReconcileError("That lot can no longer be broken down to cover this booking.");
  }

  const { error } = await supabase.rpc("apply_cold_storage_transform", {
    p_lot_id: plan.lotId,
    p_to_variation_id: plan.toVariationId,
    p_from_units: plan.fromUnits,
    p_to_units: plan.toUnits,
    p_note: `Break down to resolve phantom export ${row.id}`,
    p_source_ref: null,
  });
  if (error) {
    if (error.code === "P0002") throw new PhantomReconcileError("That cold storage lot no longer exists.");
    if (error.code === "23514" || error.code === "22023") throw new PhantomReconcileError(error.message);
    throw new Error(error.message);
  }

  return { variationId: plan.toVariationId, batchId: plan.batchId, recipeId: row.recipe_id };
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
