import { squarePost, squarePostAll, squareLocationId } from "./client";
import { isInvoiceOrder } from "./invoiceOrders";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";

interface InventoryCount {
  catalog_object_id: string;
  catalog_object_type: string;
  state: string;
  location_id: string;
  quantity: string;
  calculated_at: string;
}

/**
 * Current on-hand counts (IN_STOCK) for the given catalog variation ids at the
 * configured location. Returns a map of variation_id → quantity.
 */
export async function fetchCurrentCounts(
  variationIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (variationIds.length === 0) return map;

  const locationId = squareLocationId();

  // Square caps batch-retrieve at 1000 catalog ids per request.
  for (let i = 0; i < variationIds.length; i += 1000) {
    const chunk = variationIds.slice(i, i + 1000);
    const counts = await squarePostAll<InventoryCount>(
      "/inventory/counts/batch-retrieve",
      "counts",
      { catalog_object_ids: chunk, location_ids: [locationId], states: ["IN_STOCK"] },
    );
    for (const c of counts) {
      map.set(c.catalog_object_id, (map.get(c.catalog_object_id) ?? 0) + Number(c.quantity));
    }
  }
  return map;
}

/**
 * Recount a single variation to an absolute quantity by writing a PHYSICAL_COUNT
 * inventory change to Square (the one place this app *writes* inventory).
 *
 * Used when a draft keg is swapped: the mapped draft SKU is set back to its
 * full-keg fl oz so Square's on-hand and the taproom draft-stats stay accurate.
 * `occurredAt` should be the triggering event's timestamp (RFC3339), e.g. the
 * restock order's `closed_at`, so the count lands at the right point in history.
 */
export async function setPhysicalCount(
  variationId: string,
  quantity: number,
  occurredAt: string,
): Promise<void> {
  const locationId = squareLocationId();
  const res = await squarePost<{ errors?: Array<{ detail?: string }> }>(
    "/inventory/changes/batch-create",
    {
      idempotency_key: crypto.randomUUID(),
      changes: [
        {
          type: "PHYSICAL_COUNT",
          physical_count: {
            catalog_object_id: variationId,
            location_id: locationId,
            quantity: String(quantity),
            state: "IN_STOCK",
            occurred_at: occurredAt,
          },
        },
      ],
    },
  );
  if (res.errors?.length) {
    throw new Error(res.errors[0].detail ?? "Square inventory write failed");
  }
}

/**
 * Add units INTO stock as a relative ADJUSTMENT (NONE → IN_STOCK), the entry
 * Square uses for stock arriving from outside its knowledge.
 *
 * Distinct from setPhysicalCount in the way that matters here: it states a
 * DELTA, not a total. It cannot overwrite whatever Square believes, so it is
 * safe to apply while the two sides' absolute counts are still in dispute —
 * which is exactly the state the cold-storage push gate exists to protect (see
 * lib/square/pushGate). That gate guards absolute projections of cold storage
 * onto Square; this is the opposite shape — a correction paired 1:1 with a
 * deduction this app's own invoice caused — so it is deliberately not behind it.
 * Nothing else may reuse this to sneak an absolute push past that gate.
 */
export async function receiveStock(
  variationId: string,
  quantity: number,
  occurredAt: string,
): Promise<void> {
  const locationId = squareLocationId();
  const res = await squarePost<{ errors?: Array<{ detail?: string }> }>(
    "/inventory/changes/batch-create",
    {
      idempotency_key: crypto.randomUUID(),
      changes: [
        {
          type: "ADJUSTMENT",
          adjustment: {
            catalog_object_id: variationId,
            location_id: locationId,
            quantity: String(quantity),
            from_state: "NONE",
            to_state: "IN_STOCK",
            occurred_at: occurredAt,
          },
        },
      ],
    },
  );
  if (res.errors?.length) {
    throw new Error(res.errors[0].detail ?? "Square inventory adjustment failed");
  }
}

