import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Split a commitment when a conversion carries part of it into a different
 * beer.
 *
 * A commitment is a deal for one recipe. When 5.17 bbl of a Pilsner deal
 * converts into Orange Pilsner, the child's allocation must NOT keep pointing
 * at the Pilsner commitment: crediting matches on the commitment's identity,
 * deposit previews read its volume, and the in-keg gate rejects the recipe
 * mismatch outright — B-063 and B-056 both hung off the same 28 bbl Pilsner
 * commitment and both deposit previews billed against it. The deal splits
 * instead: a new commitment for the child's recipe holds the moved volume,
 * and the original shrinks by the same amount.
 *
 * Returns the commitment id the child's allocation should use. No split when
 * the commitment already IS for the child's recipe (same-beer conversion
 * targets, or an operator picked a pre-made child-recipe commitment).
 */
export async function splitCommitmentForConversionChild(
  supabase: SupabaseClient,
  { commitmentId, childRecipeId, volumeBbl, deliveryDate, childLabel }: {
    commitmentId: string;
    childRecipeId: string;
    /** The child's share of the deal, in bbl (rounded to 2dp on write). */
    volumeBbl: number;
    /** The child's expected delivery date; falls back to the parent deal's. */
    deliveryDate?: string | null;
    /** For the audit notes, e.g. "B-063 Orange Pilsner". */
    childLabel: string;
  },
): Promise<string> {
  const { data: parentRow } = await supabase
    .from("commitments")
    .select("id, recipe_id, partner_id, channel, volume_bbl, desired_delivery_date, received_on")
    .eq("id", commitmentId)
    .maybeSingle();
  const parent = parentRow as {
    id: string; recipe_id: string | null; partner_id: string | null; channel: string | null;
    volume_bbl: number | null; desired_delivery_date: string | null; received_on: string | null;
  } | null;
  if (!parent) throw new Error("Commitment to split no longer exists.");
  if (parent.recipe_id === childRecipeId) return parent.id;

  const movedBbl = Math.round(Number(volumeBbl) * 100) / 100;
  if (!(movedBbl > 0)) return parent.id;

  const { data: child, error: insertErr } = await supabase
    .from("commitments")
    .insert({
      recipe_id:             childRecipeId,
      partner_id:            parent.partner_id,
      channel:               parent.channel,
      volume_bbl:            movedBbl,
      desired_delivery_date: deliveryDate ?? parent.desired_delivery_date,
      received_on:           parent.received_on,
      status:                "open",
      notes: `Auto-split from commitment ${parent.id.slice(0, 8)} — ${movedBbl} bbl converted into ${childLabel}.`,
    })
    .select("id")
    .single();
  if (insertErr || !child) throw new Error(insertErr?.message ?? "Failed to split commitment");

  // The original deal shrinks by exactly what moved; never below zero.
  const remaining = Math.max(0, Math.round((Number(parent.volume_bbl ?? 0) - movedBbl) * 100) / 100);
  await supabase
    .from("commitments")
    .update({ volume_bbl: remaining })
    .eq("id", parent.id);

  return (child as { id: string }).id;
}
