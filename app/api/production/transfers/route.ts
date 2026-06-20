import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

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
  kegging_detail: { packaging_id: string; name: string; volume_fl_oz: number | null; quantity: number; variant_label: string } | null;
  canning_detail: Record<string, unknown> | null;
  created_by: string | null;
  recipe_id: string | null;
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
  const { batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, kegging_detail, canning_detail, created_by, recipe_id } = line;

  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:       batch_id,
      p_from_tank_id:   from_tank_id  || null,
      p_to_tank_id:     to_tank_id    || null,
      p_volume_bbl:     volume_bbl,
      p_shrinkage_bbl:  shrinkage_bbl ?? 0,
      p_transfer_type:  transfer_type ?? "transfer",
      p_notes:          notes         || null,
      p_kegging_detail: kegging_detail ?? null,
      p_canning_detail: canning_detail ?? null,
      p_created_by:     created_by ?? null,
    })
    .single();

  if (error) {
    const status = error.message.includes("already occupied") ? 409 : 500;
    throw Object.assign(new Error(error.message), { status });
  }

  const transferRow = transfer as { id: string };

  // ── Packaging deduction + cold storage inventory ─────────────────────────
  try {
    if (transfer_type === "kegging" && kegging_detail) {
      const { packaging_id, quantity, variant_label } = kegging_detail;
      if (packaging_id && quantity) {
        const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", packaging_id).single();
        if (pkg) {
          const newQty = Number(pkg.stock_quantity) - quantity;
          await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", packaging_id);
          await supabase.from("packaging_stock_adjustments").insert({
            packaging_item_id: packaging_id, quantity: -quantity, type: "used",
            note: `Kegging — batch ${batch_id}`, batch_transfer_id: transferRow.id,
            cost_per_unit: null, total_value_change: null,
          });
        }
        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, packaging_item_id: packaging_id, variant_label,
          quantity_delta: quantity, source_transfer_id: transferRow.id,
        });
      }
    }

    if (transfer_type === "canning" && canning_detail) {
      const cd = canning_detail as {
        format: "case" | "pack" | "loose";
        can_packaging_id?: string; lid_packaging_id?: string | null;
        paktech_packaging_id?: string; tray_packaging_id?: string; label_packaging_id?: string | null;
        cans_per_case?: number; cans_per_pack?: number; quantity: number; variant_label: string;
      };
      const cansPerUnit = cd.format === "case" ? (cd.cans_per_case ?? 0) : cd.format === "pack" ? (cd.cans_per_pack ?? 0) : 1;
      const totalCans = cd.quantity * cansPerUnit;

      const deductions: { id: string | null | undefined; qty: number; label: string }[] = [
        { id: cd.can_packaging_id,   qty: totalCans, label: "cans" },
        { id: cd.lid_packaging_id,   qty: totalCans, label: "lids" },
        { id: cd.label_packaging_id, qty: totalCans, label: "labels" },
      ];
      if (cd.format === "case") deductions.push({ id: cd.tray_packaging_id, qty: cd.quantity, label: "trays" });
      if (cd.format === "pack")  deductions.push({ id: cd.paktech_packaging_id, qty: cd.quantity, label: "paktechs" });

      for (const d of deductions) {
        if (!d.id || !d.qty) continue;
        const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", d.id).single();
        if (pkg) {
          const newQty = Number(pkg.stock_quantity) - d.qty;
          await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
          await supabase.from("packaging_stock_adjustments").insert({
            packaging_item_id: d.id, quantity: -d.qty, type: "used",
            note: `Canning (${d.label}) — batch ${batch_id}`, batch_transfer_id: transferRow.id,
            cost_per_unit: null, total_value_change: null,
          });
        }
      }

      if (cd.can_packaging_id) {
        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, packaging_item_id: cd.can_packaging_id, variant_label: cd.variant_label,
          quantity_delta: cd.quantity, source_transfer_id: transferRow.id,
        });
      }
    }
  } catch (deductionErr) {
    console.error("[transfers] Packaging deduction / cold storage update failed (transfer committed):", deductionErr);
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
        if (priorFerment && priorFerment.length > 0) targetStage = "conditioning";
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
            await supabase
              .from("batch_schedule_entries")
              .update({ volume_bbl: newVol, updated_at: new Date().toISOString() })
              .eq("id", openEntry.id);
            remaining -= deducted;
          }
        }
      }
      }
    }
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
      // We'll compute remaining volume AFTER this transfer using the full ledger
      const { data: allLedger } = await supabase
        .from("batch_transfers")
        .select("from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl")
        .eq("batch_id", batch_id)
        .or(`from_tank_id.eq.${from_tank_id},to_tank_id.eq.${from_tank_id}`);

      const netInSrc = (allLedger ?? []).reduce((sum, row) => {
        if (row.to_tank_id === from_tank_id) return sum + Number(row.volume_bbl);
        if (row.from_tank_id === from_tank_id) return sum - Number(row.volume_bbl) - Number(row.shrinkage_bbl ?? 0);
        return sum;
      }, 0);

      if (netInSrc <= 0.001) {
        // Tank is drained — close out the active schedule entry. Resolve the
        // stage from the actual open entry on this equipment rather than type
        // alone, since a fermenter may be hosting fermenting OR conditioning.
        const candidateStages = srcTankInfo.type === "fermenter"
          ? ["fermenting", "conditioning"]
          : [EQ_TYPE_TO_STAGE[srcTankInfo.type]];

        const { data: activeEntries } = await supabase
          .from("batch_schedule_entries")
          .select("id, downstream_entry_id")
          .eq("batch_id", batch_id)
          .in("stage", candidateStages)
          .eq("equipment_id", from_tank_id)
          .is("cancelled_at", null)
          .is("actual_end", null)
          .limit(1);

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
  // Compute remaining volume from the ledger rather than brew_batches.volume_bbl
  // so that chains of prior partial draws are accounted for correctly.
  if (from_tank_id) {
    const { data: ledgerRows } = await supabase
      .from("batch_transfers")
      .select("from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl")
      .eq("batch_id", batch_id)
      .or(`from_tank_id.eq.${from_tank_id},to_tank_id.eq.${from_tank_id}`);

    const netInTank = (ledgerRows ?? []).reduce((sum, row) => {
      if (row.to_tank_id   === from_tank_id) return sum + Number(row.volume_bbl);
      if (row.from_tank_id === from_tank_id) return sum - Number(row.volume_bbl) - Number(row.shrinkage_bbl ?? 0);
      return sum;
    }, 0);

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
  args: { batch_id: string; recipe_id: string | null; packaging_item_id: string; variant_label: string; quantity_delta: number; source_transfer_id: string }
) {
  const { batch_id, recipe_id, packaging_item_id, variant_label, quantity_delta, source_transfer_id } = args;
  const { data: existing } = await supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batch_id)
    .eq("packaging_item_id", packaging_item_id)
    .eq("variant_label", variant_label)
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
      batch_id, recipe_id, packaging_item_id, variant_label,
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
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type), to_batch:to_batch_id(id, beer_name, batch_number), created_by")
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
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    transfer_type,
    notes,
    kegging_lines,
    canning_lines,
  } = body as {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion";
    notes: string | null;
    volume_bbl?: number;
    shrinkage_bbl?: number;
    kegging_lines?: { packaging_id: string; quantity: number }[];
    canning_lines?: Record<string, unknown>[];
  };

  const { data: batchRow } = await supabase.from("brew_batches").select("recipe_id").eq("id", batch_id).single();
  const recipe_id: string | null = batchRow?.recipe_id ?? null;

  // ── Build one line per packaging variation (or a single line for plain transfers/conversions) ──
  type Line = { volume_bbl: number; shrinkage_bbl: number; kegging_detail: TransferLineInput["kegging_detail"]; canning_detail: TransferLineInput["canning_detail"] };
  const lines: Line[] = [];
  const totalShrinkage = Number(body.shrinkage_bbl ?? 0);

  if (transfer_type === "kegging" && kegging_lines?.length) {
    const pkgIds = kegging_lines.map((l) => l.packaging_id);
    const { data: pkgRows } = await supabase.from("packaging_items").select("id, name, volume_fl_oz").in("id", pkgIds);
    const pkgMap = new Map((pkgRows ?? []).map((p) => [p.id, p]));
    const totalVolume = kegging_lines.reduce((sum, l) => {
      const pkg = pkgMap.get(l.packaging_id);
      return sum + (pkg?.volume_fl_oz ? (l.quantity * pkg.volume_fl_oz) / BBL_TO_FL_OZ : 0);
      }, 0);
    let allocatedShrinkage = 0;
    kegging_lines.forEach((l, idx) => {
      const pkg = pkgMap.get(l.packaging_id);
      const lineVolume = pkg?.volume_fl_oz ? (l.quantity * pkg.volume_fl_oz) / BBL_TO_FL_OZ : 0;
      const isLast = idx === kegging_lines.length - 1;
      const shrinkShare = isLast ? totalShrinkage - allocatedShrinkage : Math.round((totalVolume > 0 ? (lineVolume / totalVolume) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      lines.push({
        volume_bbl: lineVolume,
        shrinkage_bbl: shrinkShare,
        kegging_detail: { packaging_id: l.packaging_id, name: pkg?.name ?? "", volume_fl_oz: pkg?.volume_fl_oz ?? null, quantity: l.quantity, variant_label: pkg?.name ?? "Keg" },
        canning_detail: null,
      });
    });
  } else if (transfer_type === "canning" && canning_lines?.length) {
    const totalCanUnits = canning_lines.reduce((sum, l) => sum + Number((l as { quantity: number }).quantity), 0);
    let allocatedShrinkage = 0;
    for (let idx = 0; idx < canning_lines.length; idx++) {
      const raw = canning_lines[idx] as { format: "case" | "pack" | "loose"; quantity: number; can_packaging_id: string; cans_per_case?: number; cans_per_pack?: number };
      const { data: canPkg } = await supabase.from("packaging_items").select("volume_fl_oz").eq("id", raw.can_packaging_id).single();
      const cansPerUnit = raw.format === "case" ? (raw.cans_per_case ?? 0) : raw.format === "pack" ? (raw.cans_per_pack ?? 0) : 1;
      const lineVolume = canPkg?.volume_fl_oz ? (raw.quantity * cansPerUnit * canPkg.volume_fl_oz) / BBL_TO_FL_OZ : 0;
      const isLast = idx === canning_lines.length - 1;
      const shrinkShare = isLast ? totalShrinkage - allocatedShrinkage : Math.round((totalCanUnits > 0 ? (raw.quantity / totalCanUnits) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      const variantLabel = raw.format === "case" ? `Case (${raw.cans_per_case}ct)` : raw.format === "pack" ? `${raw.cans_per_pack}-Pack` : "Loose Can";
      lines.push({
        volume_bbl: lineVolume,
        shrinkage_bbl: shrinkShare,
        kegging_detail: null,
        canning_detail: { ...raw, variant_label: variantLabel },
      });
    }
  } else {
    lines.push({
      volume_bbl: Number(body.volume_bbl ?? 0),
      shrinkage_bbl: totalShrinkage,
      kegging_detail: null,
      canning_detail: null,
    });
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
        kegging_detail: line.kegging_detail, canning_detail: line.canning_detail,
        created_by: currentUser?.id ?? null, recipe_id,
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

  return NextResponse.json({ transfers, schedule_update: allScheduleUpdates }, { status: 201 });
}
