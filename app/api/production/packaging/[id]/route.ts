import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { type, name, supplier, unit_cost, brewery, volume_fl_oz, can_count } = body;

  const { data, error } = await supabase
    .from("packaging_items")
    .update({
      type,
      name,
      supplier: supplier || null,
      unit_cost: unit_cost != null ? parseFloat(unit_cost) : null,
      brewery: brewery || null,
      volume_fl_oz: volume_fl_oz != null ? parseFloat(volume_fl_oz) : null,
      can_count: can_count != null ? parseInt(can_count) : null,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { error } = await supabase.from("packaging_items").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
