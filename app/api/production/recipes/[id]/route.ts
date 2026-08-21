import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resyncRecipeCommitments } from "@/lib/production/commitments";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.recipesOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const { beer_name, style, abv, ibu, partner_id, expected_yield_bbl, days_brewhouse, days_fermenter, days_brite, notes, ingredients: lines } = body;

  const updates: Record<string, unknown> = {
    beer_name,
    style: style || null,
    abv: abv ?? null,
    ibu: ibu ?? null,
    partner_id: partner_id || null,
    expected_yield_bbl: expected_yield_bbl || null,
    days_brewhouse: days_brewhouse || null,
    days_fermenter: days_fermenter || null,
    days_brite: days_brite || null,
    notes: notes || null,
  };

  // Lineage moves only when the caller says so. Every other field above is
  // written unconditionally because the recipe form always sends the full set,
  // but Break link is a one-field PATCH and a partial save from anywhere else
  // must not quietly sever a link it never mentioned.
  if ("base_recipe_id" in body) {
    updates.base_recipe_id = body.base_recipe_id || null;
  }

  const { error: recipeErr } = await supabase
    .from("recipes")
    .update(updates)
    .eq("id", id);

  if (recipeErr) {
    // The flat-lineage trigger rejects a chain (basing on an already-derived
    // recipe, or deriving one that others are based on) with its own message.
    // That is the operator's problem to fix, not a server fault.
    const isLineage = recipeErr.message.includes("Cannot base a recipe on")
      || recipeErr.message.includes("Cannot make");
    return NextResponse.json({ error: recipeErr.message }, { status: isLineage ? 409 : 500 });
  }

  if (lines !== undefined) {
    await supabase.from("recipe_ingredients").delete().eq("recipe_id", id);
    if (lines.length > 0) {
      // quantity_per_bbl is derived from quantity_per_turn by trigger.
      const rows = lines.map((l: { ingredient_id: string; quantity_per_turn: number }) => ({
        recipe_id: id,
        ingredient_id: l.ingredient_id,
        quantity_per_turn: l.quantity_per_turn,
      }));
      const { error: lineErr } = await supabase.from("recipe_ingredients").insert(rows);
      if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });
    }

    // Batches still in planning committed stock against the OLD lines. Re-apply
    // the new ones so their shortfall warnings reflect the recipe as it now
    // stands rather than the quantities in force when they were scheduled.
    await resyncRecipeCommitments(supabase, id);
  }

  const { data, error } = await supabase
    .from("recipes")
    .select("*, recipe_ingredients(*, ingredients(*)), recipe_brew_activity_templates:brew_activities(*)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.recipesOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  // Guard: block deletion if any non-complete batch references this recipe
  const { data: activeBatches, error: batchErr } = await supabase
    .from("brew_batches")
    .select("id, beer_name, status")
    .eq("recipe_id", id)
    .neq("status", "complete");

  if (batchErr) return NextResponse.json({ error: batchErr.message }, { status: 500 });

  if (activeBatches && activeBatches.length > 0) {
    const names = activeBatches.map((b: { beer_name: string }) => b.beer_name).join(", ");
    return NextResponse.json(
      { error: `Recipe is used by active batch${activeBatches.length > 1 ? "es" : ""}: ${names}. Archive those batches before deleting the recipe.` },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("recipes").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