interface OrderLineItem {
  uid?: string;
  catalog_object_id?: string;
  quantity?: string;
  applied_discounts?: Array<{ discount_uid: string }>;
}

interface Order {
  id: string;
  state?: string;
  source?: { name?: string };
  closed_at?: string;
  created_at?: string;
  line_items?: OrderLineItem[];
  discounts?: Array<{ uid: string; name?: string }>;
}

interface OrderSearchResponse {
  orders?: Order[];
  cursor?: string;
  errors?: Array<{ detail: string }>;
}

/**
 * Fetch completed taproom sales for a date range.
 * Returns a map of variation_id → total units sold.
 * Excludes orders sourced from Invoices (those are contract/wholesale, not taproom).
 */
export async function fetchOrderSales(
  startDate: string,
  endDate: string,
  catalogObjectIds?: string[],
): Promise<Map<string, number>> {
  const locationId = squareLocationId();

  const totals = new Map<string, number>();
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids: [locationId],
      query: {
        filter: {
          state_filter: { states: ["COMPLETED"] },
          date_time_filter: {
            closed_at: {
              start_at: new Date(startDate).toISOString(),
              end_at: new Date(endDate).toISOString(),
            },
          },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const data = await squarePost<OrderSearchResponse>("/orders/search", body);
    if (data.errors?.length) throw new Error(data.errors[0].detail);

    for (const order of data.orders ?? []) {
      // Skip invoice orders — those are wholesale/contract, not taproom.
      if (isInvoiceOrder(order)) continue;

      for (const item of order.line_items ?? []) {
        const varId = item.catalog_object_id;
        if (!varId) continue;
        if (catalogObjectIds && !catalogObjectIds.includes(varId)) continue;
        const qty = parseFloat(item.quantity ?? "0");
        if (qty > 0) totals.set(varId, (totals.get(varId) ?? 0) + qty);
      }
    }

    cursor = data.cursor;
  } while (cursor);

  return totals;
}

export interface DayBucketOrder {
  closed_at?: string;
  created_at?: string;
  source?: { name?: string };
  line_items?: Array<{ catalog_object_id?: string; quantity?: string; applied_discounts?: Array<{ discount_uid: string }> }>;
  discounts?: Array<{ uid: string; name?: string }>;
}

/**
 * Pure bucketer: aggregates order line items into a map keyed
 * `"<variationId>\t<YYYY-MM-DD>"` → total units.
 *
 * Skips Invoices-sourced orders (wholesale/contract, not taproom) and orders
 * with neither a closed_at nor created_at timestamp. With `opts.ids` set, only
 * those variations are counted. With `opts.excludeTransfers`, line items that
 * carry a KEG_TRANSFER_DISCOUNT_NAME discount (internal draft transfers, not
 * sales) are dropped.
 */
export function bucketOrderLinesByDay(
  orders: DayBucketOrder[],
  opts?: { ids?: string[]; excludeTransfers?: boolean },
): Map<string, number> {
  const map = new Map<string, number>();

  for (const order of orders) {
    // Skip invoice orders — those are wholesale/contract, not taproom.
    if (isInvoiceOrder(order)) continue;

    const day = (order.closed_at ?? order.created_at)?.slice(0, 10);
    if (!day) continue;

    let transferUids: Set<string> | undefined;
    if (opts?.excludeTransfers) {
      transferUids = new Set(
        (order.discounts ?? [])
          .filter((d) => d.name === KEG_TRANSFER_DISCOUNT_NAME)
          .map((d) => d.uid),
      );
    }

    for (const item of order.line_items ?? []) {
      const varId = item.catalog_object_id;
      if (!varId) continue;
      if (opts?.ids && !opts.ids.includes(varId)) continue;
      if (
        transferUids &&
        (item.applied_discounts ?? []).some((ad) => transferUids!.has(ad.discount_uid))
      ) {
        continue;
      }
      const qty = parseFloat(item.quantity ?? "0");
      if (qty <= 0) continue;
      const key = `${varId}\t${day}`;
      map.set(key, (map.get(key) ?? 0) + qty);
    }
  }

  return map;
}

/**
 * Fetch completed taproom sales for a date range, bucketed per (variation, day).
 * Returns a map keyed `"<variationId>\t<YYYY-MM-DD>"` → total units sold.
 * Uses the same /orders/search request as fetchOrderSales, then excludes
 * invoice-sourced orders and internal keg-transfer line items.
 */
export async function fetchOrderSalesByDay(
  startDate: string,
  endDate: string,
  catalogObjectIds?: string[],
): Promise<Map<string, number>> {
  const locationId = squareLocationId();

  const orders: Order[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids: [locationId],
      query: {
        filter: {
          state_filter: { states: ["COMPLETED"] },
          date_time_filter: {
            closed_at: {
              start_at: new Date(startDate).toISOString(),
              end_at: new Date(endDate).toISOString(),
            },
          },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const data = await squarePost<OrderSearchResponse>("/orders/search", body);
    if (data.errors?.length) throw new Error(data.errors[0].detail);

    orders.push(...(data.orders ?? []));

    cursor = data.cursor;
  } while (cursor);

  return bucketOrderLinesByDay(orders, { ids: catalogObjectIds, excludeTransfers: true });
}

/** One completed "Draft Restock" line item — a bartender-recorded keg swap. */
export interface RestockLineEvent {
  orderId: string;
  lineUid: string; // Square line-item uid — stable idempotency anchor per swap
  squareVariationId: string; // the restock variation (identifies the tap)
  quantity: number; // kegs swapped on this line (defaults to 1)
  occurredAt: string; // order closed_at || created_at (RFC3339)
}

/**
 * Pure extractor: pull individual "Draft Restock" line items out of a batch of
 * orders. Each matching line item is one keg-swap event, keyed by order + line
 * uid so the sync can record it exactly once. Invoice-sourced orders (wholesale)
 * and lines with no timestamp are skipped.
 */
export function extractRestockLineItems(
  orders: Order[],
  restockVariationIds: string[],
): RestockLineEvent[] {
  const idSet = new Set(restockVariationIds);
  if (idSet.size === 0) return [];

  const events: RestockLineEvent[] = [];
  for (const order of orders) {
    if (isInvoiceOrder(order)) continue;
    const occurredAt = order.closed_at ?? order.created_at;
    if (!occurredAt) continue;

    for (const item of order.line_items ?? []) {
      const varId = item.catalog_object_id;
      if (!varId || !idSet.has(varId)) continue;
      const qty = parseFloat(item.quantity ?? "1");
      events.push({
        orderId: order.id,
        lineUid: item.uid ?? varId,
        squareVariationId: varId,
        quantity: qty > 0 ? qty : 1,
        occurredAt,
      });
    }
  }
  return events;
}

/**
 * Fetch completed "Draft Restock" line items for a date range. Same
 * /orders/search request as the sales fetchers, then narrowed to the given
 * restock variation ids via `extractRestockLineItems`.
 */
export async function fetchDraftRestockLineItems(
  startDate: string,
  endDate: string,
  restockVariationIds: string[],
): Promise<RestockLineEvent[]> {
  if (restockVariationIds.length === 0) return [];
  const locationId = squareLocationId();

  const orders: Order[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids: [locationId],
      query: {
        filter: {
          state_filter: { states: ["COMPLETED"] },
          date_time_filter: {
            closed_at: {
              start_at: new Date(startDate).toISOString(),
              end_at: new Date(endDate).toISOString(),
            },
          },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;

    const data = await squarePost<OrderSearchResponse>("/orders/search", body);
    if (data.errors?.length) throw new Error(data.errors[0].detail);

    orders.push(...(data.orders ?? []));
    cursor = data.cursor;
  } while (cursor);

  return extractRestockLineItems(orders, restockVariationIds);
}

