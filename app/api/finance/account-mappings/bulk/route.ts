import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// POST — bulk-set CoA on variations. Exactly one scope key must be provided:
//   catalog_item_id  — all variations of a specific item (DB uuid)
//   parent_group_id  — all items whose parent_category_id OR (if null) category_id matches
//   category_id      — all items whose category_id matches (or null = uncategorized)
// overwrite=false: only fills unmapped variations
// overwrite=true:  replaces all existing mappings
export async function POST(req: NextRequest) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const body = await req.json() as {
    chart_of_accounts_id: string | null;
    overwrite?: boolean;
    catalog_item_id?: string;
    parent_group_id?: string | null;
    category_id?: string | null;
  };

  const { chart_of_accounts_id, overwrite = false } = body;

  if (chart_of_accounts_id === undefined) {
    return NextResponse.json({ error: "chart_of_accounts_id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  async function updateVariations(itemIds: string[]) {
    if (!itemIds.length) return 0;
    let q = supabase
      .from("square_catalog_variations")
      .update({ chart_of_accounts_id })
      .in("catalog_item_id", itemIds);
    if (!overwrite) q = q.is("chart_of_accounts_id", null);
    const { data, error } = await q.select("id");
    if (error) throw error;
    return data?.length ?? 0;
  }

  try {
    // ── Item scope ────────────────────────────────────────────────────────────
    if (body.catalog_item_id) {
      const count = await updateVariations([body.catalog_item_id]);
      return NextResponse.json({ updated: count });
    }

    // ── Parent category scope ─────────────────────────────────────────────────
    if ("parent_group_id" in body) {
      const pgid = body.parent_group_id;
      const { data: items, error } = pgid
        ? await supabase
            .from("square_catalog_items")
            .select("id")
            .or(`parent_category_id.eq.${pgid},and(parent_category_id.is.null,category_id.eq.${pgid})`)
        : await supabase
            .from("square_catalog_items")
            .select("id")
            .is("category_id", null)
            .is("parent_category_id", null);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const count = await updateVariations((items ?? []).map((i) => i.id));
      return NextResponse.json({ updated: count });
    }

    // ── Subcategory scope (default) ───────────────────────────────────────────
    const { category_id } = body;
    const { data: items, error } = category_id
      ? await supabase.from("square_catalog_items").select("id").eq("category_id", category_id)
      : await supabase.from("square_catalog_items").select("id").is("category_id", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const count = await updateVariations((items ?? []).map((i) => i.id));
    return NextResponse.json({ updated: count });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
