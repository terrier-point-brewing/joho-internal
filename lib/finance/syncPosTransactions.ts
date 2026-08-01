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
import { isReturnOrder } from "@/lib/square/returnOrders";

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
 *
 * Return orders are skipped outright, whatever their state. Square models a
 * refund as its own COMPLETED order carrying no `line_items` and no
 * `total_money` (the money lives in `net_amounts`/`return_amounts`), so the
 * upsert path would store it as a $0 order with no items — a blank phantom row
 * in the Orders ledger that inflates the order count and reads as "unmapped".
 * The refund itself is captured by syncRefunds.ts, which resolves return orders
 * straight from the Square API rather than from `square_orders`, so dropping
 * them here costs no refund attribution.
 */
export function classifyOrderForSync(order: Pick<Order, "state"> & { returns?: unknown[] }): OrderSyncAction {
  if (isReturnOrder(order)) return "skip";
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

/**
 * GL state already sitting on a line-item row — a chart-of-accounts mapping (set
 * by hand in the Orders grid, or materialized by the auto-map pass) and any note.
 * Carried across the delete-and-rebuild in `syncSquareOrders` so a re-sync never
 * silently reverts it.
 */
export interface PriorLineItemState {
  chart_of_accounts_id: string | null;
  notes: string | null;
  /**
   * Whether that mapping was a person's choice rather than the catalog rule.
   * Must ride along with the id: preserving the mapping but dropping this flag
   * would silently reclassify a hand-set account as rule-derived.
   */
  gl_manually_set: boolean;
}

/**
 * `pos_line_items` rows for one POS order. Pure.
 *
 * `priorByUid` carries forward the GL state of the rows this rebuild replaces,
 * keyed by `square_line_item_uid` (stable across re-fetches of an order, unique
 * within it). Without it, re-syncing an order — the nightly cron's trailing
 * window, or any month backfill — would overwrite a human's mapping with the
 * catalog default and drop their notes, with no error and no trace.
 */
export function buildPosLineItems(
  orderDbId: string,
  order: Order,
  getPosCoA: (variationId: string) => string | null,
  priorByUid?: Map<string, PriorLineItemState>,
) {
  return (order.line_items ?? []).map((li) => {
    const varId = li.catalog_object_id ?? null;
    const prior = li.uid ? priorByUid?.get(li.uid) : undefined;
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
      // Square's line `total_money` is gross - discount + TAX. Sales tax is
      // money held for NC DOR / Wake County, not revenue, so net sales is
      // gross - discount and the tax is carried separately in tax_cents.
      // fetchPos maps this column straight onto P&L revenue.
      net_sales_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
      tax_cents: li.total_tax_money?.amount ?? 0,
      // Prior mapping wins over the catalog default — see `priorByUid` above.
      chart_of_accounts_id: prior?.chart_of_accounts_id ?? (varId ? getPosCoA(varId) : null),
      // Only ever true by inheritance: this builder writes the catalog rule, so
      // a row it maps is rule-derived by definition. The flag turns true solely
      // through the Orders grid PATCH.
      gl_manually_set: prior?.gl_manually_set ?? false,
      notes: prior?.notes ?? null,
      raw_data: li as object,
    };
  });
}

/**
 * One row for `pos_line_item_taxes` or its invoice-side sibling table — the
 * two tables are structurally identical, so one builder serves both. The
 * caller decides which table to insert into by which db-id map it passes.
 * (The invoice-side insert itself lives in lib/finance/invoiceLineItems.ts,
 * the canonical writer for that table — see the note below.)
 */
export interface LineItemTaxRow {
  line_item_id: string;
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  amount_cents: number;
}

/**
 * `pos_line_item_taxes` rows for one POS order. Pure. Resolves each line's
 * `applied_taxes[].tax_uid` against the order's `taxes[]` (catalog tax id +
 * name + rate) and looks up the line's already-inserted db id via
 * `lineItemDbIdByUid` (keyed by `square_line_item_uid`, scoped to this order —
 * uids are only unique within a single order's line_items).
 */
