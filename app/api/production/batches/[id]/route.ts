import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();

  // Whitelist updatable columns — never trust the raw body (prevents
  // overwriting id/batch_number/created_at via mass assignment).
  const UPDATABLE = [
    "beer_name", "planned_brew_date", "expected_delivery_date",
    "volume_bbl", "turns", "status", "notes", "recipe_id",
    "ibu", "color_srm", "original_gravity", "final_gravity", "dissolved_oxygen_ppb",
  ] as const;
  const updates: Record<string, unknown> = {};
  for (const col of UPDATABLE) {
    if (col in body) updates[col] = body[col];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updatable fields provided" }, { status: 400 });
  }

  // Fetch current status to detect changes
  const { data: current } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("brew_batches")
    .update(updates)
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const newStatus: string | undefined = body.status;
  const statusChanged = newStatus && current?.status !== newStatus;

  // Log status change
  if (statusChanged) {
    await supabase.from("batch_status_history").insert({
      batch_id: id,
      status: newStatus,
      note: body.status_note ?? null,
    });
  }

  // Archive cascade: release operational records but preserve financial ones.
  if (statusChanged && newStatus === "archived") {
    // Release any active tank assignments — tank is no longer occupied.
    await supabase
      .from("batch_tank_assignments")
      .update({ released_at: new Date().toISOString() })
      .eq("batch_id", id)
      .is("released_at", null);

    // Cancel open schedule entries that haven't actually ended yet.
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "batch archived" })
      .eq("batch_id", id)
      .is("cancelled_at", null)
      .is("actual_end", null);

    // batch_allocations, batch_exports, batch_transfers, batch_status_history,
    // and batch_brew_activity_log are intentionally left untouched — they are
    // financial or historical records and must not be invalidated on archive.
  }

  const { data, error: fetchErr } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_brew_activity_log(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hard delete is admin-only. All child records cascade via FK constraints.
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const { error } = await supabase.from("brew_batches").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
