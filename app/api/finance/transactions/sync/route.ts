/**
 * POST /api/finance/transactions/sync?year=YYYY
 *
 * Pulls completed POS orders from Square and upserts them into
 * square_transactions + square_transaction_line_items.
 * Line items are prefilled with CoA from account mapping when available.
 * Idempotent — re-running updates existing records.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCompletedOrders } from "@/lib/square/orders";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year    = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  const orders = await fetchCompletedOrders(startDate, endDate);

  if (orders.length === 0) {
    return NextResponse.json({ synced: 0, updated: 0, skipped: 0, total: 0 });
  }

  // Load account mapping for prefilling CoA on line items
  const { data: mappings } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);

  const coaByVariationId = new Map<string, string>(
    (mappings ?? [])
      .filter((m): m is { square_variation_id: string; chart_of_accounts_id: string } =>
        !!m.square_variation_id && !!m.chart_of_accounts_id
      )
      .map((m) => [m.square_variation_id, m.chart_of_accounts_id])
  );

  let synced = 0, updated = 0, errors: string[] = [];

  for (const order of orders) {
    try {
      const transactionDate = order.closed_at ?? order.updated_at ?? order.created_at;

      const txnPayload = {
        square_order_id:  order.id,
        location_id:      order.location_id,
        transaction_date: transactionDate,
        customer_id:      order.customer_id ?? null,
        customer_name:    null as string | null,
        total_cents:      order.total_money?.amount ?? 0,
        tax_cents:        order.total_tax_money?.amount ?? 0,
        tip_cents:        order.total_tip_money?.amount ?? 0,
        discount_cents:   order.total_discount_money?.amount ?? 0,
        status:           order.state ?? "COMPLETED",
        raw_data:         order as object,
      };

      const { data: upserted, error: txnErr } = await supabase
        .from("square_transactions")
        .upsert(txnPayload, { onConflict: "square_order_id" })
        .select("id, created_at, updated_at")
        .single();

      if (txnErr || !upserted) {
        errors.push(`Order ${order.id}: ${txnErr?.message ?? "upsert failed"}`);
        continue;
      }

      // Track new vs updated
      const isNew = upserted.created_at === upserted.updated_at;
      if (isNew) synced++; else updated++;

      // Upsert line items — delete existing then re-insert to handle quantity changes
      if ((order.line_items ?? []).length > 0) {
        await supabase.from("square_transaction_line_items").delete().eq("transaction_id", upserted.id);

        const linePayloads = (order.line_items ?? []).map((li) => {
          const grossCents = li.gross_sales_money?.amount ?? 0;
          const discountCents = li.total_discount_money?.amount ?? 0;
          const netCents = (li.total_money?.amount ?? 0);
          const taxCents = li.total_tax_money?.amount ?? 0;
          const prefillCoA = li.catalog_object_id ? coaByVariationId.get(li.catalog_object_id) ?? null : null;

          return {
            transaction_id:           upserted.id,
            square_line_item_uid:     li.uid,
            square_catalog_object_id: li.catalog_object_id ?? null,
            square_variation_id:      li.catalog_object_id ?? null,
            name:                     [li.name, li.variation_name].filter(Boolean).join(" – "),
            quantity:                 parseFloat(li.quantity ?? "1"),
            base_price_cents:         li.base_price_money?.amount ?? 0,
            gross_sales_cents:        grossCents,
            discount_cents:           discountCents,
            net_sales_cents:          netCents,
            tax_cents:                taxCents,
            chart_of_accounts_id:     prefillCoA,
          };
        });

        const { error: liErr } = await supabase
          .from("square_transaction_line_items")
          .insert(linePayloads);

        if (liErr) errors.push(`Order ${order.id} line items: ${liErr.message}`);
      }
    } catch (e) {
      errors.push(`Order ${order.id}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  return NextResponse.json({ synced, updated, skipped: 0, total: orders.length, errors: errors.length ? errors : undefined });
}
