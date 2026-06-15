/**
 * POST /api/finance/transactions/sync?year=YYYY&month=M
 *
 * Pulls completed orders from Square and upserts them into square_orders.
 * POS orders → pos_line_items
 * Invoice-backed orders → invoice_line_items (linked to the invoices table)
 *
 * Idempotent — re-running updates existing records.
 * Syncs one month at a time (defaults to current month). Use month=0 for full year.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCompletedOrders } from "@/lib/square/orders";

export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year       = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const monthParam = req.nextUrl.searchParams.get("month");
  const supabase   = createSupabaseAdminClient();

  const now          = new Date();
  const defaultMonth = year === now.getFullYear() ? now.getMonth() + 1 : 1;
  const month        = monthParam !== null ? parseInt(monthParam) : defaultMonth;

  let startDate: string;
  let endDate: string;

  if (month === 0) {
    startDate = `${year}-01-01`;
    endDate   = `${year}-12-31`;
  } else {
    const m    = month.toString().padStart(2, "0");
    const last = new Date(year, month, 0).getDate();
    startDate  = `${year}-${m}-01`;
    endDate    = `${year}-${m}-${last}`;
  }

  const [orders, mappings, invoiceRows] = await Promise.all([
    fetchCompletedOrders(startDate, endDate),
    supabase
      .from("square_catalog_variations")
      .select("square_variation_id, chart_of_accounts_id, chart_of_accounts_id_pos, chart_of_accounts_id_invoice"),
    // Load invoice lookup: square_order_id → invoice db id
    supabase
      .from("invoices")
      .select("id, raw_data")
      .not("raw_data->square_order_id", "is", null),
  ]);

  if (orders.length === 0) {
    return NextResponse.json({ synced: 0, updated: 0, skipped: 0, total: 0 });
  }

  // Source-aware CoA resolution: pos/invoice override → default fallback
  const coaDefault  = new Map<string, string>();
  const coaPos      = new Map<string, string>();
  const coaInvoice  = new Map<string, string>();
  for (const m of mappings.data ?? []) {
    if (!m.square_variation_id) continue;
    if (m.chart_of_accounts_id)         coaDefault.set(m.square_variation_id, m.chart_of_accounts_id);
    if (m.chart_of_accounts_id_pos)     coaPos.set(m.square_variation_id, m.chart_of_accounts_id_pos);
    if (m.chart_of_accounts_id_invoice) coaInvoice.set(m.square_variation_id, m.chart_of_accounts_id_invoice);
  }
  const getPosCoA     = (vid: string) => coaPos.get(vid)     ?? coaDefault.get(vid) ?? null;
  const getInvoiceCoA = (vid: string) => coaInvoice.get(vid) ?? coaDefault.get(vid) ?? null;

  // square_order_id → invoice db id
  const invoiceIdByOrderId = new Map<string, string>(
    (invoiceRows.data ?? [])
      .filter((r) => r.raw_data?.square_order_id)
      .map((r) => [r.raw_data.square_order_id as string, r.id])
  );

  // Build order payloads
  const orderPayloads = orders.map((order) => ({
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
    invoice_id:       invoiceIdByOrderId.get(order.id) ?? null,
    updated_at:       new Date().toISOString(),
  }));

  const upsertedIds = new Map<string, string>(); // square_order_id → db id
  const errors: string[] = [];

  for (let i = 0; i < orderPayloads.length; i += BATCH_SIZE) {
    const batch = orderPayloads.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("square_orders")
      .upsert(batch, { onConflict: "square_order_id" })
      .select("id, square_order_id");

    if (error) {
      errors.push(`Batch upsert ${i}–${i + batch.length}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      upsertedIds.set(row.square_order_id, row.id);
    }
  }

  let synced = 0;

  // Separate order ids into POS vs invoice-backed
  const posOrderDbIds: string[] = [];
  const invoiceOrderDbIds: string[] = [];
  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;
    if (invoiceIdByOrderId.has(order.id)) {
      invoiceOrderDbIds.push(dbId);
    } else {
      posOrderDbIds.push(dbId);
    }
  }

  // Delete and re-insert POS line items
  for (let i = 0; i < posOrderDbIds.length; i += BATCH_SIZE) {
    await supabase
      .from("pos_line_items")
      .delete()
      .in("order_id", posOrderDbIds.slice(i, i + BATCH_SIZE));
  }

  const posLineItems: object[] = [];
  const invoiceLineItemsToInsert: { invoiceId: string; items: object[] }[] = [];

  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;
    synced++;

    const invoiceId = invoiceIdByOrderId.get(order.id) ?? null;

    const lineItems = order.line_items ?? [];
    if (invoiceId) {
      // Invoice-backed: delete old invoice_line_items for this invoice then re-insert
      const items = lineItems.map((li, idx) => {
        const varId = li.catalog_object_id ?? null;
        return {
          invoice_id:               invoiceId,
          sort_order:               idx + 1,
          description:              [li.name, li.variation_name].filter(Boolean).join(" – "),
          quantity:                 parseFloat(li.quantity ?? "1"),
          unit_price_cents:         li.base_price_money?.amount ?? 0,
          total_cents:              li.total_money?.amount ?? 0,
          gross_sales_cents:        li.gross_sales_money?.amount ?? 0,
          discount_cents:           li.total_discount_money?.amount ?? 0,
          net_sales_cents:          li.total_money?.amount ?? 0,
          square_catalog_object_id: varId,
          square_variation_id:      varId,
          square_line_item_uid:     li.uid ?? null,
          chart_of_accounts_id:     varId ? getInvoiceCoA(varId) : null,
        };
      });
      invoiceLineItemsToInsert.push({ invoiceId, items });
    } else {
      for (const li of lineItems) {
        const varId = li.catalog_object_id ?? null;
        posLineItems.push({
          order_id:                 dbId,
          square_line_item_uid:     li.uid,
          square_catalog_object_id: varId,
          square_variation_id:      varId,
          name:                     li.name ?? "",
          variation_name:           li.variation_name ?? null,
          quantity:                 parseFloat(li.quantity ?? "1"),
          base_price_cents:         li.base_price_money?.amount ?? 0,
          gross_sales_cents:        li.gross_sales_money?.amount ?? 0,
          discount_cents:           li.total_discount_money?.amount ?? 0,
          net_sales_cents:          li.total_money?.amount ?? 0,
          tax_cents:                li.total_tax_money?.amount ?? 0,
          chart_of_accounts_id:     varId ? getPosCoA(varId) : null,
          raw_data:                 li as object,
        });
      }
    }
  }

  // Insert POS line items
  for (let i = 0; i < posLineItems.length; i += BATCH_SIZE) {
    const { error } = await supabase
      .from("pos_line_items")
      .insert(posLineItems.slice(i, i + BATCH_SIZE));
    if (error) errors.push(`POS line items batch ${i}: ${error.message}`);
  }

  // Re-insert invoice line items (delete first to stay idempotent)
  for (const { invoiceId, items } of invoiceLineItemsToInsert) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const { error } = await supabase
        .from("invoice_line_items")
        .insert(items.slice(i, i + BATCH_SIZE));
      if (error) errors.push(`Invoice line items (${invoiceId}) batch ${i}: ${error.message}`);
    }
  }

  return NextResponse.json({
    synced,
    updated: 0,
    skipped: 0,
    total: orders.length,
    posOrders: posOrderDbIds.length,
    invoiceOrders: invoiceOrderDbIds.length,
    dateRange: { startDate, endDate },
    errors: errors.length ? errors : undefined,
  });
}
