import { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";

/**
 * Inserts an export_transactions row plus its export_transaction_taxes children.
 *
 * batchId identifies which batch allocation is being fulfilled — it is NOT a
 * cold-storage depletion pointer. Cold storage is depleted separately via
 * depleteColdStorageInventory (by recipe + variation, oldest-first) and the
 * two operations are intentionally independent.
 *
 * allocationId is explicit (not inferred from batchId) because the regular
 * Ship flow passes the credited allocation's id while ad-hoc exports pass
 * null — there is no allocation to credit.
 */
export async function writeExportTransaction(
  supabase: SupabaseClient,
  params: {
    shipmentId: string;
    batchId: string;
    recipeId: string;
    packagingItemId: string;
    variantLabel: string;
    quantity: number;
    volumeBbl: number;
    channel: string;
    recipientId: string | null;
    recipientName: string | null;
    allocationId: string | null;
    notes?: string | null;
    packagingFormat: string;
    unitsPerPackage: number;
    sourceRef?: string | null;
  }
): Promise<string> {
  const taxBreakdown = await computeExciseTaxBreakdown(supabase, params.volumeBbl);
  const totalExciseTaxUsd = Math.round(taxBreakdown.reduce((s, t) => s + t.amountUsd, 0) * 100) / 100;

  const { data: exportTx, error: exTxErr } = await supabase
    .from("export_transactions")
    .insert({
      shipment_id: params.shipmentId,
      batch_id: params.batchId,
      recipe_id: params.recipeId,
      allocation_id: params.allocationId,
      packaging_item_id: params.packagingItemId,
      variant_label: params.variantLabel,
      quantity: params.quantity,
      packaging_format: params.packagingFormat,
      units_per_package: params.unitsPerPackage,
      volume_bbl: Math.round(params.volumeBbl * 10000) / 10000,
      channel: params.channel,
      recipient_id: params.recipientId,
      recipient_name: params.recipientName,
      total_excise_tax_usd: totalExciseTaxUsd,
      source_transfer_id: null,
      source_ref: params.sourceRef ?? null,
      notes: params.notes ?? null,
    })
    .select("id")
    .single();
  if (exTxErr) throw new Error(exTxErr.message);

  if (taxBreakdown.length > 0) {
    const { error: taxErr } = await supabase.from("export_transaction_taxes").insert(
      taxBreakdown.map((t) => ({
        export_transaction_id: exportTx.id,
        excise_tax_rate_id: t.rateId,
        tax_name: t.name,
        unit: t.unit,
        rate_usd: t.rateUsd,
        amount_usd: t.amountUsd,
      }))
    );
    if (taxErr) throw new Error(taxErr.message);
  }

  return exportTx.id;
}
