import { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { applyBreakDown, type AppliedBreak } from "@/lib/production/applyBreakDown";

export interface RecordTaproomConsumptionParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  quantity: number;        // target units to record
  sourceRef: string;       // idempotency key stamped onto the export transactions
  notes?: string | null;
}

const EPS = 1e-4;

/**
 * Tolerant taproom-channel recorder used by the Square sync. Records as much of
 * the requested `quantity` as cold storage can currently cover and flags the
 * rest as a shortfall — never depleting below zero. When nothing is available,
 * it writes nothing at all (not even an empty shipment), leaving the sourceRef
 * unstamped so a later sync retries once stock exists.
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

  if (recordable <= 0) {
    return { recordedQty: 0, shortfallQty: shortfall, exportTransactionIds: [], breaks, warnings };
  }

  const result = await writeColdStorageShipment(supabase, {
    shipmentId: params.shipmentId,
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

  return { recordedQty: recordable, shortfallQty: shortfall, exportTransactionIds: result.exportTransactionIds, breaks, warnings };
}
