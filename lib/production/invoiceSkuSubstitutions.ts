// lib/production/invoiceSkuSubstitutions.ts
//
// Billing a shipment against a Square item that is not its own — and paying
// Square's inventory back for it.
//
// The shape of the problem, end to end:
//
//   ship 20 kegs of Oktoberfest, filled into the CUSTOMER'S kegs
//     that packaging variation is deliberately unlinked — a linked variation is
//     sellable in the catalog, and nobody may sell someone else's keg
//   invoice borrows the house 1/6 Keg item for the line
//     the only way to bill it at the distribution rate the customer is owed
//   Square deducts 20 house kegs when the invoice is SENT
//     for units Square never had; its count is now 20 low, permanently
//   credit 20 back, once, right after that send
//     a relative adjustment, paired 1:1 with the deduction it undoes
//
// The cold-storage push cannot heal this on its own: it sums only LINKED
// variations, and the customer-keg variation is unlinked by design, so it
// contributes nothing to the pushed total and the gap survives every push.
//
// Two guards keep this from becoming a way to inflate Square:
//   * a substitution is only ever recorded for a shipment the DATABASE says has
//     no Square link — the client's claim is checked, never trusted, so a line
//     flagged by mistake against a properly-linked shipment records nothing;
//   * the credit is verified by reading Square's count back, because Square
//     accepts a write against an object it does not have and returns no error.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { fetchCurrentCounts, receiveStock } from "@/lib/square/inventory";

const COUNT_EPS = 1e-6;

/** What the invoice modal says an operator chose for one unlinked shipment. */
export interface SubstitutionClaim {
  exportTransactionId: string;
  /** The borrowed Square variation the line was billed under. */
  squareVariationId: string;
  /** Whether to credit the deducted units back after the invoice is sent. */
  restoreInventory: boolean;
}

export interface RecordableSubstitution {
  exportTransactionId: string;
  squareVariationId: string;
  quantity: number;
  restoreInventory: boolean;
}

/**
 * PURE. Keep only the claims that describe a shipment the database agrees has no
 * Square product link, and take the quantity from the shipment rather than the
 * claim.
 *
 * This is the whole trust boundary. A claim is a client assertion that some
 * shipment had to borrow an item; if the shipment actually HAS its own link then
 * Square deducted the right SKU for real stock, and crediting it back would
 * invent inventory. Unknown, duplicate and properly-linked shipments all drop.
 */
export function selectRecordableSubstitutions(
  claims: SubstitutionClaim[],
  unlinkedQuantityByTxId: Map<string, number>,
): RecordableSubstitution[] {
  const seen = new Set<string>();
  const out: RecordableSubstitution[] = [];
  for (const claim of claims) {
    const quantity = unlinkedQuantityByTxId.get(claim.exportTransactionId);
    if (quantity == null || quantity <= 0) continue;
    if (!claim.squareVariationId) continue;
    if (seen.has(claim.exportTransactionId)) continue;
    seen.add(claim.exportTransactionId);
    out.push({
      exportTransactionId: claim.exportTransactionId,
      squareVariationId: claim.squareVariationId,
      quantity,
      restoreInventory: claim.restoreInventory,
    });
  }
  return out;
}

/**
 * Which of these shipments genuinely have no Square product link, and for how
 * many units. Mirrors buildProductLines' resolution exactly — the literal
 * variation shipped (`variant_label`) scoped to the recipe, then the SKU at
 * variation grain — so the two can never disagree about what "unlinked" means.
 */
export async function findUnlinkedShipments(
  supabase: SupabaseClient,
  transactionIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (transactionIds.length === 0) return out;

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select("id, recipe_id, variant_label, quantity")
    .in("id", transactionIds);
  if (error) throw new Error(error.message);

  for (const tx of txs ?? []) {
    if (!tx.recipe_id) continue;
    const { data: pvRows } = await supabase
      .from("recipe_packaging_variations")
      .select("variation_id, packaging_variations!inner(id, name)")
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.name", tx.variant_label);
    // Ambiguous or missing resolution is not "unlinked" — buildProductLines
    // throws on it, so no invoice carrying such a shipment exists to correct.
    if (!pvRows || pvRows.length !== 1) continue;

    const sku = await resolveProductSku(supabase, {
      kind: "packaged",
      variationId: pvRows[0].variation_id as string,
      recipeId: tx.recipe_id as string,
    });
    if (sku) continue;
    out.set(tx.id as string, Number(tx.quantity));
  }
  return out;
}

