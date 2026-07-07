/**
 * Shared Square-orders → finance-transactions sync.
 *
 * Pulls completed Square orders and upserts them into `square_orders`, then
 * (re)builds their line items:
 *   - POS orders            → `pos_line_items`
 *   - Invoice-backed orders → `invoice_line_items` (linked to the `invoices` table)
 *
 * Idempotent per `square_order_id` — re-running an order refreshes it in place.
 *
 * Two entry points share the same core so the manual month/year sync route, the
 * daily cron, and the near-real-time Square webhook all write identical rows:
 *   - `syncPosTransactionsForRange` — fetch a date window (route + cron)
 *   - `syncPosOrdersByIds`          — fetch specific orders (webhook, per event)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Order } from "@/types/square";
import { fetchCompletedOrders, fetchCanceledOrders, fetchOrdersByIds } from "@/lib/square/orders";

const BATCH_SIZE = 100;

export interface PosSyncResult {
  synced: number;
  total: number;
  posOrders: number;
  invoiceOrders: number;
  canceled: number;
  errors?: string[];
}

/** What the sync should do with a fetched order, based on its Square state. */
export type OrderSyncAction = "upsert" | "cancel" | "skip";

/** Catalog-variation → chart-of-accounts mapping row (source-aware overrides). */
export interface CatalogCoaMapping {
  square_variation_id: string | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts_id_pos: string | null;
  chart_of_accounts_id_invoice: string | null;
}

interface InvoiceLookupRow {
  id: string;
  raw_data: { square_order_id?: string } | null;
}

/**
 * Decide what to do with a fetched order from its Square state. COMPLETED orders
 * are finalized sales (upsert). CANCELED orders must be actively withdrawn — a
 * previously-synced order that flips to CANCELED would otherwise linger as a
 * phantom sale in the grid and statements — so we mark them and clear their line
 * items. OPEN/DRAFT orders aren't sales yet, so we skip them. Kept pure for
 * testing. NOTE: a refund does NOT change order state (a refunded order stays
 * COMPLETED); refunds are handled separately in syncRefunds.ts.
 */
export function classifyOrderForSync(order: Pick<Order, "state">): OrderSyncAction {
  if (order.state === "COMPLETED") return "upsert";
  if (order.state === "CANCELED") return "cancel";
  return "skip";
}

/**
 * Source-aware chart-of-accounts resolvers. POS/invoice-specific override wins,
 * then the default mapping, else null (unmapped — the UI prompts a human).
 */
export function buildCoaResolvers(mappings: CatalogCoaMapping[]): {
  getPosCoA: (variationId: string) => string | null;
  getInvoiceCoA: (variationId: string) => string | null;
} {
  const coaDefault = new Map<string, string>();
  const coaPos = new Map<string, string>();
  const coaInvoice = new Map<string, string>();
  for (const m of mappings) {
    if (!m.square_variation_id) continue;
    if (m.chart_of_accounts_id) coaDefault.set(m.square_variation_id, m.chart_of_accounts_id);
    if (m.chart_of_accounts_id_pos) coaPos.set(m.square_variation_id, m.chart_of_accounts_id_pos);
    if (m.chart_of_accounts_id_invoice) coaInvoice.set(m.square_variation_id, m.chart_of_accounts_id_invoice);
  }
  return {
    getPosCoA: (vid) => coaPos.get(vid) ?? coaDefault.get(vid) ?? null,
    getInvoiceCoA: (vid) => coaInvoice.get(vid) ?? coaDefault.get(vid) ?? null,
  };
}

/** square_order_id → invoice db id, for orders that are invoice-backed. */
export function buildInvoiceLookup(rows: InvoiceLookupRow[]): Map<string, string> {
  return new Map(
    rows
      .filter((r) => r.raw_data?.square_order_id)
      .map((r) => [r.raw_data!.square_order_id as string, r.id]),
  );
}

