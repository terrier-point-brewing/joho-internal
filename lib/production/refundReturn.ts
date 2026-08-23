/**
 * Beer coming back, because a refund said it did.
 *
 * A return is written as a NEGATIVE export transaction mirroring each of the
 * invoice's original ones, plus negative `export_transaction_taxes` children,
 * plus a cold-storage restock into the same batch.
 *
 * Why negative rows rather than editing the originals:
 *
 *  * The excise worksheet reads `export_transactions` by `created_at` and sums
 *    `export_transaction_taxes.amount_usd` (lib/tax/parties/ncDorBeerExcise/calc.ts).
 *    A negative row nets out in the period the beer came BACK, which is what a
 *    return actually is. Editing the original would silently restate a filed
 *    period.
 *  * It matches the house rule that syncs set aside rather than delete: the
 *    original shipment stays exactly as it was shipped, and the reversal is its
 *    own auditable event.
 *
 * The reversed tax is PRO-RATED FROM WHAT WAS CHARGED, never recomputed at
 * today's rates. If the rate moved between the shipment and the return,
 * recomputing would reverse a number the brewery never collected.
 */

import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveShippedVariationId, type ShippedVariationRef } from "@/lib/production/resolveShippedVariation";

export interface RefundReturnResult {
  shipmentId: string;
  exportTransactionIds: string[];
  unitsReturned: number;
  volumeBblReturned: number;
  exciseReversedUsd: number;
  restocked: { batchId: string; quantity: number }[];
  warnings: string[];
}

interface ReturnParams {
  refundId: string;
  invoiceId: string;
  /** Share of the invoice's billed units coming back, 0–1. From the plan. */
  unitFraction: number;
  /** False for never_delivered where the goods never physically moved. */
  restockInventory: boolean;
  /** False on a price correction — the volume never changed. */
  reverseExcise: boolean;
  note?: string | null;
}

/**
 * Put units back into a batch's cold-storage lot, creating the row if the
 * shipment had emptied it. Mirrors upsertColdStorageInventory in the transfers
 * route — the same read-modify-write, kept here so the refund path does not
 * import a route handler.
 */
export async function restockColdStorage(
  supabase: SupabaseClient,
  args: { batchId: string; recipeId: string | null; variationId: string; quantity: number },
): Promise<void> {
  const { batchId, recipeId, variationId, quantity } = args;
  if (quantity <= 0) return;

  const { data: existing } = await supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batchId)
    .eq("variation_id", variationId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("cold_storage_inventory")
      .update({ quantity_on_hand: Number(existing.quantity_on_hand) + quantity })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase
    .from("cold_storage_inventory")
    .insert({ batch_id: batchId, recipe_id: recipeId, variation_id: variationId, quantity_on_hand: quantity });
  if (error) throw new Error(error.message);
}

/**
 * Resolve the packaging variation a shipped export transaction used, so the
 * restock lands on the same cold-storage lot the shipment drained. Same resolver
 * buildProductLines and invoiceLineVolumes use.
 */
async function resolveVariationId(
  supabase: SupabaseClient,
  tx: ShippedVariationRef,
): Promise<string | null> {
  return resolveShippedVariationId(supabase, tx);
}

