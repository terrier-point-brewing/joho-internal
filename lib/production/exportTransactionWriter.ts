import { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";

/**
 * Inserts the batch_transfers row representing one batch's contribution to
 * a shipment (from null — leaving the source tank, since cold storage
 * inventory isn't tank-tracked — to the export_bay equipment row).
 */
export async function writeExportTransfer(
  supabase: SupabaseClient,
  { batchId, exportBayId, volumeBbl, notes }: { batchId: string; exportBayId: string; volumeBbl: number; notes?: string | null }
): Promise<string> {
  const { data, error } = await supabase
    .from("batch_transfers")
    .insert({
      batch_id: batchId,
      from_tank_id: null,
      to_tank_id: exportBayId,
      volume_bbl: Math.round(volumeBbl * 10000) / 10000,
      shrinkage_bbl: 0,
      transfer_type: "export",
      notes: notes ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

/**
 * Computes the excise tax breakdown for one credited slice and inserts the
 * export_transactions row plus its export_transaction_taxes children.
 * allocationId is an explicit parameter (not inferred) because the regular
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
    sourceTransferId: string;
    notes?: string | null;
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
      volume_bbl: Math.round(params.volumeBbl * 10000) / 10000,
      channel: params.channel,
      recipient_id: params.recipientId,
      recipient_name: params.recipientName,
      total_excise_tax_usd: totalExciseTaxUsd,
      source_transfer_id: params.sourceTransferId,
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
