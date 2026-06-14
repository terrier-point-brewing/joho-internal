/**
 * POST /api/finance/transactions/sync?year=YYYY&month=M
 *
 * Pulls completed POS orders from Square and upserts them into
 * square_transactions + square_transaction_line_items.
 * Line items are prefilled with CoA from account mapping when available.
 * Idempotent — re-running updates existing records.
 *
 * Syncs one month at a time (defaults to the current month if month param absent)
 * to keep each request fast. Use month=0 to sync the full year.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCompletedOrders } from "@/lib/square/orders";

export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year      = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const monthParam = req.nextUrl.searchParams.get("month");
  const supabase  = createSupabaseAdminClient();

  // Default: sync current month. month=0 means full year.
  const now          = new Date();
  const defaultMonth = year === now.getFullYear() ? now.getMonth() + 1 : 1;
  const month        = monthParam !== null ? parseInt(monthParam) : defaultMonth;

  let startDate: string;
  let endDate: string;

  if (month === 0) {
    startDate = `${year}-01-01`;
    endDate   = `${year}-12-31`;
  } else {
    const m     = month.toString().padStart(2, "0");
    const last  = new Date(year, month, 0).getDate();
    startDate   = `${year}-${m}-01`;
    endDate     = `${year}-${m}-${last}`;
  }

  const [orders, mappings] = await Promise.all([
    fetchCompletedOrders(startDate, endDate),
    supabase
      .from("square_catalog_variations")
      .select("square_variation_id, chart_of_accounts_id")
      .not("chart_of_accounts_id", "is", null),
  ]);

  if (orders.length === 0) {
    return NextResponse.json({ synced: 0, updated: 0, skipped: 0, total: 0 });
  }

  const coaByVariationId = new Map<string, string>(
    (mappings.data ?? [])
      .filter((m): m is { square_variation_id: string; chart_of_accounts_id: string } =>
        !!m.square_variation_id && !!m.chart_of_accounts_id
      )
      .map((m) => [m.square_variation_id, m.chart_of_accounts_id])
  );

  // Build all transaction payloads
  const txnPayloads = orders.map((order) => ({
    square_order_id:  order.id,
    location_id:      order.location_id,
    transaction_date: order.closed_at ?? order.updated_at ?? order.created_at,
    customer_id:      order.customer_id ?? null,
    customer_name:    null as string | null,
    total_cents:      order.total_money?.amount ?? 0,
    tax_cents:        order.total_tax_money?.amount ?? 0,
    tip_cents:        order.total_tip_money?.amount ?? 0,
    discount_cents:   order.total_discount_money?.amount ?? 0,
    status:           order.state ?? "COMPLETED",
    raw_data:         order as object,
    updated_at:       new Date().toISOString(),
  }));

  // Upsert transactions in batches, collect their DB ids
  const upsertedIds = new Map<string, string>(); // square_order_id → db id
  const errors: string[] = [];

  for (let i = 0; i < txnPayloads.length; i += BATCH_SIZE) {
    const batch = txnPayloads.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("square_transactions")
      .upsert(batch, { onConflict: "square_order_id" })
      .select("id, square_order_id, created_at, updated_at");

    if (error) {
      errors.push(`Batch upsert ${i}–${i + batch.length}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      upsertedIds.set(row.square_order_id, row.id);
    }
  }

  let synced = 0;

  // Delete existing line items for all upserted transactions, then re-insert
  const allDbIds = [...upsertedIds.values()];

  for (let i = 0; i < allDbIds.length; i += BATCH_SIZE) {
    await supabase
      .from("square_transaction_line_items")
      .delete()
      .in("transaction_id", allDbIds.slice(i, i + BATCH_SIZE));
  }

  // Build all line item payloads
  const allLineItems: object[] = [];
  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;

    // We can't tell new vs updated from the batch result easily, so approximate:
    // treat it as synced for now. A more precise count would require a pre-fetch.
    synced++;

    for (const li of order.line_items ?? []) {
      const prefillCoA = li.catalog_object_id ? coaByVariationId.get(li.catalog_object_id) ?? null : null;
      allLineItems.push({
        transaction_id:           dbId,
        square_line_item_uid:     li.uid,
        square_catalog_object_id: li.catalog_object_id ?? null,
        square_variation_id:      li.catalog_object_id ?? null,
        name:                     [li.name, li.variation_name].filter(Boolean).join(" – "),
        quantity:                 parseFloat(li.quantity ?? "1"),
        base_price_cents:         li.base_price_money?.amount ?? 0,
        gross_sales_cents:        li.gross_sales_money?.amount ?? 0,
        discount_cents:           li.total_discount_money?.amount ?? 0,
        net_sales_cents:          li.total_money?.amount ?? 0,
        tax_cents:                li.total_tax_money?.amount ?? 0,
        chart_of_accounts_id:     prefillCoA,
      });
    }
  }

  // Insert line items in batches
  for (let i = 0; i < allLineItems.length; i += BATCH_SIZE) {
    const { error } = await supabase
      .from("square_transaction_line_items")
      .insert(allLineItems.slice(i, i + BATCH_SIZE));
    if (error) errors.push(`Line items batch ${i}: ${error.message}`);
  }

  return NextResponse.json({
    synced,
    updated: 0,
    skipped: 0,
    total: orders.length,
    dateRange: { startDate, endDate },
    errors: errors.length ? errors : undefined,
  });
}
