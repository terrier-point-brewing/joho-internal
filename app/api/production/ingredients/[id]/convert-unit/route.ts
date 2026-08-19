import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  conversionRatio,
  convertibleTargets,
  previewConversion,
  type IngredientUnit,
} from "@/lib/production/units";

export const dynamic = "force-dynamic";

async function loadVocabulary(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<IngredientUnit[]> {
  const { data, error } = await supabase
    .from("ingredient_units")
    .select("code, label, dimension, base_factor, is_active, sort_order")
    .order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []).map((u) => ({
    ...u,
    base_factor: u.base_factor == null ? null : Number(u.base_factor),
  })) as IngredientUnit[];
}

/**
 * GET /api/production/ingredients/[id]/convert-unit
 *
 * What a conversion would cost this ingredient, and what it may convert into.
 * The dependent counts are the whole point of the dialog: an operator should
 * see that eight recipes move before they agree to move them, not after.
 *
 * `?to=oz` adds the arithmetic preview for that target.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requirePermission(CAP.ingredientMasterEdit); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const to = req.nextUrl.searchParams.get("to");

  const { data: ing, error } = await supabase
    .from("ingredients")
    .select("id, name, unit, stock_quantity, cost_per_unit_usd")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "PGRST116" ? 404 : 500 });

  const vocabulary = await loadVocabulary(supabase);

  // head+count so a busy ingredient does not drag its whole history over the
  // wire just to render "19 adjustments".
  const countOf = async (table: string) => {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("ingredient_id", id);
    return count ?? 0;
  };

  const [recipeLines, adjustments, depositLines] = await Promise.all([
    countOf("recipe_ingredients"),
    countOf("stock_adjustments"),
    countOf("deposit_invoice_ingredients"),
  ]);

  const { count: openCommitments } = await supabase
    .from("batch_ingredient_commitments")
    .select("id", { count: "exact", head: true })
    .eq("ingredient_id", id)
    .is("released_at", null);

  const stock = Number(ing.stock_quantity);
  const cost = ing.cost_per_unit_usd == null ? null : Number(ing.cost_per_unit_usd);

  // Mirrors ingredient_has_dependents() in the DB. When nothing depends on the
  // unit yet, a change is a typo correction and the plain PATCH handles it —
  // which is why the edit form only locks the field once this is true.
  const hasDependents =
    stock !== 0 ||
    recipeLines > 0 ||
    (openCommitments ?? 0) > 0 ||
    adjustments > 0 ||
    depositLines > 0;

  const ratio = to ? conversionRatio(ing.unit, to, vocabulary) : null;

  return NextResponse.json({
    ingredient: { id: ing.id, name: ing.name, unit: ing.unit, stock_quantity: stock, cost_per_unit_usd: cost },
    has_dependents: hasDependents,
    impact: {
      recipe_lines: recipeLines,
      open_commitments: openCommitments ?? 0,
      // Named for what they are: history, which a conversion never restates.
      past_adjustments: adjustments,
      deposit_invoice_lines: depositLines,
    },
    targets: convertibleTargets(ing.unit, vocabulary),
    preview:
      to && ratio != null
        ? { to_unit: to, ...previewConversion({ stock_quantity: stock, cost_per_unit_usd: cost }, ratio) }
        : null,
  });
}

/**
 * POST /api/production/ingredients/[id]/convert-unit  { to_unit }
 *
 * Hands off to convert_ingredient_unit(), which does the whole thing in one
 * transaction. Doing it here in four PATCHes would leave an ingredient priced
 * in ounces while its recipes still charged pounds if the third one failed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requirePermission(CAP.ingredientMasterEdit); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const toUnit = typeof body?.to_unit === "string" ? body.to_unit.trim() : "";
  if (!toUnit) return NextResponse.json({ error: "to_unit is required" }, { status: 400 });

  const { data, error } = await supabase.rpc("convert_ingredient_unit", {
    p_ingredient_id: id,
    p_to_unit: toUnit,
  });

  if (error) {
    // The function raises with a message written for the operator — a
    // mismatched dimension, a retired code, a unit with no fixed factor. Pass
    // it through rather than flattening it to "conversion failed".
    const status = error.code === "P0002" ? 404 : 409;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json(data);
}
