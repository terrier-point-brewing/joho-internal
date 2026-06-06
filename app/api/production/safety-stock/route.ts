import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("safety_stock_floors")
    .select("*")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// Upsert a floor for a (recipe_id, packaging) pair.
export async function POST(req: NextRequest) {
  const { recipe_id, packaging, floor_quantity } = await req.json();
  if (!recipe_id || !packaging || floor_quantity == null) {
    return NextResponse.json({ error: "recipe_id, packaging, and floor_quantity are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("safety_stock_floors")
    .upsert({ recipe_id, packaging, floor_quantity }, { onConflict: "recipe_id,packaging" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("safety_stock_floors").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
