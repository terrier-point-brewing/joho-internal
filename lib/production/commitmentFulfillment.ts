import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Everything needed to decide a commitment's fulfillment state, or null when a
 * gate failed and no decision can be made (no backing commitment, batch not
 * complete, or nothing produced yet).
 */
interface FulfillmentState {
  commitmentId: string;
  status: string;
  exportedBbl: number;
  allocatedBbl: number;
}

/**
 * Shared read-and-compute half of both public functions, so the fulfillment
 * math can never diverge between the forward and reverse directions.
 *
 * A commitment can only be judged once its batch reaches "complete" — until
 * then, allocatedBbl is a moving target (it's a percentage of producedBbl,
 * which isn't final until the batch stops accepting more kegging/canning) — so
 * comparing exportedBbl against an intermediate allocatedBbl would be
 * meaningless in either direction.
 */
async function loadFulfillmentState(
  supabase: SupabaseClient,
  allocationId: string,
): Promise<FulfillmentState | null> {
  const { data: allocation } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id")
    .eq("id", allocationId)
    .single();
  if (!allocation?.contract_request_id) return null;

  const { data: batch } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", allocation.batch_id)
    .single();
  if (batch?.status !== "complete") return null;

  const { data: transfers } = await supabase
    .from("batch_transfers")
    .select("volume_bbl, transfer_type")
    .eq("batch_id", allocation.batch_id)
    .in("transfer_type", ["kegging", "canning"]);
  // produced = sum(volume_bbl), net fill. volume_bbl is already the net beer in
  // containers; shrinkage_bbl is a separate loss figure and must NOT be
  // subtracted here (would double-count). See the allocation-reserve plan.
  const producedBbl = (transfers ?? []).reduce((s, t) => s + Number(t.volume_bbl), 0);
  if (producedBbl <= 0) return null;
  const allocatedBbl = (Number(allocation.percentage) / 100) * producedBbl;

  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .eq("channel", allocation.channel)
    .eq("recipient_id", allocation.partner_id);
  const exportedBbl = (exports_ ?? []).reduce((s, e) => s + Number(e.volume_bbl), 0);

  const { data: commitment } = await supabase
    .from("commitments")
    .select("status")
    .eq("id", allocation.contract_request_id)
    .single();
  if (!commitment) return null;

  return {
    commitmentId: allocation.contract_request_id,
    status: commitment.status,
    exportedBbl,
    allocatedBbl,
  };
}

/**
 * Checks whether the commitment backing a given allocation has been fully
 * met and, if so, marks it "fulfilled". Forward-only: never un-fulfills.
 *
 * Called on every shipment write. Use `recheckCommitmentFulfillment` instead
 * when credit may have been REMOVED.
 */
export async function checkAndFulfillCommitment(
  supabase: SupabaseClient,
  allocationId: string,
): Promise<void> {
  const state = await loadFulfillmentState(supabase, allocationId);
  if (!state) return;
  if (state.exportedBbl < state.allocatedBbl) return;
  if (state.status === "fulfilled") return;

  await supabase.from("commitments").update({ status: "fulfilled" }).eq("id", state.commitmentId);
}

/**
 * Re-evaluates fulfillment in BOTH directions, for when a shipment edit
 * releases allocation credits and the commitment may no longer be met.
 *
 * Reverts to "open" rather than "brewing": fulfillment only ever fires once the
 * batch is "complete", so a batch that reaches this point is past brewing and
 * "open" is the only coherent un-fulfilled state.
 *
 * Idempotent — safe to re-run.
 */
export async function recheckCommitmentFulfillment(
  supabase: SupabaseClient,
  allocationId: string,
): Promise<void> {
  const state = await loadFulfillmentState(supabase, allocationId);
  if (!state) return;

  const met = state.exportedBbl >= state.allocatedBbl;
  const isFulfilled = state.status === "fulfilled";
  if (met === isFulfilled) return;

  await supabase
    .from("commitments")
    .update({ status: met ? "fulfilled" : "open" })
    .eq("id", state.commitmentId);
}
