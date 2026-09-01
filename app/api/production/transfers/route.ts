import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { finalizeConversion, createConversionTargetBatch, completeConversionChild, reconcileConvertedBatchVolume } from "@/lib/production/conversionFinalizer";
import { consumeConversionAdditions, isChargeableConversion } from "@/lib/production/conversionIngredients";
import { computeTankVolumes } from "@/lib/production/volumeLedger";
import { getPaktechUnitsPerPackage } from "@/lib/production/packagingVariations";
import { applyPackagingLoss } from "@/lib/production/packagingMaterials";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";
import { upsertColdStorageInventory } from "@/lib/production/coldStorageUpsert";

export const dynamic = "force-dynamic";

type ScheduleUpdateEntry = { action: string; entry_id: string; equipment_name?: string; was_deviation?: boolean };

interface TransferLineInput {
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: string;
  notes: string | null;
  variation_id: string | null;
  quantity: number | null;
  created_by: string | null;
  recipe_id: string | null;
  /** Canning loss %, applied to containers/lids/labels. Ignored for other types. */
  packaging_loss_pct: number;
  /**
   * Set on the conversion row of an in-keg/in-can conversion — the recipe the
   * run produced. Provenance only: the finished goods themselves now live on a
   * conversion-born child batch whose recipe IS that beer.
   */
  packaged_as_recipe_id?: string | null;
  /**
   * Skip schedule reconciliation for this row. Set on the packaging rows of an
   * in-keg conversion: they belong to the conversion-born child batch, which
   * has no schedule and must never acquire a tank assignment on the packaging
   * station. The SOURCE batch's conversion row reconciles the schedule for the
   * whole run instead.
   */
  skipSchedule?: boolean;
}

/**
 * Records exactly one batch_transfers row plus its downstream side effects
 * (cold-storage inventory, packaging deduction, schedule reconciliation).
 * Called once per packaging variation when transfer_type is kegging/canning,
 * or once total for plain transfers/conversions.
 *
 * Two tiers of side effect, deliberately not the same tier:
 *
 *  - COLD STORAGE is the beer. Its failure is caught only so the committed
 *    transfer row is not orphaned by a thrown 500 the operator would answer by
 *    re-submitting and double-booking the run — but it is then reported back
 *    through `coldStorageError` and stamped on the transfer row, never merely
 *    logged. Nobody should be able to lose finished goods quietly.
 *  - Everything else (lids, trays, the Square push, the schedule) is
 *    best-effort: logged, not rolled back, same convention as before.
 */
async function processTransferLine(
  supabase: SupabaseClient,
  line: TransferLineInput
): Promise<{ transfer: Record<string, unknown>; scheduleUpdate: ScheduleUpdateEntry[]; coldStorageError: string | null }> {
  const { batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, variation_id, quantity, created_by, recipe_id, packaging_loss_pct: packagingLossPct, packaged_as_recipe_id, skipSchedule } = line;

  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:      batch_id,
      p_from_tank_id:  from_tank_id || null,
      p_to_tank_id:    to_tank_id   || null,
      p_volume_bbl:    volume_bbl,
      p_shrinkage_bbl: shrinkage_bbl ?? 0,
      p_transfer_type: transfer_type ?? "transfer",
      p_notes:         notes || null,
      p_variation_id:  variation_id ?? null,
      p_quantity:       quantity ?? null,
      p_created_by:    created_by ?? null,
    })
    .single();

  if (error) {
    const status = error.message.includes("already occupied") ? 409 : 500;
    throw Object.assign(new Error(error.message), { status });
  }

  const transferRow = transfer as { id: string };

  // The RPC's signature predates both of these, so stamp them on the row it just
  // wrote. Kept off the RPC deliberately: changing that signature would break
  // every other caller for columns only packaging runs care about.
  const postInsertPatch: Record<string, unknown> = {};
  if (transfer_type === "canning" && packagingLossPct > 0) postInsertPatch.packaging_loss_pct = packagingLossPct;
  if (packaged_as_recipe_id) postInsertPatch.packaged_as_recipe_id = packaged_as_recipe_id;
  if (Object.keys(postInsertPatch).length > 0) {
    await supabase.from("batch_transfers").update(postInsertPatch).eq("id", transferRow.id);
  }

  // ── Cold storage: the finished goods themselves ──────────────────────────
  // Runs FIRST, and outside the packaging-materials try/catch, for two reasons.
  // It needs nothing from the packaging_variations row, so a failure to load
  // that row must not be able to skip it; and its own failure must not be
  // indistinguishable from a miscounted lid.
  let coldStorageError: string | null = null;
  if (variation_id && quantity) {
    try {
      await upsertColdStorageInventory(supabase, {
        batchId: batch_id, recipeId: recipe_id, variationId: variation_id,
        quantityDelta: quantity, sourceTransferId: transferRow.id,
      });
    } catch (coldErr) {
      coldStorageError = (coldErr as Error).message;
      console.error(
        `[transfers] COLD STORAGE NOT BOOKED — ${quantity} unit(s) from transfer ${transferRow.id} (batch ${batch_id}) are physically in the room and absent from the books:`,
        coldErr,
      );
      // A durable trace on the record of production itself, so this is
      // answerable later from the transfer log rather than only from whichever
      // Vercel log window happened to still be open.
      const stamp = `⚠ Cold storage NOT booked (${quantity} unit(s)): ${coldStorageError}`;
      await supabase
        .from("batch_transfers")
        .update({ notes: notes ? `${notes}\n${stamp}` : stamp })
        .eq("id", transferRow.id);
    }
  }

  // ── Packaging materials deduction ────────────────────────────────────────
  if (variation_id && quantity) {
    try {
      const { data: variation } = await supabase
        .from("packaging_variations")
        .select("id, format, container_id, lid_id, paktech_id, tray_id, label_id, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(volume_fl_oz)")
        .eq("id", variation_id)
        .single();

      if (variation) {
        const containerVolume = (variation.container as unknown as { volume_fl_oz: number | null })?.volume_fl_oz ?? 0;
        const unitsPerPackage = containerVolume > 0 ? variation.total_volume_fl_oz / containerVolume : 1;
        const totalUnits = quantity * unitsPerPackage;
        // A case packs several paktech'd bundles into one tray, so paktechs
        // consumed per case outnumber trays consumed per case (unlike a bare
        // 4-pack/6-pack, where the package IS the paktech'd bundle).
        const paktechUnitsPerPackage = await getPaktechUnitsPerPackage(supabase, {
          format: variation.format, tray_id: variation.tray_id, paktech_id: variation.paktech_id,
        });

        // A canning run spoils some cans outright — mis-fills, bad seams, torn
        // labels — and a spoiled can takes its lid and label with it. Grow those
        // three by the run's loss %, rounded to whole units, so inventory
        // reflects what actually left the shelf. Paktechs and trays are consumed
        // per package, not per can, so they never carry the loss.
        const lossPct = transfer_type === "canning" ? packagingLossPct : 0;
        const lossAdjustedUnits = applyPackagingLoss(Math.round(totalUnits), lossPct);

        const deductions: { id: string | null; qty: number; label: string }[] = [
          { id: variation.container_id, qty: lossAdjustedUnits, label: "container" },
          { id: variation.lid_id,       qty: lossAdjustedUnits, label: "lids" },
          { id: variation.label_id,     qty: lossAdjustedUnits, label: "labels" },
          { id: variation.tray_id,      qty: quantity,    label: "trays" },
          { id: variation.paktech_id,   qty: quantity * paktechUnitsPerPackage, label: "paktechs" },
        ];

        for (const d of deductions) {
          if (!d.id || !d.qty) continue;
          const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", d.id).single();
          if (pkg) {
            const newQty = Number(pkg.stock_quantity) - d.qty;
            await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
            await supabase.from("packaging_stock_adjustments").insert({
              packaging_item_id: d.id, quantity: -d.qty, type: "used",
              note: `${transfer_type === "kegging" ? "Kegging" : "Canning"} (${d.label}) — batch ${batch_id}`,
              batch_transfer_id: transferRow.id, cost_per_unit_usd: null, total_value_change_usd: null,
            });
          }
        }

        // Finished goods just arrived. Restate this recipe's Square counts now so
        // the taproom sees the new stock immediately rather than after the
        // nightly push — Square has no other way to learn that beer was packaged.
        // No-ops while the push gate is shut; never throws.
        await triggerSquarePush(supabase, [recipe_id], `canning/kegging batch ${batch_id}`);
      }
    } catch (deductionErr) {
      console.error("[transfers] Packaging materials deduction failed (transfer committed):", deductionErr);
    }
  }

  // ── Schedule reconciliation ───────────────────────────────────────────────
  const scheduleUpdate = skipSchedule
    ? []
    : await reconcileSchedule(supabase, { batch_id, from_tank_id, to_tank_id, volume_bbl });

  return { transfer: transfer as Record<string, unknown>, scheduleUpdate, coldStorageError };
}

