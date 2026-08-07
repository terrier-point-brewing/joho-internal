import { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { writePhantomExport, type PhantomOrigin } from "@/lib/production/writePhantomExport";
import { applyBreakDown, type AppliedBreak } from "@/lib/production/applyBreakDown";

export interface RecordTaproomConsumptionParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  quantity: number;        // target units to record
  sourceRef: string;       // idempotency key stamped onto the export transactions
  notes?: string | null;
  /**
   * Which Square consumption kind is being recorded. Only reaches the database
   * on a shortfall, where it is stamped onto the phantom row — this function
   * serves draft swaps, keg sales and can sales alike, and the phantom is the
   * one output that cannot be told apart afterwards without it.
   */
  kind: PhantomOrigin;
}

const EPS = 1e-4;

/**
 * Tolerant taproom-channel recorder used by the Square sync. Records as much of
 * the requested `quantity` as cold storage can currently cover via a physical
 * shipment, and books any remaining shortfall as a batch-less phantom export
 * so barrel excise is never silently dropped — cold storage is never depleted
 * below zero. The physical and phantom rows (when both are written) share one
 * `shipment_id` grouping UUID.
 *
 * `available` (and therefore `recordedQty`/`shortfallQty`) can be fractional —
 * they stay numeric with no forced integer rounding.
 */
export async function recordTaproomConsumption(
  supabase: SupabaseClient,
  params: RecordTaproomConsumptionParams,
): Promise<{ recordedQty: number; shortfallQty: number; exportTransactionIds: string[]; breaks: AppliedBreak[]; warnings: string[] }> {
  const { recipeId, variationId, quantity } = params;

  let available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });

  // Short on this tier? Break down higher tiers of the same can identity to top it
  // up (case->pack->single, smallest-first). Only the taproom path breaks; sealed
  // wholesale stock is never auto-cracked. No-op for kegs / no-higher-tier cans.
  let breaks: AppliedBreak[] = [];
  let warnings: string[] = [];
  if (available < quantity - EPS) {
    const bd = await applyBreakDown(supabase, { recipeId, variationId, needed: quantity, sourceRef: params.sourceRef });
    breaks = bd.applied;
    warnings = bd.warnings;
    if (bd.applied.length > 0) {
      available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });
    }
  }

  const recordable = Math.min(quantity, available);
  const shortfall = quantity - recordable;

  const exportTransactionIds: string[] = [];
  let shipmentId = params.shipmentId;

  if (recordable > 0) {
    const result = await writeColdStorageShipment(supabase, {
      shipmentId,
      channel: "taproom",
      recipeId,
      variationId,
      quantity: recordable,
      recipientId: null,
      recipientName: null,
      allocationId: null,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
    });
    shipmentId = result.shipmentId;
    exportTransactionIds.push(...result.exportTransactionIds);
  }

  if (shortfall > EPS) {
    const phantom = await writePhantomExport(supabase, {
      shipmentId,
      recipeId,
      variationId,
      quantityKegs: shortfall,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
      origin: params.kind,
    });
    exportTransactionIds.push(phantom.exportTransactionId);
  }

  return { recordedQty: recordable, shortfallQty: shortfall, exportTransactionIds, breaks, warnings };
}
