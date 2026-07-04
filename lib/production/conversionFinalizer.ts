import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "./batchCompletion";

/** Batch status implied by the stage a batch occupies in a given equipment type. */
export function conversionTargetStatus(
  destType: string | null | undefined,
): "fermenting" | "conditioning" | null {
  switch (destType) {
    case "fermenter": return "fermenting";
    case "brite":     return "conditioning";
    default:          return null;
  }
}

/** Ordered lifecycle rank; higher = later. Unknown/null ranks lowest. */
export const STATUS_RANK: Record<string, number> = {
  planning: 0, brewing: 1, fermenting: 2, conditioning: 3, complete: 4,
};

/** True when `to` is a strictly later stage than `from` (forward-only guard). */
export function isForward(from: string | null | undefined, to: string): boolean {
  const fromRank = from != null && from in STATUS_RANK ? STATUS_RANK[from] : -1;
  const toRank = to in STATUS_RANK ? STATUS_RANK[to] : -1;
  return toRank > fromRank;
}

export async function createConversionTargetBatch(
  supabase: SupabaseClient,
  { sourceBatchId, beerName, recipeId, volumeBbl }: {
    sourceBatchId: string; beerName: string; recipeId: string; volumeBbl: number;
  },
): Promise<string> {
  const { data: parent } = await supabase
    .from("brew_batches").select("planned_brew_date").eq("id", sourceBatchId).single();

  const { data: child, error } = await supabase
    .from("brew_batches")
    .insert({
      beer_name:               beerName,
      recipe_id:               recipeId,
      volume_bbl:              volumeBbl,
      status:                  "planning",
      planned_brew_date:       (parent as { planned_brew_date: string | null } | null)?.planned_brew_date ?? null,
      converted_from_batch_id: sourceBatchId,
      converted_volume_bbl:    volumeBbl,
    })
    .select("id")
    .single();

  if (error || !child) throw new Error(error?.message ?? "Failed to create conversion target batch");
  return (child as { id: string }).id;
}

export interface FinalizeConversionArgs {
  sourceBatchId: string;
  targetBatchId: string;
  fromTankId: string | null;
  toTankId: string | null;
  volumeBbl: number;
  today: string; // 'YYYY-MM-DD'
}

/**
 * Re-point a just-recorded conversion transfer's destination-tank occupancy from
 * the SOURCE batch (where record_batch_transfer + reconcileSchedule wrongly put
 * it) onto the TARGET batch, and complete the source if it is now exhausted.
 * Call once per conversion transfer, after the transfer row exists.
 */
export async function finalizeConversion(
  supabase: SupabaseClient,
  { sourceBatchId, targetBatchId, toTankId, volumeBbl, today }: FinalizeConversionArgs,
): Promise<void> {
  if (toTankId) {
    const { data: destEq } = await supabase
      .from("equipment").select("type").eq("id", toTankId).maybeSingle();
    const destType = (destEq as { type: string | null } | null)?.type ?? null;
    const targetStatus = conversionTargetStatus(destType);
    const stage = destType === "fermenter" ? "fermenting" : destType === "brite" ? "conditioning" : null;

    // 2. Release the source from the destination tank (RPC assigned it there).
    await supabase
      .from("batch_tank_assignments")
      .update({ released_at: new Date().toISOString() })
      .eq("batch_id", sourceBatchId).eq("tank_id", toTankId).is("released_at", null);

    // 3. Cancel the source's spurious open schedule entry on the destination tank.
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "conversion: destination belongs to target batch", updated_at: new Date().toISOString() })
      .eq("batch_id", sourceBatchId).eq("equipment_id", toTankId)
      .is("cancelled_at", null).is("actual_end", null);

    // 4. Assign the target to the destination tank (constrained types only).
    if (targetStatus) {
      const { data: existing } = await supabase
        .from("batch_tank_assignments")
        .select("id").eq("batch_id", targetBatchId).eq("tank_id", toTankId).is("released_at", null)
        .maybeSingle();
      if (!existing) {
        await supabase.from("batch_tank_assignments").insert({ batch_id: targetBatchId, tank_id: toTankId });
      }
    }

    // 5. Advance the target's status (forward-only).
    if (targetStatus) {
      const { data: tb } = await supabase
        .from("brew_batches").select("status").eq("id", targetBatchId).maybeSingle();
      if (isForward((tb as { status: string | null } | null)?.status, targetStatus)) {
        await supabase.from("brew_batches").update({ status: targetStatus }).eq("id", targetBatchId);
        await supabase.from("batch_status_history").insert({
          batch_id: targetBatchId, status: targetStatus, note: `Auto: conversion into ${destType}`,
        });
      }
    }

    // 6. Stamp (or create) the target's schedule entry on the destination tank.
    if (stage) {
      const { data: entry } = await supabase
        .from("batch_schedule_entries")
        .select("id, actual_start")
        .eq("batch_id", targetBatchId).eq("equipment_id", toTankId).eq("stage", stage)
        .is("cancelled_at", null)
        .order("planned_start", { ascending: true }).limit(1)
        .maybeSingle();
      const row = entry as { id: string; actual_start: string | null } | null;
      if (row) {
        const updates: Record<string, unknown> = { volume_bbl: volumeBbl, updated_at: new Date().toISOString() };
        if (row.actual_start == null) updates.actual_start = today;
        await supabase.from("batch_schedule_entries").update(updates).eq("id", row.id);
      } else {
        await supabase.from("batch_schedule_entries").insert({
          batch_id: targetBatchId, equipment_id: toTankId, stage,
          planned_start: today, planned_end: today, actual_start: today,
          volume_bbl: volumeBbl, notes: "Auto-created on conversion",
        });
      }
    }
  }

  // 7. Correct the source's status from the stage it still occupies (partial
  //    conversions; the RPC guessed the dest-tank stage). Resolve the stage from
  //    the source's OPEN schedule entry on its remaining tank so a fermenter that
  //    is hosting conditioning is not mis-set to 'fermenting'; fall back to the
  //    tank-type mapping when no open entry exists. Completion wins in step 8.
  const { data: srcAssign } = await supabase
    .from("batch_tank_assignments")
    .select("tank_id, equipment:tank_id(type)")
    .eq("batch_id", sourceBatchId).is("released_at", null)
    .order("assigned_at", { ascending: false }).limit(1)
    .maybeSingle();
  const srcTankId = (srcAssign as { tank_id: string | null } | null)?.tank_id ?? null;
  const srcType = (srcAssign as { equipment: { type: string | null } | null } | null)?.equipment?.type ?? null;
  if (srcTankId) {
    const { data: srcEntry } = await supabase
      .from("batch_schedule_entries")
      .select("stage")
      .eq("batch_id", sourceBatchId).eq("equipment_id", srcTankId)
      .is("cancelled_at", null).is("actual_end", null)
      .in("stage", ["fermenting", "conditioning"])
      .order("actual_start", { ascending: false }).limit(1)
      .maybeSingle();
    const entryStage = (srcEntry as { stage: string | null } | null)?.stage ?? null;
    const srcStatus = entryStage === "fermenting" || entryStage === "conditioning"
      ? entryStage
      : conversionTargetStatus(srcType);
    if (srcStatus) {
      await supabase.from("brew_batches").update({ status: srcStatus }).eq("id", sourceBatchId);
    }
  }

  // 8. Complete the source if fully exhausted (full conversion).
  await checkAndCompleteBatch(supabase, sourceBatchId);
}