async function reconcileSchedule(
  supabase: SupabaseClient,
  { batch_id, from_tank_id, to_tank_id, volume_bbl }: { batch_id: string; from_tank_id: string | null; to_tank_id: string | null; volume_bbl: number }
): Promise<ScheduleUpdateEntry[]> {
  // When beer arrives in a tracked tank type, update or create the matching
  // schedule entry so actuals are recorded.
  // When beer leaves a fermenter or brite and the tank drains, close out the entry.
  // Kegging/canning entries are stamped with actual_start = actual_end = today
  // because packaging is a point-in-time event, not an ongoing occupancy.
  const RECONCILE_TYPES = new Set(["brewhouse", "fermenter", "brite", "kegging", "canning"]);
  // Maps equipment.type → stage key stored in batch_schedule_entries
  const EQ_TYPE_TO_STAGE: Record<string, string> = {
    brewhouse: "brewhouse",
    fermenter: "fermenting",   // NOTE: stage name is "fermenting", not "fermenter"
    brite:     "conditioning",
    kegging:   "kegging",
    canning:   "canning",
  };
  // Packaging stages are instantaneous — both start and end are stamped on arrival.
  const PACKAGING_STAGES = new Set(["kegging", "canning"]);

  const scheduleUpdate: {
    action: string;
    entry_id: string;
    equipment_name?: string;
    was_deviation?: boolean;
  }[] = [];

  const today = new Date().toISOString().split("T")[0];

  // Tracks the newly created/updated destination entry and its tank type
  // so the partial-transfer section can annotate it as a split branch.
  let arrivedEntryId:   string | null = null;
  let arrivedTankType:  string | null = null;
  let arrivedStageResolved: string | null = null;

  // 1. Handle arrival (to_tank is fermenter or brite)
  if (to_tank_id) {
    const { data: destTankInfo } = await supabase
      .from("equipment")
      .select("id, name, type")
      .eq("id", to_tank_id)
      .single();

    if (destTankInfo && RECONCILE_TYPES.has(destTankInfo.type)) {
      arrivedTankType = destTankInfo.type;
      let targetStage = EQ_TYPE_TO_STAGE[destTankInfo.type];

      // A fermenter can also be used to host Conditioning (in place of a brite
      // tank). If this batch has already completed a fermenting stage, arriving
      // in another fermenter means it's being used for conditioning instead.
      if (destTankInfo.type === "fermenter") {
        const { data: priorFerment } = await supabase
          .from("batch_schedule_entries")
          .select("id")
          .eq("batch_id", batch_id)
          .eq("stage", "fermenting")
          .not("actual_start", "is", null)
          .is("cancelled_at", null)
          .limit(1);
        if (priorFerment && priorFerment.length > 0) {
          targetStage = "conditioning";
          // Same-tank ferment → condition: close the open fermenting entry here
          // because the departure block won't fire (tank never fully drains).
          if (from_tank_id === to_tank_id) {
            await supabase
              .from("batch_schedule_entries")
              .update({ actual_end: today })
              .eq("batch_id", batch_id)
              .eq("stage", "fermenting")
              .eq("equipment_id", to_tank_id)
              .is("cancelled_at", null)
              .is("actual_end", null);
          }
        }
      }
      arrivedStageResolved = targetStage;
      const isPackagingStageEarly = PACKAGING_STAGES.has(destTankInfo.type);

      // Priority 0 (non-packaging only): if this exact equipment already has an
      // *active* (started, not yet ended) entry for this batch+stage, this arrival
      // is a continuation of a partial transfer already in progress — top up the
      // existing entry's volume rather than re-matching/creating another one.
      let accumulating: { id: string; volume_bbl: number | null } | null = null;
      if (!isPackagingStageEarly) {
        const { data: activeOnTank } = await supabase
          .from("batch_schedule_entries")
          .select("id, volume_bbl")
          .eq("batch_id", batch_id)
          .eq("stage", targetStage)
          .eq("equipment_id", to_tank_id)
          .is("cancelled_at", null)
          .not("actual_start", "is", null)
          .is("actual_end", null)
          .limit(1);
        accumulating = activeOnTank?.[0] ?? null;
      }

      // Look for an existing uncancelled entry for this batch+stage. Packaging
      // (kegging/canning) is point-in-time and can recur multiple times for a
      // batch, so only an entry that hasn't already been fulfilled counts as
      // "the plan this transfer satisfies" — otherwise every run after the
      // first would incorrectly re-stamp the same already-completed entry.
      let existingQuery = supabase
        .from("batch_schedule_entries")
        .select("id, equipment_id, planned_start, planned_end, actual_start, actual_end, downstream_entry_id, volume_bbl")
        .eq("batch_id", batch_id)
        .eq("stage", targetStage)
        .is("cancelled_at", null)
        .order("planned_start", { ascending: true })
        .limit(1);
      if (isPackagingStageEarly) existingQuery = existingQuery.is("actual_start", null);
      const { data: existingEntries } = accumulating ? { data: null } : await existingQuery;

      const existing = existingEntries?.[0];

      if (accumulating) {
        const newVol = Number(accumulating.volume_bbl ?? 0) + Number(volume_bbl ?? 0);
        await supabase
          .from("batch_schedule_entries")
          .update({ volume_bbl: newVol })
          .eq("id", accumulating.id);
        arrivedEntryId = accumulating.id;
        scheduleUpdate.push({ action: "accumulated", entry_id: accumulating.id, equipment_name: destTankInfo.name, was_deviation: false });
      } else {

      // Helper: upstream stage whose downstream_entry_id should point to this stage's entry
      const upstreamStage = targetStage === "fermenting" ? "brewhouse" : targetStage === "conditioning" ? "fermenting" : null;

      async function wireUpstreamChain(newEntryId: string) {
        if (!upstreamStage) return;
        await supabase
          .from("batch_schedule_entries")
          .update({ downstream_entry_id: newEntryId })
          .eq("batch_id", batch_id)
          .eq("stage", upstreamStage)
          .is("cancelled_at", null);
      }

      const isPackagingStage = PACKAGING_STAGES.has(destTankInfo.type);

      if (existing) {
        if (existing.equipment_id === to_tank_id) {
          // Same tank as planned — stamp actual_start (and actual_end for packaging).
          // Sync volume_bbl to what was actually transferred so far, since the
          // plan's volume_bbl otherwise stays stale at the original estimate.
          // For non-packaging stages this also seeds the baseline that later
          // partial-arrival top-ups (the "accumulating" branch above) add onto.
          const updates: Record<string, string | number> = { actual_start: today };
          if (isPackagingStage) {
            updates.actual_end = today;
            if (volume_bbl != null) updates.volume_bbl = volume_bbl;
          } else if (volume_bbl != null) {
            updates.volume_bbl = volume_bbl;
          }
          await supabase
            .from("batch_schedule_entries")
            .update(updates)
            .eq("id", existing.id);
          arrivedEntryId = existing.id;
          scheduleUpdate.push({ action: "actual_start_set", entry_id: existing.id, equipment_name: destTankInfo.name, was_deviation: false });
          // Ensure upstream chain is wired (may have been missing before)
          await wireUpstreamChain(existing.id);
        } else {
          // Different tank — cancel the original and create a new entry for the actual tank
          const durationMs = new Date(existing.planned_end).getTime() - new Date(existing.planned_start).getTime();
          const durationDays = Math.max(1, Math.round(durationMs / 86400000));
          const newEnd = isPackagingStage ? today : new Date(Date.now() + durationDays * 86400000).toISOString().split("T")[0];

          await supabase
            .from("batch_schedule_entries")
            .update({ cancelled_at: new Date().toISOString(), cancellation_reason: `Batch transferred to ${destTankInfo.name} instead` })
            .eq("id", existing.id);

          const { data: newEntry } = await supabase
            .from("batch_schedule_entries")
            .insert({
              batch_id, equipment_id: to_tank_id, stage: targetStage,
              planned_start: today, planned_end: newEnd,
              actual_start: today, actual_end: isPackagingStage ? today : null,
              volume_bbl: volume_bbl ?? null,
              downstream_entry_id: existing.downstream_entry_id ?? null,
              notes: `Auto-created: deviation from planned equipment`,
            })
            .select("id")
            .single();

          if (newEntry) { arrivedEntryId = newEntry.id; await wireUpstreamChain(newEntry.id); }
          scheduleUpdate.push({ action: "deviation_rebooked", entry_id: newEntry?.id ?? "", equipment_name: destTankInfo.name, was_deviation: true });
        }
      } else {
        // No open entry matched — for packaging this means an unscheduled
        // additional kegging/canning run. Record it, then claw its volume back
        // out of whichever future packaging is still unfulfilled: try the next
        // open kegging entry first, then canning. If nothing is left to deduct
        // from, the run goes unaccounted for and planning-status will flag it
        // as incomplete (computeBranchPackagingStatus picks this up downstream).
        const defaultDays = targetStage === "fermenting" ? 14 : targetStage === "conditioning" ? 21 : 1;
        const newEnd = isPackagingStage ? today : new Date(Date.now() + defaultDays * 86400000).toISOString().split("T")[0];
        const { data: newEntry } = await supabase
          .from("batch_schedule_entries")
          .insert({
            batch_id, equipment_id: to_tank_id, stage: targetStage,
            planned_start: today, planned_end: newEnd,
            actual_start: today, actual_end: isPackagingStage ? today : null,
            volume_bbl: isPackagingStage ? (volume_bbl ?? null) : null,
            notes: isPackagingStage ? `Unscheduled additional ${targetStage}` : `Auto-created on transfer`,
          })
          .select("id")
          .single();
        if (newEntry) { arrivedEntryId = newEntry.id; await wireUpstreamChain(newEntry.id); }
        scheduleUpdate.push({ action: "created", entry_id: newEntry?.id ?? "", equipment_name: destTankInfo.name, was_deviation: false });

        if (isPackagingStage && volume_bbl != null) {
          let remaining = Number(volume_bbl);
          for (const deductStage of ["kegging", "canning"] as const) {
            if (remaining <= 0) break;
            const { data: openEntries } = await supabase
              .from("batch_schedule_entries")
              .select("id, volume_bbl")
              .eq("batch_id", batch_id)
              .eq("stage", deductStage)
              .is("cancelled_at", null)
              .is("actual_start", null)
              .order("planned_start", { ascending: true })
              .limit(1);
            const openEntry = openEntries?.[0];
            if (!openEntry || openEntry.volume_bbl == null) continue;
            const newVol = Math.max(0, Number(openEntry.volume_bbl) - remaining);
            const deducted = Number(openEntry.volume_bbl) - newVol;
            // An entry clawed all the way to zero has no volume left to package,
            // so it is not a pending action any more. Cancelling it here is what
            // keeps it out of the Floorplan's "Up Next" banner — leaving it open
            // stranded ghosts that advertised a canning run for months after the
            // batch finished (see 20260831_cancel_fulfilled_packaging_ghosts).
            const exhausted = newVol <= 0.001;
            await supabase
              .from("batch_schedule_entries")
              .update({
                volume_bbl: newVol,
                ...(exhausted ? {
                  cancelled_at: new Date().toISOString(),
                  cancellation_reason: "Volume fulfilled by other packaging runs",
                } : {}),
              })
              .eq("id", openEntry.id);
            remaining -= deducted;
          }
        }
      }
      }
    }
  }

  // Shared remaining-volume-per-tank snapshot for from_tank_id, reused by both
  // the departure-close check below and the partial-transfer reassignment
  // further down (previously each ran its own ad hoc ledger reducer, which
  // diverged from the client's math). Delegates to the same computeTankVolumes
  // used client-side — including its seed for a batch whose current tank was
  // never recorded via an inbound transfer (e.g. a direct tank assignment) —
  // so a partial draw from such a tank doesn't compute a false "fully drained"
  // and silently drop the floorplan tile (the RPC always releases the from_tank
  // assignment; see the reassignment block below).
  let tankVolsForSrc: Record<string, number> = {};
  if (from_tank_id) {
    const { data: batchVolRow } = await supabase.from("brew_batches").select("volume_bbl").eq("id", batch_id).single();
    const { data: allBatchLedger } = await supabase
      .from("batch_transfers")
      .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at")
      .or(`batch_id.eq.${batch_id},to_batch_id.eq.${batch_id}`);
    tankVolsForSrc = computeTankVolumes(batch_id, Number(batchVolRow?.volume_bbl ?? 0), allBatchLedger ?? []);
  }

  // 2. Handle departure (from_tank drains to zero — close out its schedule entry).
  // Only applies to tanks with ongoing occupancy (brewhouse/fermenter/brite);
  // kegging/canning entries are already closed at arrival time.
  if (from_tank_id) {
    const { data: srcTankInfo } = await supabase
      .from("equipment")
      .select("id, name, type")
      .eq("id", from_tank_id)
      .single();

    if (srcTankInfo && RECONCILE_TYPES.has(srcTankInfo.type) && !PACKAGING_STAGES.has(srcTankInfo.type)) {
      const netInSrc = tankVolsForSrc[from_tank_id] ?? 0;

      if (netInSrc <= 0.001) {
        // Tank is drained — close out the active schedule entry. Resolve the
        // stage from the actual open entry on this equipment rather than type
        // alone, since a fermenter may be hosting fermenting OR conditioning.
        const candidateStages = srcTankInfo.type === "fermenter"
          ? ["fermenting", "conditioning"]
          : [EQ_TYPE_TO_STAGE[srcTankInfo.type]];

        // Same-tank stage changes (e.g. fermenting -> conditioning while staying
        // in the same fermenter) create/update a destination entry on this exact
        // equipment_id in the arrival block above (arrivedEntryId), which would
        // also match this stage+equipment filter since it's already open with
        // actual_end null. Excluding it ensures we close the OLD (source) entry
        // rather than racing and closing the brand-new one — which previously
        // left the original entry stuck open forever, doubling its reconstructed
        // "departed" volume in the equipment schedule graph.
        let activeEntryQuery = supabase
          .from("batch_schedule_entries")
          .select("id, downstream_entry_id")
          .eq("batch_id", batch_id)
          .in("stage", candidateStages)
          .eq("equipment_id", from_tank_id)
          .is("cancelled_at", null)
          .is("actual_end", null)
          .order("actual_start", { ascending: true })
          .limit(1);
        if (arrivedEntryId) activeEntryQuery = activeEntryQuery.neq("id", arrivedEntryId);
        const { data: activeEntries } = await activeEntryQuery;

        const activeEntry = activeEntries?.[0];
        if (activeEntry) {
          await supabase
            .from("batch_schedule_entries")
            .update({ actual_end: today })
            .eq("id", activeEntry.id);
          scheduleUpdate.push({ action: "actual_end_set", entry_id: activeEntry.id, equipment_name: srcTankInfo.name });

          // Source is now fully drained — if it was feeding a downstream entry that's
          // still accumulating partial arrivals (actual_start set, actual_end open),
          // close that out too, since no more volume is coming from this source.
          if (activeEntry.downstream_entry_id) {
            await supabase
              .from("batch_schedule_entries")
              .update({ actual_end: today })
              .eq("id", activeEntry.downstream_entry_id)
              .is("cancelled_at", null)
              .not("actual_start", "is", null)
              .is("actual_end", null);
          }
        }
      }
    }
  }

  // Partial-transfer: the RPC always releases the from_tank assignment, but if
  // volume remains in the source tank we need to re-insert the assignment so the
  // floorplan tile keeps showing the batch there.
  //
  // Reuses the tankVolsForSrc snapshot computed above (same computeTankVolumes
  // math as the client) rather than a from-scratch ledger reducer, so chains of
  // prior partial draws — and batches whose current tank was never recorded via
  // an inbound transfer — are accounted for correctly.
  if (from_tank_id) {
    const netInTank = tankVolsForSrc[from_tank_id] ?? 0;

    if (netInTank > 0.001) {
      const { error: reassignErr } = await supabase
        .from("batch_tank_assignments")
        .insert({ batch_id, tank_id: from_tank_id });
      // 23505 = active assignment already exists (acceptable for in-progress partial transfers).
      if (reassignErr && reassignErr.code !== "23505") {
        throw Object.assign(new Error(reassignErr.message), { status: 500 });
      }

      // Keep the source schedule entry's volume_bbl in sync with remaining volume.
      const { data: srcInfo } = await supabase
        .from("equipment")
        .select("type")
        .eq("id", from_tank_id)
        .maybeSingle();
      const srcCandidateStages = srcInfo?.type === "fermenter"
        ? ["fermenting", "conditioning"]
        : srcInfo ? [EQ_TYPE_TO_STAGE[srcInfo.type]] : [];
      let resolvedSrcStage: string | null = null;
      if (srcCandidateStages.length > 0 && !PACKAGING_STAGES.has(srcInfo!.type)) {
        const { data: srcActiveEntry } = await supabase
          .from("batch_schedule_entries")
          .select("id, stage")
          .eq("batch_id", batch_id)
          .in("stage", srcCandidateStages)
          .eq("equipment_id", from_tank_id)
          .is("cancelled_at", null)
          .is("actual_end", null)
          .limit(1)
          .maybeSingle();
        resolvedSrcStage = srcActiveEntry?.stage ?? null;
        if (resolvedSrcStage) {
          await supabase
            .from("batch_schedule_entries")
            .update({ volume_bbl: netInTank })
            .eq("id", srcActiveEntry!.id);
        }
      }

      // If the destination resolved to the same logical stage as the source
      // (e.g. brite → brite, or brite → fermenter-as-conditioning), this is a
      // same-stage split. Annotate the destination entry with a planned_branch
      // and create packaging ghosts for the new branch.
      const isSameStageSplit =
        arrivedEntryId &&
        resolvedSrcStage &&
        arrivedStageResolved === resolvedSrcStage &&
        !PACKAGING_STAGES.has(arrivedTankType ?? "");

      if (isSameStageSplit) {
        // Count existing planned_branch names to generate the next branch number
        const { data: existingBranches } = await supabase
          .from("batch_schedule_entries")
          .select("planned_branch")
          .eq("batch_id", batch_id)
          .not("planned_branch", "is", null)
          .is("cancelled_at", null);
        const branchNums = (existingBranches ?? [])
          .map(r => { const m = String(r.planned_branch).match(/(\d+)$/); return m ? Number(m[1]) : 0; });
        const nextNum   = (branchNums.length > 0 ? Math.max(...branchNums) : 0) + 1;
        const branchName = `Split ${nextNum}`;

        // Mark the arrived destination entry as the new split branch
        await supabase
          .from("batch_schedule_entries")
          .update({ planned_branch: branchName })
          .eq("id", arrivedEntryId!);

        // Scale source branch (main) downstream packaging proportionally
        const totalPreSplit = netInTank + Number(volume_bbl ?? 0);
        const srcRatio = totalPreSplit > 0 ? netInTank / totalPreSplit : 1;
        const { data: srcPkgEntries } = await supabase
          .from("batch_schedule_entries")
          .select("id, volume_bbl")
          .eq("batch_id", batch_id)
          .in("stage", ["kegging", "canning"])
          .is("planned_branch", null)
          .is("cancelled_at", null);
        if (srcPkgEntries?.length) {
          await Promise.all(srcPkgEntries.map(e =>
            supabase.from("batch_schedule_entries").update({
              volume_bbl: Math.round(Number(e.volume_bbl) * srcRatio * 100) / 100,
            }).eq("id", e.id),
          ));
        }

        // Create kegging + canning ghost entries for the new branch
        const splitVol = Number(volume_bbl ?? 0);
        const kegVol   = Math.round(splitVol * 0.7 * 100) / 100;
        const canVol   = Math.round((splitVol - kegVol) * 100) / 100;
        for (const [stage, vol] of [["kegging", kegVol], ["canning", canVol]] as const) {
          await supabase.from("batch_schedule_entries").insert({
            batch_id,
            stage,
            equipment_id:   null,
            planned_start:  today,
            planned_end:    today,
            volume_bbl:     vol,
            planned_branch: branchName,
            notes:          `Auto-created packaging for ${branchName}`,
          });
        }

        scheduleUpdate.push({ action: "split_branch_created", entry_id: arrivedEntryId!, equipment_name: branchName });
      }
    }
  }

  return scheduleUpdate;
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const { searchParams } = new URL(req.url);
  const batch_id = searchParams.get("batch_id");

  let query = supabase
    .from("batch_transfers")
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type), to_batch:to_batch_id(id, beer_name, batch_number), packaged_as:packaged_as_recipe_id(beer_name), packaging_variations(id, name), created_by")
    .order("transferred_at", { ascending: false });

  if (batch_id) query = query.eq("batch_id", batch_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve actor emails via profiles (auth.users FK is not in PostgREST schema cache).
  const actorIds = [...new Set((data ?? []).map((r) => r.created_by).filter(Boolean))];
  let profileMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", actorIds);
    profileMap = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.email]));
  }

  const enriched = (data ?? []).map((r) => ({
    ...r,
    created_by_profile: r.created_by ? { email: profileMap[r.created_by] ?? null } : null,
  }));

  return NextResponse.json(enriched);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    to_batch_id,
    transfer_type,
    notes,
    packaging_lines,
    new_batch,
    packaged_as_recipe_id,
    packaged_as_commitment_id,
  } = body as {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    to_batch_id?: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion" | "brewing";
    notes: string | null;
    volume_bbl?: number;
    shrinkage_bbl?: number;
    packaging_lines?: { variation_id: string; quantity: number }[];
    packaging_loss_pct?: number;
    new_batch?: { beer_name: string; recipe_id: string } | null;
    /** In-keg/in-can conversion: the recipe this packaging run produced. */
    packaged_as_recipe_id?: string | null;
    /**
     * Optional, in-keg conversion only: the commitment this run serves. The
     * conversion-born child gets a 100% allocation against it — the same shape
     * a tank conversion's operator would make by hand — so the kegs can be
     * credited when they ship instead of landing as over-delivery.
     */
    packaged_as_commitment_id?: string | null;
  };

  // Clamped rather than rejected: the field is advisory shrink accounting, and a
  // nonsense value shouldn't lose the operator an otherwise-valid canning run.
  const packagingLossPct = transfer_type === "canning"
    ? Math.min(100, Math.max(0, Number(body.packaging_loss_pct ?? 0) || 0))
    : 0;

  const { data: batchRow } = await supabase.from("brew_batches").select("recipe_id").eq("id", batch_id).single();
  const batchRecipeId: string | null = batchRow?.recipe_id ?? null;

  // ── In-keg conversion ──────────────────────────────────────────────────────
  // Some conversions have no tank of their own: the ginger and lime go in as the
  // brite tank empties into kegs, so the batch is Pace Yourself Pilsner right up
  // to the filler and Carolina Mule the moment the keg is capped.
  //
  // The run still produces a BATCH. Every commercial reader — allocations,
  // shipment crediting, deposits, fulfillment — keys on brew_batches, so a beer
  // with no batch cannot be allocated, credited or deposit-billed, and its kegs
  // ship flagged over_allocation (the Orange Pilsner 1/2 keg of 2026-08-31).
  // So the flag births a conversion child, exactly the shape a tank conversion
  // leaves behind, minus the vessel: one conversion row moves the volume off the
  // source, the packaging rows land on the child, and the child completes
  // immediately — born in the container.
  //
  // From here on, `recipe_id` IS the beer that came out of the filler: it drives
  // the packaging-variation gate, the cold-storage rows, and the Square push.
  const isPackagingRun = transfer_type === "kegging" || transfer_type === "canning";
  const packagedAs = isPackagingRun ? (packaged_as_recipe_id || null) : null;

  if (packagedAs) {
    if (!batchRecipeId) {
      return NextResponse.json({ error: "Batch has no recipe — it cannot be converted while packaging." }, { status: 422 });
    }
    // The source's recipe must sit above the packaged one in the lineage chain,
    // or there is no way to tell which of the packaged bill's lines the batch
    // already paid for at the brewhouse — the same rule a tank conversion obeys.
    if (!(await isChargeableConversion(supabase, batchRecipeId, packagedAs))) {
      return NextResponse.json(
        { error: "That beer is not a conversion of this batch's recipe. Link it under Recipes → Based On first." },
        { status: 422 },
      );
    }
  }

  // The commitment an in-keg conversion serves, validated before anything is
  // written so a stale id rejects the run cleanly rather than after the fact.
  let inKegCommitment: { id: string; partner_id: string; channel: string } | null = null;
  if (packagedAs && packaged_as_commitment_id) {
    const { data: commitmentRow } = await supabase
      .from("commitments")
      .select("id, recipe_id, partner_id, channel")
      .eq("id", packaged_as_commitment_id)
      .maybeSingle();
    const c = commitmentRow as { id: string; recipe_id: string | null; partner_id: string | null; channel: string | null } | null;
    if (!c) {
      return NextResponse.json({ error: "That commitment no longer exists." }, { status: 422 });
    }
    if (c.recipe_id !== packagedAs) {
      return NextResponse.json({ error: "That commitment is for a different beer than this run produces." }, { status: 422 });
    }
    if (!c.partner_id || c.channel === "taproom") {
      return NextResponse.json({ error: "That commitment has no partner to allocate to." }, { status: 422 });
    }
    inKegCommitment = { id: c.id, partner_id: c.partner_id, channel: c.channel ?? "contract_brewing" };
  }

  const recipe_id: string | null = packagedAs ?? batchRecipeId;

  // ── Build one line per packaging variation (or a single line for plain transfers/conversions) ──
  type Line = { volume_bbl: number; shrinkage_bbl: number; variation_id: string | null; quantity: number | null };
  const lines: Line[] = [];
  const totalShrinkage = Number(body.shrinkage_bbl ?? 0);

  if ((transfer_type === "kegging" || transfer_type === "canning") && packaging_lines?.length) {
    // ── Strict-consumption gate: every submitted variation must be declared for this recipe ──
    if (!recipe_id) {
      return NextResponse.json({ error: "Batch has no recipe — packaging variations cannot be resolved." }, { status: 422 });
    }
    const { data: declaredRows } = await supabase
      .from("recipe_packaging_variations")
      .select("variation_id")
      .eq("recipe_id", recipe_id);
    const declaredIds = new Set((declaredRows ?? []).map((r) => r.variation_id));

    // Generic variations (no partner_id) are auto-available to every recipe
    // without an explicit recipe_packaging_variations link — but only for
    // kegging. Canning has no such fallback: every can variation must be
    // explicitly declared via recipe_packaging_variations.
    let genericIds = new Set<string>();
    if (transfer_type === "kegging") {
      const { data: genericRows } = await supabase
        .from("packaging_variations")
        .select("id")
        .is("partner_id", null)
        .eq("is_active", true);
      genericIds = new Set((genericRows ?? []).map((r) => r.id));
    }

    const acceptedIds = new Set([...declaredIds, ...genericIds]);
    if (acceptedIds.size === 0) {
      return NextResponse.json(
        { error: `This recipe has no packaging variations declared — add one in Recipes → Packaging Variations before ${transfer_type}.` },
        { status: 422 }
      );
    }
    const variationIds = packaging_lines.map((l) => l.variation_id);
    const undeclared = variationIds.filter((id) => !acceptedIds.has(id));
    if (undeclared.length > 0) {
      return NextResponse.json(
        {
          error: transfer_type === "kegging"
            ? `Variation ${undeclared[0]} is not declared for this recipe and is not a generic variation.`
            : `Variation ${undeclared[0]} is not declared for this recipe. Canning requires an explicit recipe_packaging_variations link.`,
        },
        { status: 422 }
      );
    }

    const { data: variationRows } = await supabase
      .from("packaging_variations")
      .select("id, total_volume_fl_oz")
      .in("id", variationIds);
    const volumeById = new Map((variationRows ?? []).map((v) => [v.id, v.total_volume_fl_oz as number]));

    const totalVolume = packaging_lines.reduce((sum, l) => {
      const totalFlOz = volumeById.get(l.variation_id) ?? 0;
      return sum + (l.quantity * totalFlOz) / BBL_TO_FL_OZ;
    }, 0);

    let allocatedShrinkage = 0;
    packaging_lines.forEach((l, idx) => {
      const totalFlOz = volumeById.get(l.variation_id) ?? 0;
      const lineVolume = (l.quantity * totalFlOz) / BBL_TO_FL_OZ;
      const isLast = idx === packaging_lines.length - 1;
      const shrinkShare = isLast
        ? totalShrinkage - allocatedShrinkage
        : Math.round((totalVolume > 0 ? (lineVolume / totalVolume) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      lines.push({ volume_bbl: lineVolume, shrinkage_bbl: shrinkShare, variation_id: l.variation_id, quantity: l.quantity });
    });
  } else {
    lines.push({ volume_bbl: Number(body.volume_bbl ?? 0), shrinkage_bbl: totalShrinkage, variation_id: null, quantity: null });
  }

  const totalVolumeForCapacityCheck = lines.reduce((s, l) => s + l.volume_bbl, 0);

  // Zero-volume guard: moving no beer INTO a tank is never a real event. Worse,
  // it is silently destructive — the source tank keeps its whole ledger volume,
  // so the partial-transfer branch in reconcileSchedule re-inserts the source
  // assignment and the batch ends up occupying two tanks at once (B-059 landed
  // in both B-1 and fermenter 14 this way on 2026-08-21).
  //
  // Deliberately keyed on to_tank_id, not from_tank_id: a dump or write-off
  // leaves via shrinkage with no destination, and must stay allowed.
  if (to_tank_id && totalVolumeForCapacityCheck <= 0) {
    return NextResponse.json(
      { error: "Transfer volume must be greater than zero." },
      { status: 422 }
    );
  }

  // Capacity guard: reject before writing anything if destination is a
  // constrained tank and the total transfer volume exceeds its capacity_bbl.
  if (to_tank_id && totalVolumeForCapacityCheck > 0) {
    const { data: destTank } = await supabase.from("equipment").select("capacity_bbl, type").eq("id", to_tank_id).single();
    const UNCONSTRAINED = new Set(["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"]);
    if (destTank && !UNCONSTRAINED.has(destTank.type) && destTank.capacity_bbl != null && totalVolumeForCapacityCheck > destTank.capacity_bbl) {
      return NextResponse.json(
        { error: `Transfer volume (${totalVolumeForCapacityCheck} BBL) exceeds destination capacity (${destTank.capacity_bbl} BBL).` },
        { status: 422 }
      );
    }
  }

  const transfers: Record<string, unknown>[] = [];
  const allScheduleUpdates: ScheduleUpdateEntry[] = [];
  const coldStorageErrors: string[] = [];

  if (packagedAs) {
    // ── In-keg conversion: birth the child, then package under it ────────────
    // Order matters. The child must exist before the conversion row can point at
    // it; the conversion row goes in before the packaging rows so the ledger
    // never shows finished goods for a batch that received no volume. Nothing
    // after the conversion row rolls it back — same convention as everywhere
    // else in this route: committed movements are the record of production.
    const { data: packagedRecipe } = await supabase
      .from("recipes").select("beer_name").eq("id", packagedAs).single();

    // A pre-planned in-keg conversion already has its child waiting: a pending
    // batch_conversions row whose target is a pre-brew batch of the packaged
    // recipe. Resolving onto it keeps the plan's identity (and releases what it
    // reserved) instead of minting a duplicate child next to it. Oldest plan
    // first, so two planned runs of the same beer resolve in order.
    let childBatchId: string | null = null;
    let plannedConversionId: string | null = null;
    {
      const { data: pendingPlans } = await supabase
        .from("batch_conversions")
        .select("id, target_batch_id, target:brew_batches!target_batch_id(recipe_id, status)")
        .eq("source_batch_id", batch_id)
        .is("converted_at", null)
        .order("created_at", { ascending: true });
      for (const plan of pendingPlans ?? []) {
        const target = plan.target as unknown as { recipe_id: string | null; status: string | null } | null;
        if (target?.recipe_id === packagedAs && (target.status === "planning" || target.status === "backlog")) {
          childBatchId = plan.target_batch_id as string;
          plannedConversionId = plan.id as string;
          break;
        }
      }
    }

    if (childBatchId) {
      // The plan's volume was an estimate; the filler's is the fact.
      await supabase.from("brew_batches")
        .update({
          volume_bbl:              totalVolumeForCapacityCheck,
          converted_volume_bbl:    totalVolumeForCapacityCheck,
          converted_from_batch_id: batch_id,
        })
        .eq("id", childBatchId);
      await supabase.from("batch_conversions")
        .update({ converted_at: new Date().toISOString() })
        .eq("id", plannedConversionId!);
    } else {
      try {
        childBatchId = await createConversionTargetBatch(supabase, {
          sourceBatchId: batch_id,
          beerName:      packagedRecipe?.beer_name ?? "Converted batch",
          recipeId:      packagedAs,
          volumeBbl:     totalVolumeForCapacityCheck,
        });
      } catch (createErr) {
        return NextResponse.json({ error: (createErr as Error).message }, { status: 500 });
      }
    }

    // Serve the declared commitment: the whole child is that partner's beer.
    // Best-effort once the child exists — a failed allocation must not unmake
    // the run; the operator can add it by hand exactly as for a tank conversion.
    if (inKegCommitment) {
      const { error: allocErr } = await supabase.from("batch_allocations").insert({
        batch_id:            childBatchId,
        channel:             inKegCommitment.channel,
        percentage:          100,
        partner_id:          inKegCommitment.partner_id,
        contract_request_id: inKegCommitment.id,
        notes:               "Auto: in-keg conversion packaged for this commitment",
      });
      if (allocErr) {
        console.error("[transfers] In-keg conversion allocation failed (run continues):", allocErr);
      }
    }

    // One conversion row on the SOURCE carries the whole run's draw — delivered
    // volume plus shrinkage — and reconciles the source's schedule exactly as
    // the old per-line kegging rows did (station arrival, clawback, partial
    // reassignment of the source tank).
    let conversionRowId: string | null = null;
    try {
      const { transfer, scheduleUpdate } = await processTransferLine(supabase, {
        batch_id, from_tank_id, to_tank_id,
        volume_bbl: totalVolumeForCapacityCheck, shrinkage_bbl: totalShrinkage,
        transfer_type: "conversion", notes: notes || null,
        variation_id: null, quantity: null,
        created_by: currentUser?.id ?? null, recipe_id: batchRecipeId,
        packaging_loss_pct: 0,
        packaged_as_recipe_id: packagedAs,
      });
      conversionRowId = (transfer as { id?: string }).id ?? null;
      transfers.push(transfer);
      allScheduleUpdates.push(...scheduleUpdate);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return NextResponse.json(
        { error: (e as Error).message, transfers_committed: transfers.length },
        { status }
      );
    }
    if (conversionRowId) {
      await supabase.from("batch_transfers")
        .update({ to_batch_id: childBatchId })
        .eq("id", conversionRowId);
    }

    // The packaging rows belong to the CHILD: cold storage, materials and the
    // Square push all key on it, which is what puts the finished goods under
    // the beer that actually came out of the filler. from = the packaging
    // station (where the conversion delivered), to = nowhere — the child's
    // station ledger nets to zero instead of showing beer parked there forever.
    // No schedule reconciliation: the child has no schedule, and the partial-
    // transfer reassignment would otherwise hand it the station as a tank.
    for (const line of lines) {
      try {
        const { transfer, coldStorageError } = await processTransferLine(supabase, {
          batch_id: childBatchId, from_tank_id: to_tank_id, to_tank_id: null,
          volume_bbl: line.volume_bbl, shrinkage_bbl: 0,
          transfer_type: transfer_type ?? "transfer", notes: notes || null,
          variation_id: line.variation_id, quantity: line.quantity,
          created_by: currentUser?.id ?? null, recipe_id,
          packaging_loss_pct: packagingLossPct,
          skipSchedule: true,
        });
        transfers.push(transfer);
        if (coldStorageError) coldStorageErrors.push(coldStorageError);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return NextResponse.json(
          { error: (e as Error).message, transfers_committed: transfers.length },
          { status }
        );
      }
    }

    // Charge what the dose added — the same path a tank conversion takes, filed
    // against the child. Never rolls back the committed packaging.
    try {
      const additions = await consumeConversionAdditions(supabase, {
        sourceBatchId: batch_id,
        targetBatchId: childBatchId,
        volumeBbl:     totalVolumeForCapacityCheck,
      });
      if (additions.status === "unlinked") {
        console.info("[transfers] In-keg conversion additions not charged — recipes are not linked.");
      }
    } catch (additionsErr) {
      console.error("[transfers] In-keg conversion additions failed (packaging committed):", additionsErr);
    }

    // The child is born fully packaged, so it completes on the spot — directly,
    // not via batch_exhaustion, whose 2dp headline volume can miss the view's
    // tolerance by rounding alone. The source completes when its own ledger
    // says so, conversion included.
    try {
      await completeConversionChild(supabase, childBatchId);
      await checkAndCompleteBatch(supabase, batch_id);
    } catch (completionErr) {
      console.error("[transfers] Batch completion check failed:", completionErr);
    }
  } else {
    for (const line of lines) {
      try {
        const { transfer, scheduleUpdate, coldStorageError } = await processTransferLine(supabase, {
          batch_id, from_tank_id, to_tank_id,
          volume_bbl: line.volume_bbl, shrinkage_bbl: line.shrinkage_bbl,
          transfer_type: transfer_type ?? "transfer", notes: notes || null,
          variation_id: line.variation_id, quantity: line.quantity,
          created_by: currentUser?.id ?? null, recipe_id,
          packaging_loss_pct: packagingLossPct,
        });
        transfers.push(transfer);
        allScheduleUpdates.push(...scheduleUpdate);
        if (coldStorageError) coldStorageErrors.push(coldStorageError);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return NextResponse.json(
          { error: (e as Error).message, transfers_committed: transfers.length },
          { status }
        );
      }
    }

    // ── Auto-complete: batch is done when all volume is kegged/canned/shrinkage ─
    if (transfer_type === "kegging" || transfer_type === "canning") {
      try {
        await checkAndCompleteBatch(supabase, batch_id);
      } catch (completionErr) {
        console.error("[transfers] Batch completion check failed:", completionErr);
      }
    }
  }

  // ── Conversion side effects ────────────────────────────────────────────────
  if (transfer_type === "conversion" && (to_batch_id || new_batch) && transfers.length > 0) {
    const convertedVol = Number(body.volume_bbl ?? 0);

    // Resolve the target batch: an existing one, or a brand-new batch created inline.
    let targetBatchId = to_batch_id ?? null;
    if (!targetBatchId && new_batch?.beer_name && new_batch?.recipe_id) {
      try {
        targetBatchId = await createConversionTargetBatch(supabase, {
          sourceBatchId: batch_id,
          beerName:      new_batch.beer_name,
          recipeId:      new_batch.recipe_id,
          volumeBbl:     convertedVol,
        });
      } catch (createErr) {
        return NextResponse.json({ error: (createErr as Error).message }, { status: 500 });
      }
    }

    if (targetBatchId) {
      const transferId = (transfers[0] as { id?: string }).id;
      if (transferId) {
        await supabase.from("batch_transfers").update({ to_batch_id: targetBatchId }).eq("id", transferId);
      }
      // Mark any pre-planned batch_conversions record as executed (no-op for ad-hoc new batches).
      await supabase
        .from("batch_conversions")
        .update({ converted_at: new Date().toISOString() })
        .eq("source_batch_id", batch_id)
        .eq("target_batch_id", targetBatchId)
        .is("converted_at", null);

      // Reconcile the target's headline volume to what the conversion actually
      // delivered (planned − shrinkage), so its Volume Breakdown balances instead
      // of showing a permanent shrinkage-sized phantom. No-op for the inline
      // new_batch path (already born at the delivered volume) and for blended
      // targets. Never rolls back the committed transfer on failure.
      try {
        await reconcileConvertedBatchVolume(supabase, targetBatchId);
      } catch (reconcileErr) {
        console.error("[transfers] Converted-batch volume reconcile failed (transfer committed):", reconcileErr);
      }

      // Charge what the conversion ADDS — the puree, the oranges, the coffee —
      // and nothing the parent batch already paid for at the brewhouse. Only a
      // target whose recipe names this source as its base is charged; an
      // unlinked pair is left alone, because guessing which lines the parent
      // covered is worse than either answer. Runs after the volume reconcile so
      // the deduction is sized on the liquid that actually arrived, and never
      // rolls back the committed transfer.
      try {
        const additions = await consumeConversionAdditions(supabase, {
          sourceBatchId: batch_id,
          targetBatchId,
          volumeBbl:     convertedVol,
        });
        if (additions.status === "unlinked") {
          console.info("[transfers] Conversion additions not charged — recipes are not linked.");
        }
      } catch (additionsErr) {
        console.error("[transfers] Conversion additions failed (transfer committed):", additionsErr);
      }

      // Hand the destination tank to the target batch and complete the exhausted
      // source — record_batch_transfer + reconcileSchedule attribute the dest
      // occupancy to the SOURCE, which is wrong for conversions.
      try {
        await finalizeConversion(supabase, {
          sourceBatchId: batch_id,
          targetBatchId,
          fromTankId:    from_tank_id,
          toTankId:      to_tank_id,
          volumeBbl:     convertedVol,
          today:         new Date().toISOString().split("T")[0],
        });
      } catch (finalizeErr) {
        console.error("[transfers] Conversion finalize failed (transfer committed):", finalizeErr);
      }
    }
  }

  // 201, not 500, even when cold storage failed: the batch_transfers rows are
  // committed and are the record of production. A 500 here reads as "the run did
  // not happen" and the operator's next move is to submit it again, which
  // double-books the beer. So the run is reported as recorded and the missing
  // inventory is handed back as a warning the caller must not swallow.
  return NextResponse.json(
    {
      transfers,
      schedule_update: allScheduleUpdates,
      ...(coldStorageErrors.length > 0 ? { cold_storage_errors: coldStorageErrors } : {}),
    },
    { status: 201 },
  );
}
