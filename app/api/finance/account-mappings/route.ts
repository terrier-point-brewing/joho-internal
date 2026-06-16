import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// GET — all variations with their item context and CoA mappings (default + source overrides)
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
      chart_of_accounts_id_pos,
      chart_of_accounts_id_invoice,
      bs_chart_of_accounts_id,
      pl_chart_of_accounts_id,
      chart_of_accounts!square_catalog_variations_chart_of_accounts_id_fkey ( account_name, account_number, account_type ),
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

  // Collect all unique CoA ids referenced by source overrides and fetch them in one query
  const sourceCoAIds = new Set<string>();
  for (const v of data ?? []) {
    if (v.chart_of_accounts_id_pos)     sourceCoAIds.add(v.chart_of_accounts_id_pos);
    if (v.chart_of_accounts_id_invoice) sourceCoAIds.add(v.chart_of_accounts_id_invoice);
    if (v.bs_chart_of_accounts_id)      sourceCoAIds.add(v.bs_chart_of_accounts_id);
    if (v.pl_chart_of_accounts_id)      sourceCoAIds.add(v.pl_chart_of_accounts_id);
  }

  const coaById = new Map<string, { account_name: string; account_number: string | null; account_type: string }>();
  if (sourceCoAIds.size > 0) {
    const { data: coaRows } = await supabase
      .from("chart_of_accounts")
      .select("id, account_name, account_number, account_type")
      .in("id", [...sourceCoAIds]);
    for (const r of coaRows ?? []) coaById.set(r.id, r);
  }

  const enriched = (data ?? []).map((v) => ({
    ...v,
    coa_pos:     v.chart_of_accounts_id_pos  ? (coaById.get(v.chart_of_accounts_id_pos)  ?? null) : null,
    coa_invoice: v.chart_of_accounts_id_invoice ? (coaById.get(v.chart_of_accounts_id_invoice) ?? null) : null,
    coa_bs:      v.bs_chart_of_accounts_id   ? (coaById.get(v.bs_chart_of_accounts_id)   ?? null) : null,
    coa_pl:      v.pl_chart_of_accounts_id   ? (coaById.get(v.pl_chart_of_accounts_id)   ?? null) : null,
  }));

  return NextResponse.json(enriched);
}

// PATCH — set CoA on one variation (default and/or source-specific overrides)
export async function PATCH(req: NextRequest) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const body = await req.json() as {
    square_variation_id: string;
    chart_of_accounts_id?: string | null;
    chart_of_accounts_id_pos?: string | null;
    chart_of_accounts_id_invoice?: string | null;
    bs_chart_of_accounts_id?: string | null;
    pl_chart_of_accounts_id?: string | null;
  };

  if (!body.square_variation_id) {
    return NextResponse.json({ error: "square_variation_id required" }, { status: 400 });
  }

  const patch: Record<string, string | null> = {};
  if ("chart_of_accounts_id" in body)         patch.chart_of_accounts_id         = body.chart_of_accounts_id ?? null;
  if ("chart_of_accounts_id_pos" in body)     patch.chart_of_accounts_id_pos     = body.chart_of_accounts_id_pos ?? null;
  if ("chart_of_accounts_id_invoice" in body) patch.chart_of_accounts_id_invoice = body.chart_of_accounts_id_invoice ?? null;
  if ("bs_chart_of_accounts_id" in body)      patch.bs_chart_of_accounts_id      = body.bs_chart_of_accounts_id ?? null;
  if ("pl_chart_of_accounts_id" in body)      patch.pl_chart_of_accounts_id      = body.pl_chart_of_accounts_id ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_catalog_variations")
    .update(patch)
    .eq("square_variation_id", body.square_variation_id)
    .select("id, chart_of_accounts_id, chart_of_accounts_id_pos, chart_of_accounts_id_invoice, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
