import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PACKAGING_VARIATION_SELECT } from "@/lib/production/packagingVariations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const recipeId = req.nextUrl.searchParams.get("recipe_id");

  let query = supabase
    .from("recipe_packaging_variations")
    // Reuse the shared variation select so the embedded container (and its
    // type) resolves via the explicit FK-constraint hint. packaging_variations
    // has five FKs to packaging_items, so a bare `container_id` column target is
    // ambiguous and leaves `container` unpopulated — which silently dropped
    // recipe-linked keg/can variations from the kegging/canning dropdowns.
    //
    // `!inner` + the is_active filter drops links that point at a deactivated
    // variation. Superseded variations get soft-deleted (is_active=false) rather
    // than hard-removed, but their recipe links can linger — surfacing as a
    // "ghost duplicate" next to the active replacement (e.g. an inactive
    // "Fortnight 1/2 Keg" showing alongside the active "Fortnight - 1/2 Keg").
    // No consumer (Recipes tab, kegging/canning dropdowns, brew status,
    // commitments) should offer or display an inactive variation.
    .select(`
      id, recipe_id, variation_id, created_at,
      packaging_variations!inner(${PACKAGING_VARIATION_SELECT})
    `)
    .eq("packaging_variations.is_active", true);
  // Optional per-recipe filter — used by the Draft Stats swap-keg selector,
  // which lists every keg variation of a tap's recipe regardless of stock.
  if (recipeId) query = query.eq("recipe_id", recipeId);

  const { data, error } = await query.order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { recipe_id, variation_id } = await req.json();
  if (!recipe_id || !variation_id) {
    return NextResponse.json({ error: "recipe_id and variation_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .insert({ recipe_id, variation_id })
    .select("*, packaging_variations(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_packaging_variations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
