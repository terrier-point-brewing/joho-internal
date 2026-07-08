import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { adjustmentCost } from "@/lib/finance/cogs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  const supabase = await createSupabaseServerClient();

  // Ingredient costs: batch_use adjustments
  let ingQuery = supabase
    .from("stock_adjustments")
    .select(`
      id, batch_id, quantity, cost_per_unit, total_value_change, unit, created_at,
      ingredients ( name, category ),
      brew_batches ( beer_name, batch_number )
    `)
    .eq("type", "batch_use")
    .order("created_at", { ascending: false });

  if (from) ingQuery = ingQuery.gte("created_at", from);
  if (to)   ingQuery = ingQuery.lte("created_at", to + "T23:59:59");

  // Packaging costs: used adjustments
  let pkgQuery = supabase
    .from("packaging_stock_adjustments")
    .select(`
      id, packaging_item_id, quantity, cost_per_unit, total_value_change, created_at,
      packaging_items ( name, type )
    `)
    .eq("type", "used")
    .order("created_at", { ascending: false });

  if (from) pkgQuery = pkgQuery.gte("created_at", from);
  if (to)   pkgQuery = pkgQuery.lte("created_at", to + "T23:59:59");

  const [{ data: ingredients, error: ingErr }, { data: packaging, error: pkgErr }] =
    await Promise.all([ingQuery, pkgQuery]);

  if (ingErr) return NextResponse.json({ error: ingErr.message }, { status: 500 });
  if (pkgErr) return NextResponse.json({ error: pkgErr.message }, { status: 500 });

  const ingredientRows = (ingredients ?? []).map((r) => ({
    id:          r.id,
    batch_id:    r.batch_id,
    beer_name:   (r.brew_batches as { beer_name?: string } | null)?.beer_name ?? null,
    batch_number:(r.brew_batches as { batch_number?: string } | null)?.batch_number ?? null,
    name:        (r.ingredients as { name?: string } | null)?.name ?? "Unknown",
    category:    (r.ingredients as { category?: string } | null)?.category ?? null,
    quantity:    r.quantity,
    unit:        r.unit,
    cost_per_unit: r.cost_per_unit,
    total_cost:  adjustmentCost(r),
    date:        r.created_at,
    type:        "ingredient" as const,
  }));

  const packagingRows = (packaging ?? []).map((r) => ({
    id:           r.id,
    batch_id:     null,
    beer_name:    null,
    batch_number: null,
    name:         (r.packaging_items as { name?: string } | null)?.name ?? "Unknown",
    category:     (r.packaging_items as { type?: string } | null)?.type ?? null,
    quantity:     r.quantity,
    unit:         null,
    cost_per_unit: r.cost_per_unit,
    total_cost:   adjustmentCost(r),
    date:         r.created_at,
    type:         "packaging" as const,
  }));

  const totalIngredients = ingredientRows.reduce((s, r) => s + r.total_cost, 0);
  const totalPackaging   = packagingRows.reduce((s, r) => s + r.total_cost, 0);

  return NextResponse.json({
    ingredient_rows: ingredientRows,
    packaging_rows:  packagingRows,
    totals: {
      ingredients: Math.round(totalIngredients * 100) / 100,
      packaging:   Math.round(totalPackaging   * 100) / 100,
      total:       Math.round((totalIngredients + totalPackaging) * 100) / 100,
    },
  });
}