/** Row for the `square_orders` upsert. Pure — `nowIso` passed in for testing. */
export function buildOrderPayload(order: Order, invoiceId: string | null, nowIso: string) {
  return {
    square_order_id: order.id,
    location_id: order.location_id,
    transaction_date: order.closed_at ?? order.updated_at ?? order.created_at,
    customer_id: order.customer_id ?? null,
    customer_name: null as string | null,
    total_cents: order.total_money?.amount ?? 0,
    tax_cents: order.total_tax_money?.amount ?? 0,
    tip_cents: order.total_tip_money?.amount ?? 0,
    discount_cents: order.total_discount_money?.amount ?? 0,
    status: order.state ?? "COMPLETED",
    raw_data: order as object,
    invoice_id: invoiceId,
    updated_at: nowIso,
  };
}

/** `pos_line_items` rows for one POS order. Pure. */
export function buildPosLineItems(
  orderDbId: string,
  order: Order,
  getPosCoA: (variationId: string) => string | null,
) {
  return (order.line_items ?? []).map((li) => {
    const varId = li.catalog_object_id ?? null;
    return {
      order_id: orderDbId,
      square_line_item_uid: li.uid,
      square_catalog_object_id: varId,
      square_variation_id: varId,
      name: li.name ?? "",
      variation_name: li.variation_name ?? null,
      quantity: parseFloat(li.quantity ?? "1"),
      base_price_cents: li.base_price_money?.amount ?? 0,
      gross_sales_cents: li.gross_sales_money?.amount ?? 0,
      discount_cents: li.total_discount_money?.amount ?? 0,
      net_sales_cents: li.total_money?.amount ?? 0,
      tax_cents: li.total_tax_money?.amount ?? 0,
      chart_of_accounts_id: varId ? getPosCoA(varId) : null,
      raw_data: li as object,
    };
  });
}

/** `invoice_line_items` rows for one invoice-backed order. Pure. */
export function buildInvoiceLineItems(
  invoiceId: string,
  order: Order,
  getInvoiceCoA: (variationId: string) => string | null,
) {
  return (order.line_items ?? []).map((li, idx) => {
    const varId = li.catalog_object_id ?? null;
    return {
      invoice_id: invoiceId,
      sort_order: idx + 1,
      description: [li.name, li.variation_name].filter(Boolean).join(" – "),
      quantity: parseFloat(li.quantity ?? "1"),
      unit_price_cents: li.base_price_money?.amount ?? 0,
      total_cents: li.total_money?.amount ?? 0,
      gross_sales_cents: li.gross_sales_money?.amount ?? 0,
      discount_cents: li.total_discount_money?.amount ?? 0,
      net_sales_cents: li.total_money?.amount ?? 0,
      square_catalog_object_id: varId,
      square_variation_id: varId,
      square_line_item_uid: li.uid ?? null,
      chart_of_accounts_id: varId ? getInvoiceCoA(varId) : null,
    };
  });
}

/**
 * Core: upsert a set of already-fetched Square orders into finance transactions.
 * Filters to syncable (COMPLETED) orders, resolves CoA + invoice links, then
 * upserts orders and rebuilds their line items idempotently.
 */
