import { squarePost, squarePostAll, squareLocationId } from "./client";
import { dayRangeUtc } from "@/lib/utils/datetime";
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

export interface PhysicalCount {
  id: string;
  catalog_object_id: string;
  catalog_object_type: string;
  state: string;
  location_id: string;
  quantity: string;
  occurred_at: string;
  created_at: string;
  team_member_id?: string;
}

interface ChangesResponse {
  changes?: Array<{ type: string; physical_count?: PhysicalCount }>;
  cursor?: string;
  errors?: Array<{ detail: string }>;
}

interface OrderLineItem {
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
      // Skip invoice-sourced orders — those are wholesale/contract, not taproom.
      if (order.source?.name === "Invoices") continue;

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
    // Skip invoice-sourced orders — those are wholesale/contract, not taproom.
    if (order.source?.name === "Invoices") continue;

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

// Fetch physical count inventory changes for a date range.
// Pass catalogObjectIds to filter server-side (much faster than fetching all and filtering).
export async function fetchPhysicalCounts(
  startDate: string,
  endDate: string,
  catalogObjectIds?: string[],
): Promise<PhysicalCount[]> {
  const locationId = squareLocationId();

  const { startUtc: updatedAfter, endUtc: updatedBefore } = dayRangeUtc(startDate, endDate);

  const results: PhysicalCount[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids:   [locationId],
      updated_after:  updatedAfter,
      updated_before: updatedBefore,
      types:          ["PHYSICAL_COUNT"],
      limit:          1000,
    };
    if (cursor) body.cursor = cursor;
    if (catalogObjectIds?.length) body.catalog_object_ids = catalogObjectIds;

    const data = await squarePost<ChangesResponse>("/inventory/changes/batch-retrieve", body);

    if (data.errors?.length) {
      throw new Error(data.errors[0].detail ?? "Inventory API error");
    }

    for (const change of data.changes ?? []) {
      if (change.type === "PHYSICAL_COUNT" && change.physical_count) {
        results.push(change.physical_count);
      }
    }

    cursor = data.cursor;
  } while (cursor);

  return results;
}
