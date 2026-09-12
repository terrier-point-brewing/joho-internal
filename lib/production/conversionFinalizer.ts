import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "./batchCompletion";
import { releaseCommitments, upsertCommitments, upsertConversionCommitments } from "./commitments";
import { resolveConversionBase } from "./conversionIngredients";
import { seedBatchActivities, type RecipeActivityRow } from "./brewActivities";
import { createBatchSquareProject } from "@/lib/square/projects";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";

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

/**
 * Find an existing conversion-born child of `sourceBatchId` for `recipeId`.
 *
 * One liquid converted to one recipe is ONE child batch, however many runs it
 * takes to package it. Every route that mints a conversion target must look
 * here first — minting blindly is how B-056's Orange Pilsner split into B-063
 * and B-068 (two children of the same source+recipe, ten days apart).
 * Most recent child wins if history somehow holds more than one.
 */
export async function findExistingConversionChild(
  supabase: SupabaseClient,
  sourceBatchId: string,
  recipeId: string,
): Promise<{ id: string; volumeBbl: number; convertedVolumeBbl: number | null } | null> {
  const { data } = await supabase
    .from("brew_batches")
    .select("id, volume_bbl, converted_volume_bbl")
    .eq("converted_from_batch_id", sourceBatchId)
    .eq("recipe_id", recipeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; volume_bbl: number | null; converted_volume_bbl: number | null };
  return {
    id: row.id,
    volumeBbl: Number(row.volume_bbl ?? 0),
    convertedVolumeBbl: row.converted_volume_bbl == null ? null : Number(row.converted_volume_bbl),
  };
}

/**
 * Sum the conversion volume already delivered INTO a child batch — the prior
 * runs' inflow transfers. Used when a new conversion run lands on an existing
 * child: the child's volume becomes prior + this run, never a blind replace.
 */
export async function priorConversionInflowBbl(
  supabase: SupabaseClient,
  targetBatchId: string,
): Promise<number> {
  const { data } = await supabase
    .from("batch_transfers")
    .select("volume_bbl")
    .eq("to_batch_id", targetBatchId)
    .eq("transfer_type", "conversion");
  return (data ?? []).reduce((s, r) => s + Number((r as { volume_bbl: number | null }).volume_bbl ?? 0), 0);
}

/**
 * A conversion child's delivery date: the conversion day plus however long the
 * derived beer still conditions. A conversion skips brewhouse and fermenting by
 * definition, so only the recipe's brite time remains — and when the recipe
 * declares none, the conversion day itself stands in, so the child always has a
 * delivery date and never falls out of the demand calendar.
 */
export async function deriveConversionDeliveryDate(
  supabase: SupabaseClient,
  recipeId: string,
  conversionDate: string,
): Promise<string> {
  const { data: recipe } = await supabase
    .from("recipes").select("days_brite").eq("id", recipeId).maybeSingle();
  const briteDays = Number((recipe as { days_brite: number | null } | null)?.days_brite ?? 0);
  return briteDays > 0 ? addDaysStr(conversionDate, briteDays) : conversionDate;
}