export async function syncSquareOrders(
  supabase: SupabaseClient,
  ordersInput: Order[],
): Promise<PosSyncResult> {
  const actionable = ordersInput
    .map((order) => ({ order, action: classifyOrderForSync(order) }))
    .filter((x) => x.action !== "skip");
  if (actionable.length === 0) {
    return { synced: 0, total: 0, posOrders: 0, invoiceOrders: 0, canceled: 0 };
  }
  const orders = actionable.map((x) => x.order);
  const actionByOrderId = new Map<string, OrderSyncAction>(actionable.map((x) => [x.order.id, x.action]));

  const [mappingsRes, invoiceRes] = await Promise.all([
    supabase
      .from("square_catalog_variations")
      .select("square_variation_id, chart_of_accounts_id, chart_of_accounts_id_pos, chart_of_accounts_id_invoice"),
    supabase.from("invoices").select("id, raw_data").not("raw_data->square_order_id", "is", null),
  ]);

  const { getPosCoA, getInvoiceCoA } = buildCoaResolvers(mappingsRes.data ?? []);
  const invoiceIdByOrderId = buildInvoiceLookup(invoiceRes.data ?? []);

  const nowIso = new Date().toISOString();
  const orderPayloads = orders.map((order) =>
    buildOrderPayload(order, invoiceIdByOrderId.get(order.id) ?? null, nowIso),
  );

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
    for (const row of data ?? []) upsertedIds.set(row.square_order_id, row.id);
  }

  // Split into POS vs invoice-backed by the resolved db ids.
  const posOrderDbIds: string[] = [];
  const invoiceOrderDbIds: string[] = [];
  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;
    (invoiceIdByOrderId.has(order.id) ? invoiceOrderDbIds : posOrderDbIds).push(dbId);
  }

  // Rebuild POS line items: delete existing for these orders, then insert fresh.
  for (let i = 0; i < posOrderDbIds.length; i += BATCH_SIZE) {
    await supabase.from("pos_line_items").delete().in("order_id", posOrderDbIds.slice(i, i + BATCH_SIZE));
  }

  let synced = 0;
  let canceled = 0;
  const posLineItems: object[] = [];
  const invoiceLineItemsToInsert: { invoiceId: string; items: object[] }[] = [];

  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;

    const invoiceId = invoiceIdByOrderId.get(order.id) ?? null;

    // Canceled: the order row stays (status now CANCELED, an audit trail) but its
    // line items are withdrawn so it contributes nothing to statements. POS lines
    // were already deleted above; for invoice-backed orders, clear them here by
    // queueing an empty item set (delete-then-insert-nothing).
    if (actionByOrderId.get(order.id) === "cancel") {
      canceled++;
      if (invoiceId) invoiceLineItemsToInsert.push({ invoiceId, items: [] });
      continue;
    }

    synced++;
    if (invoiceId) {
      invoiceLineItemsToInsert.push({
        invoiceId,
        items: buildInvoiceLineItems(invoiceId, order, getInvoiceCoA),
      });
    } else {
      posLineItems.push(...buildPosLineItems(dbId, order, getPosCoA));
    }
  }

  for (let i = 0; i < posLineItems.length; i += BATCH_SIZE) {
    const { error } = await supabase.from("pos_line_items").insert(posLineItems.slice(i, i + BATCH_SIZE));
    if (error) errors.push(`POS line items batch ${i}: ${error.message}`);
  }

  for (const { invoiceId, items } of invoiceLineItemsToInsert) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const { error } = await supabase.from("invoice_line_items").insert(items.slice(i, i + BATCH_SIZE));
      if (error) errors.push(`Invoice line items (${invoiceId}) batch ${i}: ${error.message}`);
    }
  }

  return {
    synced,
    total: orders.length,
    posOrders: posOrderDbIds.length,
    invoiceOrders: invoiceOrderDbIds.length,
    canceled,
    errors: errors.length ? errors : undefined,
  };
}

/** Date-window sync — used by the manual sync route and the cron. */
export async function syncPosTransactionsForRange(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<PosSyncResult & { dateRange: { startDate: string; endDate: string } }> {
  const [completed, canceled] = await Promise.all([
    fetchCompletedOrders(startDate, endDate),
    fetchCanceledOrders(startDate, endDate),
  ]);
  const result = await syncSquareOrders(supabase, [...completed, ...canceled]);
  return { ...result, dateRange: { startDate, endDate } };
}

/** Single/few-order sync — used by the Square webhook, one order per event. */
export async function syncPosOrdersByIds(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<PosSyncResult> {
  if (orderIds.length === 0) {
    return { synced: 0, total: 0, posOrders: 0, invoiceOrders: 0, canceled: 0 };
  }
  const orders = await fetchOrdersByIds(orderIds);
  return syncSquareOrders(supabase, orders);
}
