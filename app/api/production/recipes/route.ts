import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipes")
    .select("*, partner:contract_brewing_partners(company_name), recipe_ingredients(*, ingredients(*)), recipe_brew_activity_templates:brew_activities(*)")
    .order("beer_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { beer_name, partner_id, expected_yield_bbl, days_brewhouse, days_fermenter, days_brite, notes, ingredients: lines } = body;

  const { data: recipe, error: recipeErr } = await supabase
    .from("recipes")
    .insert({
      beer_name,
      partner_id: partner_id || null,
      expected_yield_bbl: expected_yield_bbl || null,
      days_brewhouse: days_brewhouse || null,
      days_fermenter: days_fermenter || null,
      days_brite: days_brite || null,
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
    .select("*, partner:contract_brewing_partners(company_name), recipe_ingredients(*, ingredients(*)), recipe_brew_activity_templates:brew_activities(*)")
    .eq("id", recipe.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
