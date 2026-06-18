import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const { equipment_id, stage, planned_start, planned_end, actual_start, actual_end, notes, cancelled_at, cancellation_reason, downstream_entry_id, volume_bbl } = body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
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

  const { data, error } = await supabase
    .from("batch_schedule_entries")
    .update(updates)
    .eq("id", id)
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Cascade: when planned_start changes, update the planned_end of any upstream
  // entry that chains into this one (downstream_entry_id = id).
  if (planned_start !== undefined) {
    await supabase
      .from("batch_schedule_entries")
      .update({ planned_end: planned_start, updated_at: new Date().toISOString() })
      .eq("downstream_entry_id", id)
      .is("cancelled_at", null);
  }

  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("batch_schedule_entries").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
