import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { beer_name, style, target_volume_bbl, notes, ingredients: lines } = await req.json();

  const { error: recipeErr } = await supabase
    .from("recipes")
    .update({ beer_name, style: style || null, target_volume_bbl: target_volume_bbl || null, notes: notes || null })
    .eq("id", id);

  if (recipeErr) return NextResponse.json({ error: recipeErr.message }, { status: 500 });

  if (lines !== undefined) {
    await supabase.from("recipe_ingredients").delete().eq("recipe_id", id);
    if (lines.length > 0) {
      const rows = lines.map((l: { ingredient_id: string; quantity_per_bbl: number }) => ({
        recipe_id: id,
        ingredient_id: l.ingredient_id,
        quantity_per_bbl: l.quantity_per_bbl,
      }));
      const { error: lineErr } = await supabase.from("recipe_ingredients").insert(rows);
      if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });
    }
  }

  const { data, error } = await supabase
    .from("recipes")
    .select("*, recipe_ingredients(*, ingredients(*))")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase.from("recipes").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
