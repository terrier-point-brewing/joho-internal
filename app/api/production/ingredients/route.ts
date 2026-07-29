import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("ingredients")
    .select("*, suppliers(company_name), contract_brewing_partners(company_name)")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  // ingredientMasterEdit, matching PATCH/DELETE on /ingredients/[id]: creating
  // an ingredient is a master-data write, not a stock movement.
  try { await requirePermission(CAP.ingredientMasterEdit); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { name, category, supplier_id, partner_id, unit, cost_per_unit, stock_quantity } = body;

  const { data, error } = await supabase
    .from("ingredients")
    .insert({ name, category: category ?? null, supplier_id: supplier_id || null, partner_id: partner_id || null, unit, cost_per_unit: cost_per_unit ?? null, stock_quantity: stock_quantity ?? 0 })
    .select("*, suppliers(company_name), contract_brewing_partners(company_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
