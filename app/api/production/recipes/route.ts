import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("recipes")
    .select("*, recipe_ingredients(*, ingredients(*))")
    .order("beer_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { beer_name, brewery, expected_yield_bbl, steps, notes, ingredients: lines } = body;

  const { data: recipe, error: recipeErr } = await supabase
    .from("recipes")
    .insert({
      beer_name,
      brewery: brewery || null,
      expected_yield_bbl: expected_yield_bbl || null,
      steps: steps || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (recipeErr) return NextResponse.json({ error: recipeErr.message }, { status: 500 });

  if (lines?.length) {
    const rows = lines.map((l: { ingredient_id: string; quantity_per_bbl: number }) => ({
      recipe_id: recipe.id,
      ingredient_id: l.ingredient_id,
      quantity_per_bbl: l.quantity_per_bbl,
    }));
    const { error: lineErr } = await supabase.from("recipe_ingredients").insert(rows);
    if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("recipes")
    .select("*, recipe_ingredients(*, ingredients(*))")
    .eq("id", recipe.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
