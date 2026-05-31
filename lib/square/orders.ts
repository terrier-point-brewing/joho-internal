import { squarePostAll } from "./client";
import type { Order } from "@/types/square";

export async function fetchCompletedOrders(startDate: string, endDate: string): Promise<Order[]> {
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) throw new Error("SQUARE_LOCATION_ID not set");

  const startAt = new Date(startDate + "T00:00:00").toISOString();
  const endAt = new Date(endDate + "T23:59:59").toISOString();

  return squarePostAll<Order>("/orders/search", "orders", {
    location_ids: [locationId],
    query: {
      filter: {
        date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
        state_filter: { states: ["COMPLETED"] },
      },
    },
    return_entries: false,
    limit: 500,
  });
}