export async function createConversionTargetBatch(
  supabase: SupabaseClient,
  { sourceBatchId, beerName, recipeId, volumeBbl, conversionDate, expectedDeliveryDate, bornComplete }: {
    sourceBatchId: string; beerName: string; recipeId: string; volumeBbl: number;
    /**
     * The day the conversion is planned to happen (or happened, for the
     * execution paths). The child's timeline starts here — NOT at the parent's
     * brew day, which could be months earlier and made converted batches sort
     * and schedule as if they were as old as their parent.
     */
    conversionDate?: string | null;
    /**
     * Operator-chosen delivery date. When absent it derives from the
     * conversion date + the recipe's brite time.
     */
    expectedDeliveryDate?: string | null;
    /**
     * In-keg/in-can child, completed within the same request. Skips the Square
     * project invoice — it tracks an upcoming delivery, which a batch born
     * fully packaged never has.
     */
    bornComplete?: boolean;
  },
): Promise<string> {
  const brewDate = conversionDate || todayLocalDate();
  const deliveryDate = expectedDeliveryDate || await deriveConversionDeliveryDate(supabase, recipeId, brewDate);

  const { data: child, error } = await supabase
    .from("brew_batches")
    .insert({
      beer_name:               beerName,
      recipe_id:               recipeId,
      volume_bbl:              volumeBbl,
      status:                  "planning",
      planned_brew_date:       brewDate,
      expected_delivery_date:  deliveryDate,
      converted_from_batch_id: sourceBatchId,
      converted_volume_bbl:    volumeBbl,
    })
    .select("id")
    .single();

  if (error || !child) throw new Error(error?.message ?? "Failed to create conversion target batch");
  const childId = (child as { id: string }).id;

  // Parity with the Batch Log's batch factory, best-effort: the child exists
  // and is the record that matters, so none of these may fail the creation.
  try {
    await supabase.from("batch_status_history").insert({
      batch_id: childId, status: "planning", note: "Auto: created as conversion target",
    });

    const { data: templates } = await supabase
      .from("brew_activities")
      .select("sort_order, activity, time_label, temp, temp_unit, amount, amount_unit, vsp")
      .eq("recipe_id", recipeId)
      .order("sort_order");
    if (templates && templates.length > 0) {
      await supabase.from("brew_activities").insert(
        seedBatchActivities(templates as RecipeActivityRow[], childId),
      );
    }

    if (!bornComplete) {
      await createBatchSquareProject(supabase, {
        batchId: childId, beerName, volumeBbl,
        plannedBrewDate: brewDate, expectedDeliveryDate: deliveryDate, recipeId,
      });
    }
  } catch (extrasErr) {
    console.error("[conversion] Child batch extras failed (batch created):", extrasErr);
  }

  return childId;
}

/**
 * The oldest still-pending conversion plan from this source whose target is a
 * waiting child of the given recipe — the plan an execution should resolve
 * onto instead of minting a duplicate child next to it. Shared by the in-keg
 * path and the tank path so the two can never disagree about what counts as
 * "already planned". Oldest first, so two planned runs of the same beer
 * resolve in order.
 */
export async function findPendingConversionPlan(
  supabase: SupabaseClient,
  { sourceBatchId, recipeId }: { sourceBatchId: string; recipeId: string },
): Promise<{ planId: string; targetBatchId: string } | null> {
  const { data: pendingPlans } = await supabase
    .from("batch_conversions")
    .select("id, target_batch_id, target:brew_batches!target_batch_id(recipe_id, status)")
    .eq("source_batch_id", sourceBatchId)
    .is("converted_at", null)
    .order("created_at", { ascending: true });
  for (const plan of pendingPlans ?? []) {
    const target = plan.target as unknown as { recipe_id: string | null; status: string | null } | null;
    if (target?.recipe_id === recipeId && (target.status === "planning" || target.status === "backlog")) {
      return { planId: plan.id as string, targetBatchId: plan.target_batch_id as string };
    }
  }
  return null;
}

/**
 * Reconcile a conversion-born batch's headline volume to what the conversion(s)
 * actually delivered (planned volume − transfer shrinkage).
 *
 * A pre-planned conversion target is created with an ESTIMATED volume before the
 * transfer runs. If the executed conversion loses volume to shrinkage, the
 * target's volume_bbl otherwise stays too high and its Volume Breakdown reads
 * permanently "unbalanced" by the shrinkage (the child's ledger accounts for the
 * delivered volume, but is compared against the stale nominal). The inline
 * new_batch path already births the child at the delivered volume; this brings
 * the pre-planned path to parity.
 *
 * Guards:
 *  - Only a PURE conversion-born batch is touched — one whose headline volume IS
 *    its conversion volume (volume_bbl ≈ converted_volume_bbl). A batch blended
 *    into an existing brew (volume_bbl includes brewed liquid ≠
 *    converted_volume_bbl) is left untouched.
 *  - No-ops when the volume already matches the delivered total (the inline path)
 *    or nothing was delivered.
 *  - Refreshes absolute ingredient commitments only when the batch already has
 *    them — never fabricates grain reservations for a liquid-only conversion.
 *
 * Sums every conversion inflow so a target fed by more than one source totals
 * correctly, and is idempotent (re-running with the same transfers is a no-op).
 */
