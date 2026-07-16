import { unstable_cache } from "next/cache";
import { squarePost, squarePostAll, squareLocationId, squareGet, isSquareNotFound } from "./client";
import { isInvoiceOrder } from "./invoiceOrders";
import type { Order, SquareInvoice } from "@/types/square";
import { dayRangeUtc } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";

function dateRange(startDate: string, endDate: string, tz: string) {
  const { startUtc, endUtc } = dayRangeUtc(startDate, endDate, tz);
  return { start_at: startUtc, end_at: endUtc };
}

// POS / hardware orders — completed only. `tz` (the active brewery zone) is an
// explicit arg so it participates in the cache key below and day boundaries
// follow the configured location, not the server's UTC.
async function fetchCompletedOrdersUncached(startDate: string, endDate: string, tz: string): Promise<Order[]> {
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: dateRange(startDate, endDate, tz) },
        state_filter: { states: ["COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
}

// SearchOrders paginates sequentially, and ~13 report routes fetch the same
// date range independently. Cache cross-request (keyed by start/end/tz via the
// function args) so a burst of report tabs for one range hits Square once, not
// once per route. Bust via revalidateTag("square-sales") after a sale-data sync
// or a brewery-timezone change.
const fetchCompletedOrdersCached = unstable_cache(
  fetchCompletedOrdersUncached,
  ["square-completed-orders"],
  { revalidate: 90, tags: ["square-sales"] },
);

// Public entry point — signature unchanged for the ~10 report routes that call
// it. The brewery zone is resolved centrally here so no caller has to thread it.
export async function fetchCompletedOrders(startDate: string, endDate: string): Promise<Order[]> {
  const tz = await getBreweryTimezone();
  return fetchCompletedOrdersCached(startDate, endDate, tz);
}

// Canceled orders in a window — so the range sync/cron can withdraw an order
// that was synced while COMPLETED and later canceled (the webhook catches these
// in real time; this is the safety-net path). Uncached: cancellations are rare
// and staleness here would leave a phantom sale on the books. Filtered by
// created_at like fetchCompletedOrders, so a cancellation of an order created
// before the window is only caught by the webhook, not this backfill.
export async function fetchCanceledOrders(startDate: string, endDate: string): Promise<Order[]> {
  const tz = await getBreweryTimezone();
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: dateRange(startDate, endDate, tz) },
        state_filter: { states: ["CANCELED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
}

// Retrieve specific orders by id (up to 100 per call) via the Batch Retrieve
// Orders API. Uncached and always fresh — the Square webhook calls this with the
// just-changed order id, so it must reflect the latest state, not a 90s cache.
export async function fetchOrdersByIds(orderIds: string[]): Promise<Order[]> {
  if (orderIds.length === 0) return [];
  const all: Order[] = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    const res = await squarePost<{ orders?: Order[] }>("/orders/batch-retrieve", {
      order_ids: orderIds.slice(i, i + 100),
    });
    all.push(...(res.orders ?? []));
  }
  return all;
}

// Fetch Square invoices via the Invoices API.
// The Square Invoices search API does not support date-range filtering — we
// fetch all invoices for the location and let callers filter by year.
export async function fetchSquareInvoices(): Promise<SquareInvoice[]> {
  return squarePostAll<SquareInvoice>("/invoices/search", "invoices", {
    query: {
      filter: { location_ids: [squareLocationId()] },
      sort:   { field: "INVOICE_SORT_DATE", order: "DESC" },
    },
    limit: 200,
  });
}

/** Fetch one Square invoice by id (GET /invoices/{id}); null if not found. */
export async function fetchSquareInvoiceById(invoiceId: string): Promise<SquareInvoice | null> {
  try {
    const res = await squareGet<{ invoice?: SquareInvoice }>(`/invoices/${invoiceId}`);
    return res.invoice ?? null;
  } catch (err) {
    if (isSquareNotFound(err)) return null;
    throw err;
  }
}

// Invoice orders — includes OPEN (unpaid) and COMPLETED so we can show outstanding balances
export async function fetchInvoiceOrders(startDate: string, endDate: string): Promise<Order[]> {
  const tz = await getBreweryTimezone();
  const all = await squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: dateRange(startDate, endDate, tz) },
        state_filter: { states: ["OPEN", "COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
  return all.filter((o) => isInvoiceOrder(o));
}
