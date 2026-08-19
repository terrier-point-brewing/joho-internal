import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { IngredientUnit } from "@/lib/production/units";

export const dynamic = "force-dynamic";

/**
 * GET /api/production/ingredient-units
 *
 * The vocabulary `ingredients.unit` is drawn from. Retired codes come back too
 * — an ingredient can still be SITTING on one, and the edit form has to render
 * what it holds — so callers building a picker filter on `is_active`.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("ingredient_units")
    .select("code, label, dimension, base_factor, is_active, sort_order")
    .order("sort_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(
    (data ?? []).map((u) => ({
      ...u,
      base_factor: u.base_factor == null ? null : Number(u.base_factor),
    })) as IngredientUnit[],
  );
}
