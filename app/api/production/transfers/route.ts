import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { finalizeConversion, createConversionTargetBatch, reconcileConvertedBatchVolume } from "@/lib/production/conversionFinalizer";
import { computeTankVolumes } from "@/lib/production/volumeLedger";
import { getPaktechUnitsPerPackage } from "@/lib/production/packagingVariations";
import { applyPackagingLoss } from "@/lib/production/packagingMaterials";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

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
}

/**
 * Records exactly one batch_transfers row plus its downstream side effects
 * (packaging deduction, schedule reconciliation, cold-storage inventory).
 * Called once per packaging variation when transfer_type is kegging/canning,
 * or once total for plain transfers/conversions. Side effects after the RPC
 * insert are best-effort (logged, not rolled back) — same convention the
 * pre-existing packaging-deduction code already used.
 */
async function processTransferLine(
  supabase: SupabaseClient,
  line: TransferLineInput
): Promise<{ transfer: Record<string, unknown>; scheduleUpdate: ScheduleUpdateEntry[] }> {
  const { batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, variation_id, quantity, created_by, recipe_id, packaging_loss_pct: packagingLossPct } = line;

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

  // The RPC's signature predates packaging loss, so stamp it on the row it just
  // wrote. Kept off the RPC deliberately: changing that signature would break
  // every other caller for a column only canning cares about.
  if (transfer_type === "canning" && packagingLossPct > 0) {
    await supabase
      .from("batch_transfers")
      .update({ packaging_loss_pct: packagingLossPct })
      .eq("id", transferRow.id);
  }

  // ── Packaging deduction + cold storage inventory ─────────────────────────
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
              batch_transfer_id: transferRow.id, cost_per_unit: null, total_value_change: null,
            });
          }
        }

        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, variation_id, quantity_delta: quantity, source_transfer_id: transferRow.id,
        });

        // Finished goods just arrived. Restate this recipe's Square counts now so
        // the taproom sees the new stock immediately rather than after the
        // nightly push — Square has no other way to learn that beer was packaged.
        // No-ops while the push gate is shut; never throws.
        await triggerSquarePush(supabase, [recipe_id], `canning/kegging batch ${batch_id}`);
      }
    } catch (deductionErr) {
      console.error("[transfers] Packaging deduction / cold storage update failed (transfer committed):", deductionErr);
    }
  }

  // ── Schedule reconciliation ───────────────────────────────────────────────
  const scheduleUpdate = await reconcileSchedule(supabase, { batch_id, from_tank_id, to_tank_id, volume_bbl });

  return { transfer: transfer as Record<string, unknown>, scheduleUpdate };
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
              .update({ actual_end: today, updated_at: new Date().toISOString() })
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
          .update({ volume_bbl: newVol, updated_at: new Date().toISOString() })
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
          .update({ downstream_entry_id: newEntryId, updated_at: new Date().toISOString() })
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
          const updates: Record<string, string | number> = { actual_start: today, updated_at: new Date().toISOString() };
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
            .update({ cancelled_at: new Date().toISOString(), cancellation_reason: `Batch transferred to ${destTankInfo.name} instead`, updated_at: new Date().toISOString() })
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
                updated_at: new Date().toISOString(),
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
            .update({ actual_end: today, updated_at: new Date().toISOString() })
            .eq("id", activeEntry.id);
          scheduleUpdate.push({ action: "actual_end_set", entry_id: activeEntry.id, equipment_name: srcTankInfo.name });

          // Source is now fully drained — if it was feeding a downstream entry that's
          // still accumulating partial arrivals (actual_start set, actual_end open),
          // close that out too, since no more volume is coming from this source.
          if (activeEntry.downstream_entry_id) {
            await supabase
              .from("batch_schedule_entries")
              .update({ actual_end: today, updated_at: new Date().toISOString() })
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
            .update({ volume_bbl: netInTank, updated_at: new Date().toISOString() })
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
          .update({ planned_branch: branchName, updated_at: new Date().toISOString() })
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
              updated_at: new Date().toISOString(),
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

async function upsertColdStorageInventory(
  supabase: SupabaseClient,
  args: { batch_id: string; recipe_id: string | null; variation_id: string; quantity_delta: number; source_transfer_id: string }
) {
  const { batch_id, recipe_id, variation_id, quantity_delta, source_transfer_id } = args;
  const { data: existing } = await supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batch_id)
    .eq("variation_id", variation_id)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("cold_storage_inventory")
      .update({
        quantity_on_hand: Number(existing.quantity_on_hand) + quantity_delta,
        source_transfer_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("cold_storage_inventory").insert({
      batch_id, recipe_id, variation_id,
      quantity_on_hand: quantity_delta, source_transfer_id,
    });
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const { searchParams } = new URL(req.url);
  const batch_id = searchParams.get("batch_id");

  let query = supabase
    .from("batch_transfers")
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type), to_batch:to_batch_id(id, beer_name, batch_number), packaging_variations(id, name), created_by")
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
  };

  // Clamped rather than rejected: the field is advisory shrink accounting, and a
  // nonsense value shouldn't lose the operator an otherwise-valid canning run.
  const packagingLossPct = transfer_type === "canning"
    ? Math.min(100, Math.max(0, Number(body.packaging_loss_pct ?? 0) || 0))
    : 0;

  const { data: batchRow } = await supabase.from("brew_batches").select("recipe_id").eq("id", batch_id).single();
  const recipe_id: string | null = batchRow?.recipe_id ?? null;

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

  for (const line of lines) {
    try {
      const { transfer, scheduleUpdate } = await processTransferLine(supabase, {
        batch_id, from_tank_id, to_tank_id,
        volume_bbl: line.volume_bbl, shrinkage_bbl: line.shrinkage_bbl,
        transfer_type: transfer_type ?? "transfer", notes: notes || null,
        variation_id: line.variation_id, quantity: line.quantity,
        created_by: currentUser?.id ?? null, recipe_id,
        packaging_loss_pct: packagingLossPct,
      });
      transfers.push(transfer);
      allScheduleUpdates.push(...scheduleUpdate);
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

  return NextResponse.json({ transfers, schedule_update: allScheduleUpdates }, { status: 201 });
}
