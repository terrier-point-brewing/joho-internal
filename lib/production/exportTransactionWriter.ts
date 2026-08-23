import { SupabaseClient } from "@supabase/supabase-js";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";

export type ExportTransactionStatus = "invoice_required" | "unpaid" | "paid";

/**
 * The initial invoice-lifecycle status for a freshly written export row.
 *
 * Taproom consumption is internal — payment is already collected at the
 * point of sale, so those rows are terminal ('paid') and never enter the
 * invoicing workflow. Every partner channel (distribution / wholesale /
 * contract_brewing) still starts at 'invoice_required'.
 */
export function initialExportStatus(channel: string): ExportTransactionStatus {
  return channel === "taproom" ? "paid" : "invoice_required";
}

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
    batchId: string | null;
    recipeId: string;
    packagingItemId: string;
    /** The packaging variation shipped — the authoritative link, resolved by id downstream. */
    variationId: string | null;
    /** The variation's name at ship time. Display only; readers must not key on it. */
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
    overAllocation?: boolean;
    sourceRef?: string | null;
    isPhantom?: boolean;
    /**
     * Which consumption kind booked a phantom row (see writePhantomExport).
     * Only meaningful alongside `isPhantom`; null on every regular shipment.
     */
    phantomOrigin?: "draft_swap" | "keg_sale" | "can_sale" | null;
    /**
     * Canning packaging loss % inherited from the run that filled these cans, so
     * a Packaging Materials invoice line bills the same container/lid/label
     * quantity that was physically consumed. 0 for kegs and for runs with no loss.
     */
    packagingLossPct?: number;
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
      variation_id: params.variationId,
      variant_label: params.variantLabel,
      quantity: params.quantity,
      packaging_format: params.packagingFormat,
      units_per_package: params.unitsPerPackage,
      volume_bbl: Math.round(params.volumeBbl * 10000) / 10000,
      channel: params.channel,
      status: initialExportStatus(params.channel),
      recipient_id: params.recipientId,
      recipient_name: params.recipientName,
      total_excise_tax_usd: totalExciseTaxUsd,
      source_transfer_id: null,
      source_ref: params.sourceRef ?? null,
      notes: params.notes ?? null,
      over_allocation: params.overAllocation ?? false,
      is_phantom: params.isPhantom ?? false,
      phantom_origin: params.phantomOrigin ?? null,
      packaging_loss_pct: params.packagingLossPct ?? 0,
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
