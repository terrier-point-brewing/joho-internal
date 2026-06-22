import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("safety_stock_floors")
    .select("*")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// Upsert a floor for a (recipe_id, packaging) pair.
export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

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
  try { await requireRole([]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("safety_stock_floors").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
