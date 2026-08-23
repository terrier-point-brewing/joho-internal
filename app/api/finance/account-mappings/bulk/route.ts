import { NextRequest, NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapPosLineItems, autoMapInvoiceLineItems } from "@/lib/finance/autoMap";
import { upsertGlDefaultRule, type GlRuleScope, type GlDefaultPatch } from "@/lib/finance/glDefaultRules";

export const dynamic = "force-dynamic";

// POST — bulk-set CoA (or bulk-exclude) on variations. Exactly one scope key must be provided:
//   catalog_item_id  — all variations of a specific item (DB uuid)
//   parent_group_id  — all items whose parent_category_id OR (if null) category_id matches
//   category_id      — all items whose category_id matches (or null = uncategorized)
// overwrite=false: only fills unresolved variations (no CoA and not excluded)
// overwrite=true:  replaces all existing mappings / excludes everything in scope
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as {
    chart_of_accounts_id?: string | null;
    chart_of_accounts_id_pos?: string | null;
    chart_of_accounts_id_invoice?: string | null;
    excluded?: boolean;
    overwrite?: boolean;
    catalog_item_id?: string;
    parent_group_id?: string | null;
    category_id?: string | null;
  };

  const { overwrite = false } = body;

  // Build the update patch — at least one field must be present
  const patch: Record<string, string | null | boolean> = {};
  if ("chart_of_accounts_id" in body)         patch.chart_of_accounts_id         = body.chart_of_accounts_id ?? null;
  if ("chart_of_accounts_id_pos" in body)     patch.chart_of_accounts_id_pos     = body.chart_of_accounts_id_pos ?? null;
  if ("chart_of_accounts_id_invoice" in body) patch.chart_of_accounts_id_invoice = body.chart_of_accounts_id_invoice ?? null;
  if ("excluded" in body)                     patch.excluded                     = body.excluded ?? false;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "At least one field required" }, { status: 400 });
  }

  // A bulk exclude has no CoA field to key off of — it's its own patch shape,
  // scoped by resolved-state rather than by a single primary field being null.
  const isExcludedOnly = "excluded" in body
    && !("chart_of_accounts_id" in body) && !("chart_of_accounts_id_pos" in body) && !("chart_of_accounts_id_invoice" in body);

  // For the primary CoA field used in overwrite checks
  const primaryField = "chart_of_accounts_id" in body ? "chart_of_accounts_id"
    : "chart_of_accounts_id_pos" in body ? "chart_of_accounts_id_pos"
    : "chart_of_accounts_id_invoice";

  const supabase = createSupabaseAdminClient();

  // The same decision, recorded as a standing default. Bulk mapping used to be a
  // one-shot write over today's variations, so an item Square added tomorrow
  // came back unresolved even though a person had already coded its category.
  // The rule is what the catalog sync reads when it first sees a variation.
  //
  // Only positive declarations are stored: clearing a bulk mapping (a null CoA)
  // says "these rows have no account", not "future rows must have none", and an
  // `excluded: false` is not something any bulk action sends.
  async function recordRule(scope: GlRuleScope, scopeKey: string | null) {
    const fields: GlDefaultPatch = {};
    for (const f of ["chart_of_accounts_id", "chart_of_accounts_id_pos", "chart_of_accounts_id_invoice"] as const) {
      if (f in patch && patch[f]) fields[f] = patch[f] as string;
    }
    if (patch.excluded === true) fields.excluded = true;
    if (Object.keys(fields).length === 0) return;
    try {
      await upsertGlDefaultRule(supabase, scope, scopeKey, fields);
    } catch (e) {
      // Never fail the bulk map over its own memory: the variations in scope are
      // already written and correct. The rule can be re-declared by re-applying.
      console.error("[account-mappings/bulk] failed to record standing rule", { scope, scopeKey, error: e });
    }
  }

  async function updateVariations(itemIds: string[]): Promise<string[]> {
    if (!itemIds.length) return [];
    let q = supabase
      .from("square_catalog_variations")
      .update(patch)
      .in("catalog_item_id", itemIds);
    if (isExcludedOnly) {
      // Fill = only the variations still awaiting a decision (no CoA, not already
      // excluded). Overwrite reaches every variation in scope, including
      // already-mapped ones — the mapping itself is untouched, only the excluded
      // flag flips, so it's reversible per-row via the individual toggle.
      if (!overwrite) q = q.eq("excluded", false).is("chart_of_accounts_id", null);
    } else {
      // Excluded variations are a deliberate per-row decision, the same way a
      // manually-pinned expense survives a rule cascade — a bulk category/item
      // mapper must not sweep over one, even with overwrite=true.
      q = q.eq("excluded", false);
      if (!overwrite) q = q.is(primaryField, null);
    }
    const { data, error } = await q.select("id, square_variation_id");
    if (error) throw error;
    return (data ?? []).map((r) => r.square_variation_id as string);
  }

  // Back-fill already-ingested unmapped line items for the affected variations so the
  // user doesn't have to click "Auto-map all". Current + prior year covers open books.
  function scheduleCascade(variationIds: string[]) {
    // Excluding sets no CoA field, so there's nothing new for auto-map to backfill.
    if (!variationIds.length || isExcludedOnly) return;
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
      await recordRule("item", body.catalog_item_id);
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
      await recordRule("parent", pgid ?? null);
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
    await recordRule("category", category_id ?? null);
    scheduleCascade(affectedVariationIds);
    return NextResponse.json({ updated: affectedVariationIds.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
