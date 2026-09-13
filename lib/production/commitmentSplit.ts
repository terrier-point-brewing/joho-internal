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

  // The deal can only give up volume nobody has been shipped yet. B-056 was
  // credited 24.39 bbl, then the split shrank its commitment to 22.83 — the
  // allocation sat above its own booking with nothing saying so. Credited
  // volume is read by allocation_id, the unit of record.
  const creditedBbl = await creditedAgainstCommitment(supabase, parent.id);
  const remainingAfter = Number(parent.volume_bbl ?? 0) - movedBbl;
  if (creditedBbl > 0 && remainingAfter < creditedBbl - 0.01) {
    const free = Math.max(0, Number(parent.volume_bbl ?? 0) - creditedBbl);
    throw new Error(
      `Can't move ${movedBbl.toFixed(2)} bbl off this commitment: ${creditedBbl.toFixed(2)} bbl has already shipped against it, ` +
      `so only ${free.toFixed(2)} bbl is still uncommitted. Reduce the conversion volume or raise a separate commitment for ${childLabel}.`,
    );
  }

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
      split_from_commitment_id: parent.id,
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

/** bbl already credited (shipped) against a commitment, summed over its allocations. */
async function creditedAgainstCommitment(supabase: SupabaseClient, commitmentId: string): Promise<number> {
  const { data: allocs } = await supabase
    .from("batch_allocations")
    .select("id")
    .eq("contract_request_id", commitmentId);
  const ids = ((allocs ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (ids.length === 0) return 0;
  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("volume_bbl")
    .in("allocation_id", ids);
  return ((exports_ ?? []) as Array<{ volume_bbl: number | string | null }>)
    .reduce((s, e) => s + Number(e.volume_bbl ?? 0), 0);
}
