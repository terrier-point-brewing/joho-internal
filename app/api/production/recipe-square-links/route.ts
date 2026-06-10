import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_square_links")
    .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz)")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { recipe_id, packaging, packaging_item_id, square_variation_id, square_item_id, variation_name, item_name } = await req.json();
  if (!recipe_id || !packaging || !square_variation_id) {
    return NextResponse.json({ error: "recipe_id, packaging, and square_variation_id are required" }, { status: 400 });
  }

  // For keg/can packaging_item_id is required; draft is fine without it.
  if ((packaging === "keg" || packaging === "can") && !packaging_item_id) {
    return NextResponse.json({ error: "packaging_item_id is required for keg and can links" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recipe_square_links")
    .insert({
      recipe_id,
      packaging,
      packaging_item_id: packaging_item_id || null,
      square_variation_id,
      square_item_id: square_item_id || null,
      variation_name: variation_name || null,
      item_name: item_name || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_square_links").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
