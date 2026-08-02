import { NextRequest, NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapPosLineItems, autoMapInvoiceLineItems } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

// POST — bulk-set CoA on variations. Exactly one scope key must be provided:
//   catalog_item_id  — all variations of a specific item (DB uuid)
//   parent_group_id  — all items whose parent_category_id OR (if null) category_id matches
//   category_id      — all items whose category_id matches (or null = uncategorized)
// overwrite=false: only fills unmapped variations
// overwrite=true:  replaces all existing mappings
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as {
    chart_of_accounts_id?: string | null;
    chart_of_accounts_id_pos?: string | null;
    chart_of_accounts_id_invoice?: string | null;
    overwrite?: boolean;
    catalog_item_id?: string;
    parent_group_id?: string | null;
    category_id?: string | null;
  };

  const { overwrite = false } = body;

  // Build the update patch — at least one CoA field must be present
  const patch: Record<string, string | null> = {};
  if ("chart_of_accounts_id" in body)         patch.chart_of_accounts_id         = body.chart_of_accounts_id ?? null;
  if ("chart_of_accounts_id_pos" in body)     patch.chart_of_accounts_id_pos     = body.chart_of_accounts_id_pos ?? null;
  if ("chart_of_accounts_id_invoice" in body) patch.chart_of_accounts_id_invoice = body.chart_of_accounts_id_invoice ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "At least one CoA field required" }, { status: 400 });
  }

  // For the primary CoA field used in overwrite checks
  const primaryField = "chart_of_accounts_id" in body ? "chart_of_accounts_id"
    : "chart_of_accounts_id_pos" in body ? "chart_of_accounts_id_pos"
    : "chart_of_accounts_id_invoice";

  const supabase = createSupabaseAdminClient();

  async function updateVariations(itemIds: string[]): Promise<string[]> {
    if (!itemIds.length) return [];
    // Excluded variations are a deliberate per-row decision, the same way a
    // manually-pinned expense survives a rule cascade — a bulk category/item
    // mapper must not sweep over one, even with overwrite=true.
    let q = supabase
      .from("square_catalog_variations")
      .update(patch)
      .in("catalog_item_id", itemIds)
      .eq("excluded", false);
    if (!overwrite) q = q.is(primaryField, null);
    const { data, error } = await q.select("id, square_variation_id");
    if (error) throw error;
    return (data ?? []).map((r) => r.square_variation_id as string);
  }

  // Back-fill already-ingested unmapped line items for the affected variations so the
  // user doesn't have to click "Auto-map all". Current + prior year covers open books.
  function scheduleCascade(variationIds: string[]) {
    if (!variationIds.length) return;
    after(async () => {
      const currentYear = new Date().getFullYear();
      const years = [currentYear, currentYear - 1];
      for (const year of years) {
        try {
          await autoMapPosLineItems(supabase, { year, variationIds });
          await autoMapInvoiceLineItems(supabase, { year, variationIds });
        } catch (e) {
          console.error("[account-mappings/bulk] cascade auto-map failed", { count: variationIds.length, year, error: e });
        }
      }
    });
  }

  try {
    // ── Item scope ────────────────────────────────────────────────────────────
    if (body.catalog_item_id) {
      const affectedVariationIds = await updateVariations([body.catalog_item_id]);
      scheduleCascade(affectedVariationIds);
      return NextResponse.json({ updated: affectedVariationIds.length });
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
      const affectedVariationIds = await updateVariations((items ?? []).map((i) => i.id));
      scheduleCascade(affectedVariationIds);
      return NextResponse.json({ updated: affectedVariationIds.length });
    }

    // ── Subcategory scope (default) ───────────────────────────────────────────
    const { category_id } = body;
    const { data: items, error } = category_id
      ? await supabase.from("square_catalog_items").select("id").eq("category_id", category_id)
      : await supabase.from("square_catalog_items").select("id").is("category_id", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const affectedVariationIds = await updateVariations((items ?? []).map((i) => i.id));
    scheduleCascade(affectedVariationIds);
    return NextResponse.json({ updated: affectedVariationIds.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