export async function reconcileConvertedBatchVolume(
  supabase: SupabaseClient,
  targetBatchId: string,
): Promise<void> {
  const { data: batchRow } = await supabase
    .from("brew_batches")
    .select("volume_bbl, converted_volume_bbl, recipe_id, turns, converted_from_batch_id")
    .eq("id", targetBatchId)
    .single();
  const batch = batchRow as
    | {
        volume_bbl: number | null; converted_volume_bbl: number | null; recipe_id: string | null;
        turns: number | null; converted_from_batch_id: string | null;
      }
    | null;
  if (!batch) return;

  const volume = Number(batch.volume_bbl ?? 0);
  const convertedVolume = batch.converted_volume_bbl == null ? null : Number(batch.converted_volume_bbl);
  // Pure conversion-born signal: headline volume equals the recorded conversion
  // volume. Skip blended-into-existing targets where the two diverge.
  if (convertedVolume == null || Math.abs(volume - convertedVolume) > 0.001) return;

  const { data: inflowRows } = await supabase
    .from("batch_transfers")
    .select("volume_bbl")
    .eq("to_batch_id", targetBatchId)
    .eq("transfer_type", "conversion");
  const deliveredVol = (inflowRows ?? []).reduce(
    (sum, r) => sum + Number((r as { volume_bbl: number | null }).volume_bbl ?? 0),
    0,
  );
  // Nothing delivered yet, or already correct → no reconciliation needed.
  if (deliveredVol <= 0 || Math.abs(volume - deliveredVol) < 0.001) return;

  await supabase
    .from("brew_batches")
    .update({ volume_bbl: deliveredVol, converted_volume_bbl: deliveredVol })
    .eq("id", targetBatchId);

  // Re-sync the commitment set against the current recipe — but only when the
  // batch already carries commitments, so a liquid-only conversion target never
  // gains phantom grain reservations.
  if (batch.recipe_id) {
    const { count } = await supabase
      .from("batch_ingredient_commitments")
      .select("*", { count: "exact", head: true })
      .eq("batch_id", targetBatchId);
    if ((count ?? 0) > 0) {
      // A recipe that declares this conversion's source as its base reserves only
      // what the conversion ADDS, scaled to the volume that actually arrived.
      // Running the full bill here would undo that and reserve the base grain a
      // second time — the very double-count the link exists to prevent.
      const link = batch.converted_from_batch_id
        ? await resolveConversionBase(supabase, batch.converted_from_batch_id, targetBatchId)
        : null;
      if (link) {
        await upsertConversionCommitments(
          supabase, targetBatchId, link.derivedRecipeId, link.baseRecipeId, deliveredVol,
        );
      } else {
        // Unlinked: the delivered volume deliberately does not enter the
        // quantities. Commitments are per brewhouse turn, and reconciling liquid
        // that came from somewhere else does not change the grain bill.
        await upsertCommitments(
          supabase,
          targetBatchId,
          batch.recipe_id,
          Math.max(1, Number(batch.turns ?? 1)),
        );
      }
    }
  }
}

/**
 * Complete a conversion-born child that was packaged in its entirety — an
 * in-keg/in-can conversion, whose whole volume went into containers within the
 * same request that created it.
 *
 * Deliberately NOT routed through batch_exhaustion: brew_batches.volume_bbl is
 * numeric(8,2) while the packaging rows keep full precision, so a child born at
 * e.g. one sixtel (0.16656 bbl, stored 0.17) misses the view's 0.001 tolerance
 * by rounding alone and would sit in 'planning' forever. The child is complete
 * by construction; say so directly.
 */
export async function completeConversionChild(
  supabase: SupabaseClient,
  childBatchId: string,
): Promise<void> {
  const { data: batch } = await supabase
    .from("brew_batches").select("status").eq("id", childBatchId).maybeSingle();
  if ((batch as { status: string | null } | null)?.status === "complete") return;

  await supabase.from("brew_batches").update({ status: "complete" }).eq("id", childBatchId);
  await supabase.from("batch_status_history").insert({
    batch_id: childBatchId, status: "complete", note: "Auto: fully packaged (in-keg conversion)",
  });
  // Anything a pre-planned conversion was holding in reserve is spent or moot.
  await releaseCommitments(supabase, childBatchId);
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
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "conversion: destination belongs to target batch" })
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
        const updates: Record<string, unknown> = { volume_bbl: volumeBbl };
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