/**
 * Persist what the operator chose, for the shipments that check out. Runs at
 * generate; the credit itself waits for the send that causes the deduction.
 */
export async function recordInvoiceSkuSubstitutions(
  supabase: SupabaseClient,
  invoiceId: string,
  transactionIds: string[],
  claims: SubstitutionClaim[],
): Promise<RecordableSubstitution[]> {
  if (claims.length === 0) return [];
  const unlinked = await findUnlinkedShipments(supabase, transactionIds);
  const rows = selectRecordableSubstitutions(claims, unlinked);
  if (rows.length === 0) return [];

  const { error } = await supabase.from("invoice_sku_substitutions").upsert(
    rows.map((r) => ({
      invoice_id: invoiceId,
      export_transaction_id: r.exportTransactionId,
      square_variation_id: r.squareVariationId,
      quantity: r.quantity,
      restore_inventory: r.restoreInventory,
    })),
    { onConflict: "invoice_id,export_transaction_id", ignoreDuplicates: false },
  );
  if (error) throw new Error(error.message);
  return rows;
}

export interface RestoreOutcome {
  restored: number;
  warnings: string[];
}

/**
 * Credit back the units this invoice's substituted lines caused Square to deduct.
 *
 * Called after the send that publishes the invoice. Once-only per row
 * (`restored_at` is the guard), and never fails the send — a credit that did not
 * land is recorded on the row as `restore_error` and surfaced as a warning, since
 * the alternative is telling the operator their invoice failed to go out when it
 * demonstrably did.
 */
export async function restoreSubstitutedInventory(
  supabase: SupabaseClient,
  invoiceId: string,
  occurredAt: string = new Date().toISOString(),
): Promise<RestoreOutcome> {
  const out: RestoreOutcome = { restored: 0, warnings: [] };

  const { data: rows, error } = await supabase
    .from("invoice_sku_substitutions")
    .select("id, square_variation_id, quantity")
    .eq("invoice_id", invoiceId)
    .eq("restore_inventory", true)
    .is("restored_at", null);
  if (error) throw new Error(error.message);
  if (!rows?.length) return out;

  for (const row of rows) {
    const variationId = row.square_variation_id as string;
    const units = Math.round(Number(row.quantity));
    if (units < 1) {
      await supabase
        .from("invoice_sku_substitutions")
        .update({ restore_error: `quantity ${row.quantity} rounds to zero whole units — nothing credited` })
        .eq("id", row.id);
      out.warnings.push(`Square credit skipped for ${variationId}: quantity rounds to zero units.`);
      continue;
    }

    try {
      const before = (await fetchCurrentCounts([variationId])).get(variationId) ?? null;
      await receiveStock(variationId, units, occurredAt);
      const after = (await fetchCurrentCounts([variationId])).get(variationId) ?? null;

      // Square takes a write against an object it does not have without
      // complaint, so the POST returning cleanly proves nothing. The delta does.
      const landed = before != null && after != null && Math.abs(after - before - units) <= COUNT_EPS;
      if (!landed) {
        const detail = `credited ${units}, Square went from ${before ?? "no count"} to ${after ?? "no count"}`;
        await supabase
          .from("invoice_sku_substitutions")
          .update({ restore_error: detail, square_count_before: before, square_count_after: after })
          .eq("id", row.id);
        out.warnings.push(`Square credit NOT verified for ${variationId}: ${detail}.`);
        continue;
      }

      await supabase
        .from("invoice_sku_substitutions")
        .update({
          restored_at: occurredAt,
          square_count_before: before,
          square_count_after: after,
          restore_error: null,
        })
        .eq("id", row.id);
      out.restored++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase.from("invoice_sku_substitutions").update({ restore_error: message }).eq("id", row.id);
      out.warnings.push(`Square credit failed for ${variationId}: ${message}`);
    }
  }
  return out;
}
