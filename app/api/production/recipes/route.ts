import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGenericKegVariationIds } from "@/lib/production/packagingVariations";

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
  try { await requirePermission(CAP.recipesOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { beer_name, style, abv, ibu, partner_id, base_recipe_id, expected_yield_bbl, days_brewhouse, days_fermenter, days_brite, notes, ingredients: lines } = body;

  const { data: recipe, error: recipeErr } = await supabase
    .from("recipes")
    .insert({
      beer_name,
      style: style || null,
      abv: abv ?? null,
      ibu: ibu ?? null,
      partner_id: partner_id || null,
      // Set by Clone, or chosen by hand. The lines below are still the COMPLETE
      // bill — the link only tells a conversion which of them the base already
      // paid for. A DB trigger rejects a base that is itself derived.
      base_recipe_id: base_recipe_id || null,
      expected_yield_bbl: expected_yield_bbl || null,
      days_brewhouse: days_brewhouse || null,
      days_fermenter: days_fermenter || null,
      days_brite: days_brite || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (recipeErr) {
    // The flat-lineage trigger rejects a base that is itself derived; surface it
    // as the operator's choice to fix rather than a server fault.
    const isLineage = recipeErr.message.includes("Cannot base a recipe on");
    return NextResponse.json({ error: recipeErr.message }, { status: isLineage ? 409 : 500 });
  }

  // Link the generic house kegs by default so the draft swap-keg dropdown offers
  // them for this recipe. The dropdown lists only explicitly-linked variations.
  const genericKegIds = await getGenericKegVariationIds(supabase);
  if (genericKegIds.length) {
    const { error: kegLinkErr } = await supabase
      .from("recipe_packaging_variations")
      .insert(genericKegIds.map((variation_id) => ({ recipe_id: recipe.id, variation_id })));
    if (kegLinkErr) return NextResponse.json({ error: kegLinkErr.message }, { status: 500 });
  }

  if (lines?.length) {
    // quantity_per_bbl is derived from quantity_per_turn by trigger.
    const rows = lines.map((l: { ingredient_id: string; quantity_per_turn: number }) => ({
      recipe_id: recipe.id,
      ingredient_id: l.ingredient_id,
      quantity_per_turn: l.quantity_per_turn,
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
