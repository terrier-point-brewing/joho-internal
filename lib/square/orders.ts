import { unstable_cache } from "next/cache";
import { squarePostAll, squareLocationId } from "./client";
import type { Order, SquareInvoice } from "@/types/square";
import { dayRangeUtc } from "@/lib/utils/datetime";

function dateRange(startDate: string, endDate: string) {
  const { startUtc, endUtc } = dayRangeUtc(startDate, endDate);
  return { start_at: startUtc, end_at: endUtc };
}

// POS / hardware orders — completed only
async function fetchCompletedOrdersUncached(startDate: string, endDate: string): Promise<Order[]> {
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: dateRange(startDate, endDate) },
        state_filter: { states: ["COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
}

// SearchOrders paginates sequentially, and ~13 report routes fetch the same
// date range independently. Cache cross-request (keyed by start/end via the
// function args) so a burst of report tabs for one range hits Square once, not
// once per route. Bust via revalidateTag("square-sales") after a sale-data sync.
export const fetchCompletedOrders = unstable_cache(
  fetchCompletedOrdersUncached,
  ["square-completed-orders"],
  { revalidate: 90, tags: ["square-sales"] },
);

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

// Invoice orders — includes OPEN (unpaid) and COMPLETED so we can show outstanding balances
export async function fetchInvoiceOrders(startDate: string, endDate: string): Promise<Order[]> {
  const all = await squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [squareLocationId()],
    query: {
      filter: {
        date_time_filter: { created_at: dateRange(startDate, endDate) },
        state_filter: { states: ["OPEN", "COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
  return all.filter((o) => o.source?.name === "Invoices");
}
