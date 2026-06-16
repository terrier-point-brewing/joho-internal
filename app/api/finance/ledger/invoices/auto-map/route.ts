/**
 * POST /api/finance/ledger/invoices/auto-map?year=YYYY
 *
 * For all invoice line items in the given year that have no
 * chart_of_accounts_id, looks up other line items with the same
 * description that DO have a mapping and copies it over.
 *
 * Returns the count of items mapped.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  // Fetch all line items for invoices in the given year (both mapped and unmapped)
  const { data: allItems, error } = await supabase
    .from("invoice_line_items")
    .select("id, description, chart_of_accounts_id, invoices!inner(invoice_date)")
    .gte("invoices.invoice_date", `${year}-01-01`)
    .lte("invoices.invoice_date", `${year}-12-31`);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!allItems || allItems.length === 0) return NextResponse.json({ mapped: 0 });

  // Build a description → chart_of_accounts_id lookup from already-mapped items
  const coaByDescription = new Map<string, string>();
  for (const item of allItems) {
    if (item.chart_of_accounts_id && item.description) {
      coaByDescription.set(item.description.trim().toLowerCase(), item.chart_of_accounts_id);
    }
  }

  // Find unmapped items whose description has a known mapping
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
    .map((r) => r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : String(((r as PromiseFulfilledResult<{ error: { message: string } }>).value?.error?.message)));

  return NextResponse.json({ mapped, errors: errors.length ? errors : undefined });
}
