/**
 * How much beer, in bbl, sits behind each beer line on an invoice.
 *
 * Needed only by the refund planner, and only to credit excise: excise is
 * charged per bbl, so reversing it off a unit count would misstate the filing
 * the moment an invoice mixes container sizes (8 sixtels and 8 half-barrels are
 * the same 8 units and nearly four times the tax). See G5 in
 * lib/finance/refundPlanner.ts — the planner refuses rather than guess when this
 * returns nothing for a line.
 *
 * `export_transactions` stores the packaging variation shipped, not a Square
 * variation id, so the link back is resolved the same way the invoice was built:
 * packaging variation from the shipment, then the product SKU at variation grain.
 *
 * Two transactions can share a variation and become two invoice lines, so a
 * variation is not a unique key back to a single line. That is fine: same
 * variation means same container size, so volume is exactly proportional to
 * quantity within the group, and the group's volume can be split across its
 * lines by quantity with no loss.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProductSku } from "@/lib/square/skuMappings";
import { resolveShippedVariationId, type ShippedVariationRef } from "@/lib/production/resolveShippedVariation";

interface VolumeGroup {
  quantity: number;
  volumeBbl: number;
}

/**
 * Resolve the Square variation id a shipped export transaction was invoiced
 * under. Returns null when the mapping can't be resolved — the caller degrades
 * to "no volume for this line", which the planner then refuses to credit excise
 * against, rather than inventing a number.
 */
async function resolveVariationId(
  supabase: SupabaseClient,
  tx: ShippedVariationRef,
): Promise<string | null> {
  // Same resolver buildProductLines uses — an unresolvable or ambiguous mapping
  // is not a volume we can stand behind.
  const variationId = await resolveShippedVariationId(supabase, tx);
  if (!variationId || !tx.recipe_id) return null;

  const sku = await resolveProductSku(supabase, {
    kind: "packaged",
    variationId,
    recipeId: tx.recipe_id,
  });
  return sku?.squareVariationId ?? null;
}

/**
 * Map each of an invoice's beer line items to the bbl behind it.
 *
 * Lines whose variation has no export transactions behind it are simply absent
 * from the map — a Square-native invoice raised by hand has no shipment to read
 * a volume from, and saying so is the honest answer.
 */
export async function resolveInvoiceLineVolumes(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<Map<string, number>> {
  const { data: txs } = await supabase
    .from("export_transactions")
    .select("id, recipe_id, variation_id, variant_label, quantity, volume_bbl")
    .eq("invoice_id", invoiceId);

  const byVariation = new Map<string, VolumeGroup>();
  for (const tx of txs ?? []) {
    const variationId = await resolveVariationId(supabase, tx);
    if (!variationId) continue;
    const g = byVariation.get(variationId) ?? { quantity: 0, volumeBbl: 0 };
    g.quantity += Number(tx.quantity) || 0;
    g.volumeBbl += Number(tx.volume_bbl) || 0;
    byVariation.set(variationId, g);
  }

  const { data: lines } = await supabase
    .from("invoice_line_items")
    .select("id, quantity, square_catalog_variation_id")
    .eq("invoice_id", invoiceId);

  const out = new Map<string, number>();
  for (const line of lines ?? []) {
    const variationId = line.square_catalog_variation_id;
    if (!variationId) continue;
    const g = byVariation.get(variationId);
    if (!g || g.quantity <= 0) continue;
    // Proportional within the variation group — exact, because one variation is
    // one container size.
    out.set(line.id, g.volumeBbl * ((Number(line.quantity) || 0) / g.quantity));
  }

  if (out.size > 0) return out;
  return contractBrewingFallback(lines ?? [], txs ?? []);
}

/**
 * A contract-brewing invoice bills the packaging, not the beer — invoice 000042
 * is Packaging Fee x 30 cases, two excise lines, a forklift fee and a materials
 * charge, with no product line anywhere. So the variation match above finds
 * nothing, and the per-case line the excise actually scales off is the
 * PACKAGING FEE.
 *
 * The fallback spreads the invoice's total shipped volume across its
 * quantity-bearing lines by quantity — but ONLY when those quantities tie
 * exactly to the shipped quantities. That tie is the whole safety of this:
 * 30 cases billed against 30 cases shipped means one case is one case and the
 * split is exact. If it doesn't tie, something about the invoice isn't the
 * shipment, and returning nothing makes the planner refuse rather than credit
 * excise off a number nobody can defend.
 */
function contractBrewingFallback(
  lines: { id: string; quantity: number | string }[],
  txs: { quantity: number | string; volume_bbl: number | string }[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (txs.length === 0) return out;

  const shippedQty = txs.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
  const shippedVolume = txs.reduce((s, t) => s + (Number(t.volume_bbl) || 0), 0);
  if (shippedQty <= 0 || shippedVolume <= 0) return out;

  // Quantity-bearing lines only. A quantity-1 line is a flat fee, not a count of
  // anything, and including it would break the tie check below for no reason.
  const counted = lines.filter((l) => (Number(l.quantity) || 0) > 1);
  const billedQty = counted.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  if (billedQty !== shippedQty) return out;

  for (const line of counted) {
    out.set(line.id, shippedVolume * ((Number(line.quantity) || 0) / billedQty));
  }
  return out;
}
