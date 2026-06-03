import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("recipe_square_links")
    .select("*, recipes(beer_name)")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { recipe_id, packaging, square_variation_id, square_item_id, variation_name, item_name } = await req.json();
  if (!recipe_id || !packaging || !square_variation_id) {
    return NextResponse.json({ error: "recipe_id, packaging, and square_variation_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recipe_square_links")
    .insert({
      recipe_id,
      packaging,
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
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_square_links").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
