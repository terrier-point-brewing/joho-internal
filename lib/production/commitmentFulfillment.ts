import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Checks whether the commitment backing a given allocation has been fully
 * met and, if so, marks it "fulfilled". A commitment can only be fulfilled
 * once its batch reaches "complete" — until then, allocated_bbl is a moving
 * target (it's a percentage of produced_bbl, which isn't final until the
 * batch stops accepting more kegging/canning) — so checking exported_bbl
 * against an intermediate allocated_bbl would be meaningless.
 */
export async function checkAndFulfillCommitment(supabase: SupabaseClient, allocationId: string): Promise<void> {
  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id")
    .eq("id", allocationId)
    .single();
  if (!allocation?.contract_request_id) return;

  const { data: batch } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", allocation.batch_id)
    .single();
  if (batch?.status !== "complete") return;

  const { data: transfers } = await supabase
    .from("batch_transfers")
    .select("volume_bbl, shrinkage_bbl, transfer_type")
    .eq("batch_id", allocation.batch_id)
    .in("transfer_type", ["kegging", "canning"]);
  const producedBbl = (transfers ?? []).reduce(
    (s, t) => s + (Number(t.volume_bbl) - Number(t.shrinkage_bbl ?? 0)),
    0
  );
  if (producedBbl <= 0) return;
  const allocatedBbl = (Number(allocation.percentage) / 100) * producedBbl;

  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .eq("channel", allocation.channel)
    .eq("recipient_id", allocation.partner_id);
  const exportedBbl = (exports_ ?? []).reduce((s, e) => s + Number(e.volume_bbl), 0);

  if (exportedBbl < allocatedBbl) return;

  const { data: commitment } = await supabase
    .from("commitments")
    .select("status")
    .eq("id", allocation.contract_request_id)
    .single();
  if (commitment?.status === "fulfilled") return;

  await supabase.from("commitments").update({ status: "fulfilled" }).eq("id", allocation.contract_request_id);
}
