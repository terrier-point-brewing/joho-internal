import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { beer_name, brewery, expected_yield_bbl, brew_time_weeks, days_brewhouse, days_fermenter, days_brite, steps, notes, ingredients: lines } = await req.json();

  const { error: recipeErr } = await supabase
    .from("recipes")
    .update({
      beer_name,
      brewery: brewery || null,
      expected_yield_bbl: expected_yield_bbl || null,
      brew_time_weeks: brew_time_weeks || null,
      days_brewhouse: days_brewhouse || null,
      days_fermenter: days_fermenter || null,
      days_brite: days_brite || null,
      steps: steps || null,
      notes: notes || null,
    })
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
    .select("*, recipe_ingredients(*, ingredients(*)), recipe_brew_activity_templates(*)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  // Guard: block deletion if any non-archived batch references this recipe
  const { data: activeBatches, error: batchErr } = await supabase
    .from("brew_batches")
    .select("id, beer_name, status")
    .eq("recipe_id", id)
    .neq("status", "archived");

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