export function buildLineItemTaxRows(
  order: Order,
  lineItemDbIdByUid: Map<string, string>,
): LineItemTaxRow[] {
  const taxByUid = new Map((order.taxes ?? []).map((t) => [t.uid, t]));
  const rows: LineItemTaxRow[] = [];
  for (const li of order.line_items ?? []) {
    const lineItemDbId = li.uid ? lineItemDbIdByUid.get(li.uid) : undefined;
    if (!lineItemDbId) continue;
    for (const at of li.applied_taxes ?? []) {
      const tax = taxByUid.get(at.tax_uid);
      if (!tax) continue;
      rows.push({
        line_item_id: lineItemDbId,
        square_tax_id: tax.catalog_object_id ?? tax.uid,
        tax_name: tax.name ?? null,
        tax_pct: tax.percentage != null ? parseFloat(tax.percentage) : null,
        amount_cents: at.applied_money?.amount ?? 0,
      });
    }
  }
  return rows;
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
      // Tax-free, matching lib/finance/invoiceLineItems.ts's canonical builder.
      // Square's line `total_money` includes tax on invoice orders too
      // (verified in raw_data: 10000 - 724 + 673 = 9949).
      total_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
      gross_sales_cents: li.gross_sales_money?.amount ?? 0,
      discount_cents: li.total_discount_money?.amount ?? 0,
      net_sales_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
      square_catalog_variation_id: varId,
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

  // Split into POS vs invoice-backed by the resolved db ids. POS orders split
  // again by action: a canceled one has its line items withdrawn outright, an
  // upserted one is rebuilt from the fetched order.
  const posOrderDbIds: string[] = [];
  const invoiceOrderDbIds: string[] = [];
  const canceledPosDbIds: string[] = [];
  const rebuildPosDbIds: string[] = [];
  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;
    if (invoiceIdByOrderId.has(order.id)) {
      invoiceOrderDbIds.push(dbId);
      continue;
    }
    posOrderDbIds.push(dbId);
    (actionByOrderId.get(order.id) === "cancel" ? canceledPosDbIds : rebuildPosDbIds).push(dbId);
  }

  // Read the GL state off the line items a rebuild is about to replace, so
  // manual mappings and notes survive the round-trip (see buildPosLineItems).
  // If a batch's read fails we must NOT go on to delete it — rebuilding blind
  // is exactly how a mapping gets silently reverted — so those orders are left
  // untouched this run and picked up by the next. Canceled orders need no prior
  // state: their line items are withdrawn, not rebuilt.
  const priorByOrderDbId = new Map<string, Map<string, PriorLineItemState>>();
  const priorReadFailed = new Set<string>();
  for (let i = 0; i < rebuildPosDbIds.length; i += BATCH_SIZE) {
    const batchIds = rebuildPosDbIds.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("pos_line_items")
      .select("order_id, square_line_item_uid, chart_of_accounts_id, gl_manually_set, notes")
      .in("order_id", batchIds);

    if (error) {
      errors.push(`Prior line-item state ${i}–${i + batchIds.length}: ${error.message}`);
      for (const id of batchIds) priorReadFailed.add(id);
      continue;
    }

    for (const row of data ?? []) {
      if (!row.square_line_item_uid) continue;
      if (row.chart_of_accounts_id == null && row.notes == null && !row.gl_manually_set) continue;
      let uidMap = priorByOrderDbId.get(row.order_id);
      if (!uidMap) {
        uidMap = new Map();
        priorByOrderDbId.set(row.order_id, uidMap);
      }
      uidMap.set(row.square_line_item_uid, {
        chart_of_accounts_id: row.chart_of_accounts_id ?? null,
        gl_manually_set: row.gl_manually_set ?? false,
        notes: row.notes ?? null,
      });
    }
  }

  // Rebuild POS line items: delete existing for these orders, then insert fresh.
  const posDbIdsToClear = [
    ...canceledPosDbIds,
    ...rebuildPosDbIds.filter((id) => !priorReadFailed.has(id)),
  ];
  for (let i = 0; i < posDbIdsToClear.length; i += BATCH_SIZE) {
    await supabase.from("pos_line_items").delete().in("order_id", posDbIdsToClear.slice(i, i + BATCH_SIZE));
  }

  let synced = 0;
  let canceled = 0;
  const posLineItems: object[] = [];
  const posOrdersByDbId = new Map<string, Order>(); // for tax-row building, after ids are known
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

    // Prior line items unreadable ⇒ they were never deleted above. Leave the
    // order exactly as it stands rather than rebuild it from a blank slate, and
    // don't count it as synced — nothing about it changed.
    if (!invoiceId && priorReadFailed.has(dbId)) continue;

    synced++;
    if (invoiceId) {
      invoiceLineItemsToInsert.push({
        invoiceId,
        items: buildInvoiceLineItems(invoiceId, order, getInvoiceCoA),
      });
    } else {
      posLineItems.push(...buildPosLineItems(dbId, order, getPosCoA, priorByOrderDbId.get(dbId)));
      posOrdersByDbId.set(dbId, order);
    }
  }

  // Insert POS line items and select their new db ids back (`pos_line_items.id`
  // is server-generated) — needed to key `pos_line_item_taxes.line_item_id`.
  // Grouped per order (square_line_item_uid is only unique within one order).
  const lineItemDbIdByUidByOrderDbId = new Map<string, Map<string, string>>();
  for (let i = 0; i < posLineItems.length; i += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("pos_line_items")
      .insert(posLineItems.slice(i, i + BATCH_SIZE))
      .select("id, order_id, square_line_item_uid");
    if (error) {
      errors.push(`POS line items batch ${i}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      if (!row.square_line_item_uid) continue;
      let uidMap = lineItemDbIdByUidByOrderDbId.get(row.order_id);
      if (!uidMap) {
        uidMap = new Map();
        lineItemDbIdByUidByOrderDbId.set(row.order_id, uidMap);
      }
      uidMap.set(row.square_line_item_uid, row.id);
    }
  }

  // pos_line_item_taxes cascades on pos_line_items delete (FK ON DELETE CASCADE),
  // so re-syncing an order's line items above already dropped its stale tax rows —
  // no separate delete needed here.
  const taxRows: LineItemTaxRow[] = [];
  for (const [orderDbId, order] of posOrdersByDbId) {
    const uidMap = lineItemDbIdByUidByOrderDbId.get(orderDbId);
    if (!uidMap) continue;
    taxRows.push(...buildLineItemTaxRows(order, uidMap));
  }
  for (let i = 0; i < taxRows.length; i += BATCH_SIZE) {
    const { error } = await supabase.from("pos_line_item_taxes").insert(taxRows.slice(i, i + BATCH_SIZE));
    if (error) errors.push(`POS line item taxes batch ${i}: ${error.message}`);
  }

  // NOTE: this path does NOT own the invoice-side line-item tax table. The
  // canonical writer (buildInvoiceLineItemRows + persistInvoiceLineItems in
  // lib/finance/invoiceLineItems.ts) upserts on (invoice_id, sort_order) using
  // a DIFFERENT (0-based, excise-skipping) sort_order than this builder's
  // 1-based one, so a tax-row write keyed to THIS insert's row ids would be
  // silently orphaned or misattributed the moment the canonical sync runs
  // over the same invoice. Rebuilding tax rows is that writer's job alone.
  for (const { invoiceId, items } of invoiceLineItemsToInsert) {
    // The delete cascades to the invoice-side line-item tax rows (ON DELETE
    // CASCADE), so a re-sync converges without a separate tax-row cleanup.
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const { error } = await supabase
        .from("invoice_line_items")
        .insert(items.slice(i, i + BATCH_SIZE));
      if (error) {
        errors.push(`Invoice line items (${invoiceId}) batch ${i}: ${error.message}`);
      }
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
