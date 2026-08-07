/**
 * Shared Square-orders → finance-transactions sync.
 *
 * Pulls completed Square orders and upserts them into `square_orders`, then
 * (re)builds their line items:
 *   - POS orders            → `pos_line_items`
 *   - Invoice-backed orders → `invoice_line_items`, written through the canonical
 *     writer in lib/finance/invoiceLineItems.ts rather than by this module
 *
 * Idempotent per `square_order_id` — re-running an order refreshes it in place,
 * and non-destructive: a chart-of-accounts mapping a person set by hand on
 * either kind of line survives the rebuild.
 *
 * Two entry points share the same core so the manual month/year sync route, the
 * daily cron, and the near-real-time Square webhook all write identical rows:
 *   - `syncPosTransactionsForRange` — fetch a date window (route + cron)
 *   - `syncPosOrdersByIds`          — fetch specific orders (webhook, per event)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem, Order } from "@/types/square";
import { fetchCompletedOrders, fetchCanceledOrders, fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { isReturnOrder } from "@/lib/square/returnOrders";
import { buildLineItemTaxRows, type LineItemTaxRow } from "@/lib/finance/lineItemTaxRows";
import {
  buildLineItemIndexes,
  buildInvoiceLineItemRows,
  persistInvoiceLineItems,
  type LineItemCoa,
} from "@/lib/finance/invoiceLineItems";

// Canonical home is ./lineItemTaxRows; re-exported so existing importers
// (lib/tax/backfillLineItemTaxes.ts, syncPosTransactions.test.ts) keep
// resolving them from here.
export { buildLineItemTaxRows, type LineItemTaxRow };

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
 * GL state already sitting on an invoice line — the chart-of-accounts mapping a
 * person set in the Invoices grid, or the auto-map pass materialized. Read off
 * the rows an invoice rebuild is about to replace, keyed by the DB `sort_order`
 * the canonical writer assigned them, and handed straight to
 * `buildInvoiceLineItemRows` so a re-sync never reverts it.
 */
type ExistingInvoiceCoa = Map<string, Map<number, LineItemCoa>>;

/**
 * Read the CoA already on the line items an invoice rebuild will replace.
 *
 * The invoice-side counterpart of the `pos_line_items` prior-state read below,
 * and it carries the same fail-safe: an invoice whose read errors is returned in
 * `failed` and left completely alone this run, because rebuilding from a blank
 * slate is exactly how a hand-set account gets silently reverted.
 *
 * Keyed by `sort_order` rather than by `square_line_item_uid` because that is
 * the key `persistInvoiceLineItems` upserts on — see the note in
 * `syncSquareOrders` about the two writers that used to disagree about it.
 */
