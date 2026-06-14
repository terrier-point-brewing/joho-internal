import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// GET — all variations with their item context and CoA mapping
export async function GET() {
  try { await requireRole("viewer"); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_catalog_variations")
    .select(`
      id,
      square_variation_id,
      variation_name,
      sku,
      upc,
      price_amount,
      price_currency,
      pricing_type,
      chart_of_accounts_id,
      chart_of_accounts ( account_name, account_number, account_type ),
      square_catalog_items (
        id,
        square_item_id,
        item_name,
        category_id,
        category_name,
        parent_category_id,
        parent_category_name,
        is_top_level_category,
        product_type,
        is_archived
      )
    `)
    .order("square_catalog_items(category_name)", { nullsFirst: false })
    .order("square_catalog_items(item_name)")
    .order("variation_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// PATCH — set CoA on one variation
export async function PATCH(req: NextRequest) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const { square_variation_id, chart_of_accounts_id } = await req.json() as {
    square_variation_id: string;
    chart_of_accounts_id: string | null;
  };

  if (!square_variation_id) {
    return NextResponse.json({ error: "square_variation_id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_catalog_variations")
    .update({ chart_of_accounts_id })
    .eq("square_variation_id", square_variation_id)
    .select("id, chart_of_accounts_id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
