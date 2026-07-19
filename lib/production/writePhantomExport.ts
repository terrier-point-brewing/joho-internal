import { SupabaseClient } from "@supabase/supabase-js";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export interface WritePhantomExportParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  quantityKegs: number;
  sourceRef: string;
  notes?: string | null;
}

export interface WritePhantomExportResult {
  exportTransactionId: string;
  shipmentId: string;
}

/**
 * Writes a batch-less "phantom" export_transactions row so a taproom
 * draft-restock keg swap always books barrel excise even when cold storage
 * has no matching batch on hand to physically deplete.
 *
 * Unlike writeColdStorageShipment, this NEVER touches cold_storage_inventory
 * — there is no physical stock movement to record, only the tax liability.
 *
 * `shipmentId` mirrors writeColdStorageShipment: it is purely a grouping UUID
 * stamped on export_transactions.shipment_id (there is no dedicated
 * `shipments` table). Pass one to append this phantom row to an existing
 * shipment; omit it to start a new one.
 */
export async function writePhantomExport(
  supabase: SupabaseClient,
  params: WritePhantomExportParams,
): Promise<WritePhantomExportResult> {
  const shipmentId = params.shipmentId ?? crypto.randomUUID();

  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name, format, tray_id, paktech_id")
    .eq("id", params.variationId)
    .single();
  if (varErr) throw new Error(varErr.message);
  if (!variation) throw new Error("Variation not found.");

  const unitsPerPackage = await getUnitsPerPackage(supabase, {
    format: variation.format,
    tray_id: variation.tray_id,
    paktech_id: variation.paktech_id,
  });
  const volumeBbl = (params.quantityKegs * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;

  const exportTransactionId = await writeExportTransaction(supabase, {
    shipmentId,
    batchId: null,
    isPhantom: true,
    recipeId: params.recipeId,
    packagingItemId: variation.container_id,
    variantLabel: variation.name,
    quantity: params.quantityKegs,
    volumeBbl,
    channel: "taproom",
    recipientId: null,
    recipientName: null,
    allocationId: null,
    notes: params.notes ?? null,
    packagingFormat: variation.format,
    unitsPerPackage,
    sourceRef: params.sourceRef,
  });

  return { exportTransactionId, shipmentId };
}
