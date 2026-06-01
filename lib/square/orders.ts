import { squarePostAll } from "./client";
import type { Order } from "@/types/square";

function locationId(): string {
  const id = process.env.SQUARE_LOCATION_ID;
  if (!id) throw new Error("SQUARE_LOCATION_ID not set");
  return id;
}

function dateRange(startDate: string, endDate: string) {
  return {
    start_at: new Date(startDate + "T00:00:00").toISOString(),
    end_at:   new Date(endDate   + "T23:59:59").toISOString(),
  };
}

// POS / hardware orders — completed only
export async function fetchCompletedOrders(startDate: string, endDate: string): Promise<Order[]> {
  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [locationId()],
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

// Invoice orders — includes OPEN (unpaid) and COMPLETED so we can show outstanding balances
export async function fetchInvoiceOrders(startDate: string, endDate: string): Promise<Order[]> {
  const all = await squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [locationId()],
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
