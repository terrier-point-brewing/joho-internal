import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Fetch current status to detect changes
  const { data: current } = await supabase
    .from("brew_batches")
    .select("status")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("brew_batches")
    .update(body)
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
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), planned_allocations(*)")
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
