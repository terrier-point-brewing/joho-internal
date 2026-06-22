/**
 * POST /api/finance/ledger/invoices/auto-map?year=YYYY
 *
 * For all invoice line items in the given year that have no chart_of_accounts_id,
 * resolves a mapping from two sources (in priority order):
 *   1. Other already-mapped line items with the same description.
 *   2. Catalog variation mappings: chart_of_accounts_id_invoice (if set),
 *      else chart_of_accounts_id — matched by building "item_name — variation_name"
 *      the same way the sync route builds line item descriptions.
 *
 * Returns the count of items mapped.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  // ── 1. Fetch all line items for the year ────────────────────────────────────
  const { data: allItems, error } = await supabase
    .from("invoice_line_items")
    .select("id, description, variation_name, chart_of_accounts_id, invoices!invoice_line_items_invoice_id_fkey!inner(invoice_date)")
    .gte("invoices.invoice_date", `${year}-01-01`)
    .lte("invoices.invoice_date", `${year}-12-31`);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!allItems || allItems.length === 0) return NextResponse.json({ mapped: 0 });

  // ── 2. Source 1: description → CoA from already-mapped line items ───────────
  const coaByDescription = new Map<string, string>();
  for (const item of allItems) {
    if (item.chart_of_accounts_id && item.description) {
      coaByDescription.set(item.description.trim().toLowerCase(), item.chart_of_accounts_id);
    }
  }

  // ── 3. Source 2: catalog variation mappings ──────────────────────────────────
  // Build "item_name — variation_name" → CoA, matching how sync constructs descriptions.
  const { data: variations } = await supabase
    .from("square_catalog_variations")
    .select(`
      variation_name,
      chart_of_accounts_id,
      chart_of_accounts_id_invoice,
      square_catalog_items ( item_name )
    `)
    .or("chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");

  for (const v of variations ?? []) {
    const itemName = (v.square_catalog_items as unknown as { item_name: string } | null)?.item_name;
    if (!itemName) continue;
    const coaId = v.chart_of_accounts_id_invoice ?? v.chart_of_accounts_id;
    if (!coaId) continue;
    // Full description key: "item_name — variation_name"
    const key = `${itemName} — ${v.variation_name}`.trim().toLowerCase();
    if (!coaByDescription.has(key)) coaByDescription.set(key, coaId);
    // Also index by plain item_name for single-variation items with no variation suffix
    const plainKey = itemName.trim().toLowerCase();
    if (!coaByDescription.has(plainKey)) coaByDescription.set(plainKey, coaId);
  }

  // ── 4. Apply mappings to unmapped items ─────────────────────────────────────
  const toUpdate = allItems.filter(
    (item) =>
      !item.chart_of_accounts_id &&
      item.description &&
      coaByDescription.has(item.description.trim().toLowerCase())
  );

  if (toUpdate.length === 0) return NextResponse.json({ mapped: 0 });

  const results = await Promise.allSettled(
    toUpdate.map((item) =>
      supabase
        .from("invoice_line_items")
        .update({ chart_of_accounts_id: coaByDescription.get(item.description!.trim().toLowerCase()) })
        .eq("id", item.id)
    )
  );

  const mapped = results.filter((r) => r.status === "fulfilled" && !(r as PromiseFulfilledResult<{ error: unknown }>).value.error).length;
  const errors = results
    .filter((r) => r.status === "rejected" || ((r as PromiseFulfilledResult<{ error: unknown }>).value?.error))
    .map((r) => r.status === "rejected"
      ? String((r as PromiseRejectedResult).reason)
      : String((r as PromiseFulfilledResult<{ error: { message: string } }>).value?.error?.message));

  return NextResponse.json({ mapped, errors: errors.length ? errors : undefined });
}