export async function writeRefundReturn(
  supabase: SupabaseClient,
  params: ReturnParams,
): Promise<RefundReturnResult> {
  const { refundId, invoiceId, unitFraction, restockInventory, reverseExcise, note } = params;

  const result: RefundReturnResult = {
    shipmentId: crypto.randomUUID(),
    exportTransactionIds: [],
    unitsReturned: 0,
    volumeBblReturned: 0,
    exciseReversedUsd: 0,
    restocked: [],
    warnings: [],
  };

  if (unitFraction <= 0) return result;

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select(
      "id, batch_id, recipe_id, allocation_id, packaging_item_id, variation_id, variant_label, quantity, volume_bbl, channel, recipient_id, recipient_name, packaging_format, units_per_package, packaging_loss_pct",
    )
    .eq("invoice_id", invoiceId)
    // Only reverse rows that represent a real outbound movement. A reversal we
    // wrote earlier is already negative and must never be reversed again.
    .gt("quantity", 0);
  if (error) throw new Error(error.message);
  if (!txs || txs.length === 0) {
    result.warnings.push(
      "No shipment is linked to this invoice, so nothing could be returned to cold storage.",
    );
    return result;
  }

  const sourceRef = `refund:${refundId}`;

  // Idempotency: a retry after a partial failure must not double-return.
  const { data: already } = await supabase
    .from("export_transactions")
    .select("id")
    .eq("source_ref", sourceRef);
  if (already && already.length > 0) {
    result.warnings.push("This refund's return was already written; nothing further was done.");
    return result;
  }

  for (const tx of txs) {
    const qty = round4(Number(tx.quantity) * unitFraction);
    const volume = round4(Number(tx.volume_bbl) * unitFraction);
    if (qty <= 0) continue;

    // Reverse the tax that was actually charged on THIS transaction, pro-rated.
    const { data: taxRows } = await supabase
      .from("export_transaction_taxes")
      .select("excise_tax_rate_id, tax_name, unit, rate_usd, amount_usd")
      .eq("export_transaction_id", tx.id);

    const reversedTaxes = reverseExcise
      ? (taxRows ?? []).map((t) => ({
          excise_tax_rate_id: t.excise_tax_rate_id,
          tax_name: t.tax_name,
          unit: t.unit,
          rate_usd: t.rate_usd,
          amount_usd: -round2(Number(t.amount_usd) * unitFraction),
        }))
      : [];
    const totalExciseUsd = round2(reversedTaxes.reduce((s, t) => s + Number(t.amount_usd), 0));

    const { data: inserted, error: insErr } = await supabase
      .from("export_transactions")
      .insert({
        shipment_id: result.shipmentId,
        batch_id: tx.batch_id,
        recipe_id: tx.recipe_id,
        // Deliberately NOT stamped with the original allocation. Releasing
        // allocation credit is a separate decision (see shipmentEdit's G-rules)
        // and a return should not silently hand a partner their entitlement back.
        allocation_id: null,
        packaging_item_id: tx.packaging_item_id,
        variation_id: tx.variation_id,
        variant_label: tx.variant_label,
        quantity: -qty,
        packaging_format: tx.packaging_format,
        units_per_package: tx.units_per_package,
        volume_bbl: -volume,
        channel: tx.channel,
        // Terminal: the money for this movement is already settled by the refund.
        status: "paid",
        recipient_id: tx.recipient_id,
        recipient_name: tx.recipient_name,
        total_excise_tax_usd: totalExciseUsd,
        source_ref: sourceRef,
        notes: note ?? `Return against refund ${refundId}`,
        is_phantom: false,
        packaging_loss_pct: tx.packaging_loss_pct ?? 0,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    result.exportTransactionIds.push(inserted.id);
    result.unitsReturned += qty;
    result.volumeBblReturned = round4(result.volumeBblReturned + volume);
    result.exciseReversedUsd = round2(result.exciseReversedUsd + totalExciseUsd);

    if (reversedTaxes.length > 0) {
      const { error: taxErr } = await supabase
        .from("export_transaction_taxes")
        .insert(reversedTaxes.map((t) => ({ ...t, export_transaction_id: inserted.id })));
      if (taxErr) throw new Error(taxErr.message);
    }

    if (!restockInventory) continue;

    // never_delivered still reverses the paperwork, but there is no batch to put
    // beer back into when it never left — the caller decides via restockInventory.
    if (!tx.batch_id) {
      result.warnings.push(
        `Returned ${qty} units have no batch on their original shipment, so cold storage was not restocked — add them by hand.`,
      );
      continue;
    }
    const variationId = await resolveVariationId(supabase, tx);
    if (!variationId) {
      result.warnings.push(
        `Could not resolve the packaging variation "${tx.variant_label}" for the returned units — cold storage was not restocked. Fix the mapping in Production → Link Styles to Square, then restock by hand.`,
      );
      continue;
    }
    await restockColdStorage(supabase, {
      batchId: tx.batch_id,
      recipeId: tx.recipe_id,
      variationId,
      quantity: qty,
    });
    result.restocked.push({ batchId: tx.batch_id, quantity: qty });
  }

  return result;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;
