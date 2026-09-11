import { SupabaseClient } from "@supabase/supabase-js";

/**
 * exportedBbl and allocatedBbl arrive by different arithmetic paths (summed
 * export rows vs percentage-of-produced), so an exactly-met commitment can
 * miss by a float hair (observed: 17.6069 vs 17.607). Within this tolerance
 * the commitment counts as met.
 */
export const FULFILLMENT_TOLERANCE_BBL = 0.01;

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
  const shareBbl = (Number(allocation.percentage) / 100) * producedBbl;

  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("volume_bbl")
    .eq("batch_id", allocation.batch_id)
    .eq("channel", allocation.channel)
    .eq("recipient_id", allocation.partner_id);
  const exportedBbl = (exports_ ?? []).reduce((s, e) => s + Number(e.volume_bbl), 0);

  const { data: commitment } = await supabase
    .from("commitments")
    .select("status, volume_bbl")
    .eq("id", allocation.contract_request_id)
    .single();
  if (!commitment) return null;

  // Shipment crediting caps a contract allocation at its booked volume
  // (planShipment: min(booked remaining, realizable)), so on an over-yielding
  // batch exportedBbl can never reach percentage × produced — the commitment
  // is owed min(its % of what was made, what was actually committed).
  const bookedBbl = Number(commitment.volume_bbl);
  const allocatedBbl = bookedBbl > 0 ? Math.min(shareBbl, bookedBbl) : shareBbl;

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
  if (state.exportedBbl < state.allocatedBbl - FULFILLMENT_TOLERANCE_BBL) return;
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

  const met = state.exportedBbl >= state.allocatedBbl - FULFILLMENT_TOLERANCE_BBL;
  const isFulfilled = state.status === "fulfilled";
  if (met === isFulfilled) return;

  await supabase
    .from("commitments")
    .update({ status: met ? "fulfilled" : "open" })
    .eq("id", state.commitmentId);
}

/**
 * Re-evaluates every commitment-backed allocation on a batch. Fulfillment is
 * gated on the batch being "complete", so exports written while the batch was
 * still brewing never trigger a check — this runs the moment the batch turns
 * complete and allocatedBbl becomes final.
 */
export async function recheckBatchCommitments(
  supabase: SupabaseClient,
  batchId: string,
): Promise<void> {
  const { data: allocations } = await supabase
    .from("batch_allocations")
    .select("id")
    .eq("batch_id", batchId)
    .not("contract_request_id", "is", null);
  for (const a of allocations ?? []) {
    await recheckCommitmentFulfillment(supabase, a.id);
  }
}

/**
 * When an allocation is deleted or re-pointed, the commitment it used to back
 * may be stranded at "fulfilled" with nothing backing it. If no allocation
 * references the commitment any more, its demand is unmet again — reopen it.
 */
export async function reopenOrphanedCommitment(
  supabase: SupabaseClient,
  commitmentId: string,
): Promise<void> {
  const { count } = await supabase
    .from("batch_allocations")
    .select("id", { count: "exact", head: true })
    .eq("contract_request_id", commitmentId);
  if ((count ?? 0) > 0) return;
  await supabase
    .from("commitments")
    .update({ status: "open" })
    .eq("id", commitmentId)
    .eq("status", "fulfilled");
}
