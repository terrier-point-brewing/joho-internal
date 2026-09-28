import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { planInPlaceSwitches, recordInPlaceSwitches, type ConditioningScheduleRow } from "@/lib/production/inPlaceConditioning";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const includeCanc = req.nextUrl.searchParams.get("include_cancelled") === "true";
  let query = supabase
    .from("batch_schedule_entries")
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .order("planned_start", { ascending: true })
    .order("planned_end", { ascending: true });
  if (!includeCanc) query = query.is("cancelled_at", null);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Conditioning in the same fermenter starts on its planned date without
  // anyone confirming it. Recorded here, the first time the schedule is read
  // on or after that date, and backdated to it — so no cron timing matters.
  const today = new Date().toISOString().split("T")[0];
  const switches = planInPlaceSwitches((data ?? []) as ConditioningScheduleRow[], today);
  if (switches.length > 0) {
    try {
      const recorded = await recordInPlaceSwitches(createSupabaseAdminClient(), switches);
      const byId = new Map((data ?? []).map((e) => [e.id as string, e as Record<string, unknown>]));
      for (const s of recorded) {
        const f = byId.get(s.fermentingId);
        const c = byId.get(s.conditioningId);
        if (f) Object.assign(f, { actual_end: s.switchDate, downstream_entry_id: s.conditioningId, ...(s.fermentingVolumeBbl != null ? { volume_bbl: s.fermentingVolumeBbl } : {}) });
        if (c) Object.assign(c, { actual_start: s.switchDate, ...(s.conditioningVolumeBbl != null ? { volume_bbl: s.conditioningVolumeBbl } : {}) });
      }
    } catch (err) {
      console.error("[batch-schedule] In-place conditioning switch failed:", err);
    }
  }
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { batch_id, equipment_id, stage, planned_start, planned_end, actual_start, actual_end, notes, downstream_entry_id, volume_bbl, planned_branch } = body;

  if (!batch_id || !stage || !planned_start || !planned_end) {
    return NextResponse.json({ error: "batch_id, stage, planned_start, planned_end are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("batch_schedule_entries")
    .insert({ batch_id, equipment_id: equipment_id || null, stage, planned_start, planned_end, actual_start: actual_start || null, actual_end: actual_end || null, notes: notes || null, downstream_entry_id: downstream_entry_id || null, volume_bbl: volume_bbl ?? null, planned_branch: planned_branch ?? null })
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
