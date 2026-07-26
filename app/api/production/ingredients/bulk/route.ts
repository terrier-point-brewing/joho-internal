import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { IngredientCategory, INGREDIENT_CATEGORIES } from "@/app/production/types";

export const dynamic = "force-dynamic";

interface BulkRow {
  name: string;
  category?: string | null;
  unit: string;
  cost_per_unit?: number | null;
  stock_quantity?: number;
}

/**
 * POST /api/production/ingredients/bulk
 * Body: { rows: BulkRow[] }
 * Inserts all rows and returns { inserted, errors }.
 */
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.inventoryOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const rows: BulkRow[] = body.rows;

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "rows array is required" }, { status: 400 });
  }

  const validCategories = new Set<string>(INGREDIENT_CATEGORIES);

  const records = rows.map((r) => ({
    name:           r.name.trim(),
    category:       r.category && validCategories.has(r.category) ? (r.category as IngredientCategory) : null,
    unit:           r.unit.trim(),
    cost_per_unit:  r.cost_per_unit ?? null,
    stock_quantity: r.stock_quantity ?? 0,
    supplier_id:    null,
    partner_id:     null,
  }));

  const { data, error } = await supabase
    .from("ingredients")
    .insert(records)
    .select("id, name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ inserted: data?.length ?? 0 }, { status: 201 });
}
