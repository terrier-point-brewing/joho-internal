import { SupabaseClient } from "@supabase/supabase-js";
import { releaseCommitments } from "./commitments";
import { recheckBatchCommitments } from "./commitmentFulfillment";

/**
 * Checks batch_exhaustion for the given batch and, if fully exhausted (all
 * original volume accounted for via kegging, canning, conversion, or shrinkage),
 * transitions it to "complete". Idempotent — no-op if already complete.
 */
export async function checkAndCompleteBatch(supabase: SupabaseClient, batchId: string): Promise<void> {
  const { data: exhaustion } = await supabase
    .from("batch_exhaustion")
    .select("is_exhausted")
    .eq("batch_id", batchId)
    .single();
  if (!exhaustion?.is_exhausted) return;

  const { data: batch } = await supabase.from("brew_batches").select("status").eq("id", batchId).single();
  if (batch?.status === "complete") return;

  await supabase.from("brew_batches").update({ status: "complete" }).eq("id", batchId);
  await supabase.from("batch_status_history").insert({
    batch_id: batchId,
    status: "complete",
    note: "Auto: fully packaged",
  });
  await releaseCommitments(supabase, batchId);

  // Fulfillment is only judged once a batch is complete, and this is the one
  // completion path that never went through the batches PATCH route — a source
  // exhausted BY a conversion (its last volume drawn off into a child) would
  // otherwise leave its commitments un-re-judged forever. Best-effort: a
  // fulfillment write must not undo the completion above.
  try {
    await recheckBatchCommitments(supabase, batchId);
  } catch (recheckErr) {
    console.error("[batchCompletion] Commitment recheck failed (batch completed):", recheckErr);
  }
}
