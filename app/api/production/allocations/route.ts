import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(req: NextRequest) {
  const batch_id = req.nextUrl.searchParams.get("batch_id");
  if (!batch_id) return NextResponse.json({ error: "batch_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("planned_allocations")
    .select("*")
    .eq("batch_id", batch_id)
    .order("created_at");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { batch_id, label, volume_bbl, notes } = await req.json();
  if (!batch_id || !label || volume_bbl == null) {
    return NextResponse.json({ error: "batch_id, label, and volume_bbl are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("planned_allocations")
    .insert({ batch_id, label, volume_bbl, notes: notes || null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase.from("planned_allocations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
