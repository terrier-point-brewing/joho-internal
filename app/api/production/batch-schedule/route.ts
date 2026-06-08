import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(req: NextRequest) {
  const includeCanc = req.nextUrl.searchParams.get("include_cancelled") === "true";
  let query = supabase
    .from("batch_schedule_entries")
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .order("planned_start", { ascending: true });
  if (!includeCanc) query = query.is("cancelled_at", null);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { batch_id, equipment_id, stage, planned_start, planned_end, actual_start, actual_end, notes } = body;

  if (!batch_id || !stage || !planned_start || !planned_end) {
    return NextResponse.json({ error: "batch_id, stage, planned_start, planned_end are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("batch_schedule_entries")
    .insert({ batch_id, equipment_id: equipment_id || null, stage, planned_start, planned_end, actual_start: actual_start || null, actual_end: actual_end || null, notes: notes || null })
    .select(`*, brew_batches(id, beer_name, batch_number, volume_bbl, status), equipment(id, name, type)`)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
