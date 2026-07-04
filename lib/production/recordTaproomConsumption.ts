import { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";

export interface RecordTaproomConsumptionParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  quantity: number;        // target units to record
  sourceRef: string;       // idempotency key stamped onto the export transactions
  notes?: string | null;
}

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
  params: RecordTaproomConsumptionParams
): Promise<{ recordedQty: number; shortfallQty: number; exportTransactionIds: string[] }> {
  const { recipeId, variationId, quantity } = params;

  const available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });
  const recordable = Math.min(quantity, available);
  const shortfall = quantity - recordable;

  if (recordable <= 0) {
    return { recordedQty: 0, shortfallQty: shortfall, exportTransactionIds: [] };
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

  return {
    recordedQty: recordable,
    shortfallQty: shortfall,
    exportTransactionIds: result.exportTransactionIds,
  };
}