async function readExistingInvoiceCoa(
  supabase: SupabaseClient,
  invoiceIds: string[],
): Promise<{ byInvoice: ExistingInvoiceCoa; failed: Set<string>; errors: string[] }> {
  const byInvoice: ExistingInvoiceCoa = new Map();
  const failed = new Set<string>();
  const errors: string[] = [];

  for (let i = 0; i < invoiceIds.length; i += BATCH_SIZE) {
    const batchIds = invoiceIds.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("invoice_line_items")
      .select("invoice_id, sort_order, chart_of_accounts_id")
      .in("invoice_id", batchIds);

    if (error) {
      errors.push(`Prior invoice line state ${i}–${i + batchIds.length}: ${error.message}`);
      for (const id of batchIds) failed.add(id);
      continue;
    }

    for (const row of (data ?? []) as { invoice_id: string; sort_order: number; chart_of_accounts_id: string | null }[]) {
      if (row.chart_of_accounts_id == null) continue;
      let bySort = byInvoice.get(row.invoice_id);
      if (!bySort) {
        bySort = new Map();
        byInvoice.set(row.invoice_id, bySort);
      }
      bySort.set(row.sort_order, { chart_of_accounts_id: row.chart_of_accounts_id });
    }
  }

  return { byInvoice, failed, errors };
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

  // Only the POS resolver is used here. The invoice side's CoA prefill comes
  // from `buildLineItemIndexes`, part of the canonical invoice writer — the same
  // `chart_of_accounts_id_invoice ?? chart_of_accounts_id` priority, resolved in
  // one place instead of two.
  const { getPosCoA } = buildCoaResolvers(mappingsRes.data ?? []);
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

  // Same read, same fail-safe, for the invoice-backed orders about to be
  // rebuilt. Canceled ones are excluded: their lines are withdrawn, not rebuilt.
  const rebuildInvoiceIds: string[] = [];
  for (const order of orders) {
    if (!upsertedIds.has(order.id)) continue;
    if (actionByOrderId.get(order.id) === "cancel") continue;
    const invoiceId = invoiceIdByOrderId.get(order.id);
    if (invoiceId) rebuildInvoiceIds.push(invoiceId);
  }
  const existingInvoiceCoa = await readExistingInvoiceCoa(supabase, rebuildInvoiceIds);
  errors.push(...existingInvoiceCoa.errors);

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
  const invoiceIdsToClear: string[] = [];
  const invoiceRebuilds: { invoiceId: string; order: Order }[] = [];

  for (const order of orders) {
    const dbId = upsertedIds.get(order.id);
    if (!dbId) continue;

    const invoiceId = invoiceIdByOrderId.get(order.id) ?? null;

    // Canceled: the order row stays (status now CANCELED, an audit trail) but its
    // line items are withdrawn so it contributes nothing to statements. POS lines
    // were already deleted above; for invoice-backed orders, clear them below.
    if (actionByOrderId.get(order.id) === "cancel") {
      canceled++;
      if (invoiceId) invoiceIdsToClear.push(invoiceId);
      continue;
    }

    // Prior line state unreadable ⇒ leave the order exactly as it stands rather
    // than rebuild it from a blank slate, and don't count it as synced — nothing
    // about it changed. (POS lines were never deleted above for these; invoice
    // lines are never deleted ahead of their rebuild at all.)
    if (invoiceId ? existingInvoiceCoa.failed.has(invoiceId) : priorReadFailed.has(dbId)) continue;

    synced++;
    if (invoiceId) {
      invoiceRebuilds.push({ invoiceId, order });
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

  // Invoice-backed orders are written through the CANONICAL invoice-line writer
  // (buildInvoiceLineItemRows + persistInvoiceLineItems in
  // lib/finance/invoiceLineItems.ts) — the same pair syncSquareInvoices, the
  // export routes and the deposit generate read-backs use.
  //
  // This path used to carry an invoice builder of its own, and the two writers
  // disagreed about which row is which: it numbered sort_order from 1 across
  // every order line, while the canonical writer numbers from 0 and drops
  // carve-out excise lines. Since persistInvoiceLineItems upserts on
  // (invoice_id, sort_order), a nightly re-sync first deleted whatever account
  // a person had set, then handed the canonical sync a set of rows shifted by a
  // position — so the preservation that sync does honestly perform preserved
  // the neighbouring line's account onto this one. Aligning the two numbering
  // schemes would have left that agreement resting on a convention that has
  // already drifted once (see CanonicalLineItemRow.square_line_item_uid). There
  // is now one writer, so there is nothing left to agree.
  for (const invoiceId of invoiceIdsToClear) {
    // No rows = delete every line for the invoice, which cascades to the
    // invoice-side line-item tax rows (ON DELETE CASCADE).
    const { error } = await persistInvoiceLineItems(supabase, invoiceId, []);
    if (error) errors.push(`Invoice line items (${invoiceId}) clear: ${error}`);
  }

  if (invoiceRebuilds.length > 0) {
    // Fetched only when there is an invoice to rebuild, so a POS-only window —
    // the common case for the webhook — makes no catalog call at all.
    const catalogItems = (await fetchCatalogItems()) as CatalogItem[];
    const indexes = await buildLineItemIndexes(supabase, catalogItems);

    for (const { invoiceId, order } of invoiceRebuilds) {
      const rows = buildInvoiceLineItemRows(
        invoiceId,
        order,
        indexes,
        existingInvoiceCoa.byInvoice.get(invoiceId) ?? new Map(),
      );
      // Passing `order` also rebuilds invoice_line_item_taxes off the row ids
      // read back afterwards — safe now that this path and the canonical sync
      // key rows the same way.
      const { error } = await persistInvoiceLineItems(supabase, invoiceId, rows, order);
      if (error) errors.push(`Invoice line items (${invoiceId}): ${error}`);
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
