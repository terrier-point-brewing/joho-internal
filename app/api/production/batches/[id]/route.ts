import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Whitelist updatable columns — never trust the raw body (prevents
  // overwriting id/batch_number/created_at via mass assignment).
  const UPDATABLE = [
    "beer_name", "planned_brew_date", "expected_delivery_date",
    "volume_bbl", "turns", "status", "notes", "recipe_id",
    "ibu", "color", "original_gravity", "final_gravity", "dissolved_oxygen",
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

  // Log status change if status changed
  if (body.status && current?.status !== body.status) {
    await supabase.from("batch_status_history").insert({
      batch_id: id,
      status: body.status,
      note: body.status_note ?? null,
    });
  }

  const { data, error: fetchErr } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), planned_allocations(*), batch_brew_activity_log(*)")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase.from("brew_batches").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
