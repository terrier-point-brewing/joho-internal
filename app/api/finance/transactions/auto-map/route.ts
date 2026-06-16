/**
 * POST /api/finance/transactions/auto-map?year=YYYY
 *
 * For all POS line items in the given year that have no manual
 * chart_of_accounts_id but whose square_variation_id has a mapping
 * in square_catalog_variations, writes the mapped account as the
 * manual override. Returns the count of items updated.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const startDate = `${year}-01-01`;
  const endDate   = `${year + 1}-01-01`;

  const supabase = createSupabaseAdminClient();

  // Find all unmapped line items (no manual override) for POS orders in the year
  const { data: unmapped, error: fetchErr } = await supabase
    .from("pos_line_items")
    .select("id, square_variation_id")
    .is("chart_of_accounts_id", null)
    .not("square_variation_id", "is", null)
    .gte("square_orders.transaction_date", startDate)
    .lt("square_orders.transaction_date", endDate);

  // The join filter above won't work on a flat select — use a subquery approach instead
  // Fetch unmapped items via the orders table
  const { data: orders, error: ordersErr } = await supabase
    .from("square_orders")
    .select("id")
    .gte("transaction_date", startDate)
    .lt("transaction_date", endDate)
    .is("invoice_id", null);

  if (ordersErr) return NextResponse.json({ error: ordersErr.message }, { status: 500 });

  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return NextResponse.json({ mapped: 0 });

  // Get unmapped line items for those orders
  const { data: lineItems, error: liErr } = await supabase
    .from("pos_line_items")
    .select("id, square_variation_id")
    .is("chart_of_accounts_id", null)
    .not("square_variation_id", "is", null)
    .in("square_order_id", orderIds);

  if (liErr) return NextResponse.json({ error: liErr.message }, { status: 500 });
  if (!lineItems || lineItems.length === 0) return NextResponse.json({ mapped: 0 });

  // Fetch catalog variation mappings for all variation IDs present
  const varIds = [...new Set(lineItems.map((li) => li.square_variation_id as string))];
  const { data: mappings, error: mapErr } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id")
    .in("square_variation_id", varIds)
    .not("chart_of_accounts_id", "is", null);

  if (mapErr) return NextResponse.json({ error: mapErr.message }, { status: 500 });

  const coaByVarId = new Map<string, string>(
    (mappings ?? []).map((m) => [m.square_variation_id, m.chart_of_accounts_id as string])
  );

  // Build list of updates
  const updates = lineItems
    .filter((li) => li.square_variation_id && coaByVarId.has(li.square_variation_id))
    .map((li) => ({ id: li.id, chart_of_accounts_id: coaByVarId.get(li.square_variation_id!)! }));

  if (updates.length === 0) return NextResponse.json({ mapped: 0 });

  // Batch update in chunks of 100
  const CHUNK = 100;
  let mapped = 0;
  const errors: string[] = [];

  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    // Supabase doesn't support bulk heterogeneous updates; do individual upserts
    const results = await Promise.allSettled(
      chunk.map((u) =>
        supabase
          .from("pos_line_items")
          .update({ chart_of_accounts_id: u.chart_of_accounts_id })
          .eq("id", u.id)
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) mapped++;
      else if (r.status === "rejected") errors.push(String(r.reason));
      else if (r.status === "fulfilled" && r.value.error) errors.push(r.value.error.message);
    }
  }

  return NextResponse.json({ mapped, errors: errors.length ? errors : undefined });
}
