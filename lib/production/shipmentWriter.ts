import { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export interface WriteColdStorageShipmentParams {
  shipmentId?: string;                 // default crypto.randomUUID()
  channel: string;                     // 'taproom' | 'distribution' | 'contract_brewing' | 'wholesale'
  recipeId: string;
  variationId: string;
  quantity: number;                    // caller GUARANTEES quantity <= available on hand
  recipientId?: string | null;
  recipientName?: string | null;
  allocationId?: string | null;
  sourceRef?: string | null;
  notes?: string | null;
}

/**
 * Shared cold-storage shipment writer: depletes cold_storage_inventory for the
 * given recipe/variation (oldest-first) and writes one export_transaction per
 * depleted batch row, completing each batch that becomes exhausted.
 *
 * The caller GUARANTEES `quantity` does not exceed the quantity on hand —
 * depleteColdStorageInventory does not re-check availability. Both the ad-hoc
 * and allocation-crediting Ship routes delegate here.
 *
 * The returned `exportTransactionIds` are index-aligned with `depleted`: entry
 * `i` in each array comes from the same depleted-row loop iteration.
 */
export async function writeColdStorageShipment(
  supabase: SupabaseClient,
  params: WriteColdStorageShipmentParams
): Promise<{ shipmentId: string; exportTransactionIds: string[]; depleted: { batchId: string; depletedQty: number }[] }> {
  const {
    channel,
    recipeId,
    variationId,
    quantity,
    recipientId = null,
    recipientName = null,
    allocationId = null,
    sourceRef = null,
    notes = null,
  } = params;
  const shipmentId = params.shipmentId ?? crypto.randomUUID();

  // ── Resolve variation → volume + display name + container item id ─────────
  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name, format, tray_id, paktech_id")
    .eq("id", variationId)
    .single();
  if (varErr) throw new Error(varErr.message);
  if (!variation) throw new Error("Variation not found.");

  const unitsPerPackage = await getUnitsPerPackage(supabase, {
    format: variation.format,
    tray_id: variation.tray_id,
    paktech_id: variation.paktech_id,
  });

  // ── Deplete cold_storage_inventory, oldest row first ──────────────────────
  const depleted = await depleteColdStorageInventory(supabase, {
    recipeId,
    variationId,
    quantity,
  });

  // ── Write one export_transaction per depleted batch row ───────────────────
  const exportTransactionIds: string[] = [];
  for (const { batchId, depletedQty } of depleted) {
    const volumeBbl = (depletedQty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;

    const exportTxId = await writeExportTransaction(supabase, {
      shipmentId,
      batchId,
      recipeId,
      packagingItemId: variation.container_id,
      variantLabel: variation.name,
      quantity: depletedQty,
      volumeBbl,
      channel,
      recipientId: recipientId ?? null,
      recipientName: recipientName ?? null,
      allocationId: allocationId ?? null,
      notes: notes ?? null,
      packagingFormat: variation.format,
      unitsPerPackage,
      sourceRef,
    });

    await checkAndCompleteBatch(supabase, batchId);

    exportTransactionIds.push(exportTxId);
  }

  return { shipmentId, exportTransactionIds, depleted };
}
