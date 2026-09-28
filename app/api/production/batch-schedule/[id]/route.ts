import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CONVERSION_PLAN_SCHEDULE_NOTE, syncPendingPlanVolume } from "@/lib/production/conversionFinalizer";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const { equipment_id, stage, planned_start, planned_end, actual_start, actual_end, notes, cancelled_at, cancellation_reason, downstream_entry_id, volume_bbl } = body;

  const updates: Record<string, unknown> = {};
  if (equipment_id !== undefined) updates.equipment_id = equipment_id;
  if (stage !== undefined) updates.stage = stage;
  if (planned_start !== undefined) updates.planned_start = planned_start;
  if (planned_end !== undefined) updates.planned_end = planned_end;
  if (actual_start !== undefined) updates.actual_start = actual_start;
  if (actual_end !== undefined) updates.actual_end = actual_end;
  if (notes !== undefined) updates.notes = notes;
  if (cancelled_at !== undefined) updates.cancelled_at = cancelled_at;
  if (cancellation_reason !== undefined) updates.cancellation_reason = cancellation_reason;
  if (downstream_entry_id !== undefined) updates.downstream_entry_id = downstream_entry_id;
  if (volume_bbl !== undefined) updates.volume_bbl = volume_bbl;

  // `updated_at` used to seed this object and doubled as the guarantee that it
  // was never empty. The trigger owns the timestamp now, so a body with no
  // recognised field would send an empty update, which PostgREST rejects with a
  // opaque error. Say what actually went wrong instead.
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no updatable fields in request body" }, { status: 400 });
  }

  // Fetch current row before update to detect first-time actual_start on brewhouse
  const { data: before } = await supabase
    .from("batch_schedule_entries")
    .select("stage, batch_id, equipment_id, volume_bbl, actual_start, notes")
    .eq("id", id)
    .single();

  const { data, error } = await supabase
    .from("batch_schedule_entries")
    .update(updates)
    .eq("id", id)
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // When actual_start is set for the first time on a brewhouse entry, record a
  // "backlog → brewing" transfer so the Transfer Log captures the movement.
  const isBrewhouseStart =
    actual_start !== undefined &&
    before?.stage === "brewhouse" &&
    !before?.actual_start &&
    before?.batch_id &&
    before?.equipment_id;

  if (isBrewhouseStart) {
    await supabase.from("batch_transfers").insert({
      batch_id:      before!.batch_id,
      from_tank_id:  null,
      to_tank_id:    before!.equipment_id,
      transfer_type: "brewing",
      volume_bbl:    before!.volume_bbl ?? data?.brew_batches?.volume_bbl ?? null,
      transferred_at: actual_start,
      notes:         "Moved from backlog into brewing",
    });
  }

  // The volume of a planned conversion child's vessel (or its one in-keg run)
  // is the plan's volume: carry the edit to the plan so the source batch's
  // schedule shows the same number. Packaging-entry edits on a tank plan are
  // just a keg/can split and stay local.
  const volumeEdited = volume_bbl != null && Number(volume_bbl) !== Number(before?.volume_bbl ?? NaN);
  if (volumeEdited && before?.notes === CONVERSION_PLAN_SCHEDULE_NOTE && !before.actual_start) {
    const { data: siblings } = await supabase
      .from("batch_schedule_entries").select("stage")
      .eq("batch_id", before.batch_id).eq("notes", CONVERSION_PLAN_SCHEDULE_NOTE).is("cancelled_at", null);
    const hasVessel = (siblings ?? []).some((e) => (e as { stage: string }).stage === "conditioning");
    if (before.stage === "conditioning" || !hasVessel) {
      try {
        await syncPendingPlanVolume(supabase, { childBatchId: before.batch_id, volumeBbl: Number(volume_bbl) });
      } catch (syncErr) {
        console.error("[batch-schedule] Syncing conversion plan volume failed (entry updated):", syncErr);
      }
    }
  }

  // Cascade: when planned_start changes, update the planned_end of any upstream
  // entry that chains into this one (downstream_entry_id = id).
  if (planned_start !== undefined) {
    await supabase
      .from("batch_schedule_entries")
      .update({ planned_end: planned_start })
      .eq("downstream_entry_id", id)
      .is("cancelled_at", null);
  }

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("batch_schedule_entries").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
