import crypto from "crypto";
import { unstable_cache } from "next/cache";
import { squareGetAll, squarePost } from "./client";
import { dayRangeUtc } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";

export interface SquareRefund {
  id: string;
  status: string;
  amount_money: { amount: number; currency: string };
  payment_id: string;
  order_id: string;
  created_at: string;
  reason?: string;
}

async function fetchRefundsUncached(startDate: string, endDate: string, tz: string): Promise<SquareRefund[]> {
  const { startUtc, endUtc } = dayRangeUtc(startDate, endDate, tz);
  return squareGetAll<SquareRefund>("/refunds", "refunds", {
    begin_time: startUtc,
    end_time: endUtc,
    limit: "100",
  });
}

// Fetched alongside orders by every sales report route; cache cross-request
// (keyed by start/end/tz) on the same tag so one range hits Square once. See
// fetchCompletedOrders for rationale. Bust via revalidateTag("square-sales").
const fetchRefundsCached = unstable_cache(
  fetchRefundsUncached,
  ["square-refunds"],
  { revalidate: 90, tags: ["square-sales"] },
);

// Public entry point — signature unchanged for callers; brewery zone resolved
// centrally so day boundaries follow the configured location.
export async function fetchRefunds(startDate: string, endDate: string): Promise<SquareRefund[]> {
  const tz = await getBreweryTimezone();
  return fetchRefundsCached(startDate, endDate, tz);
}

interface SquareRefundResponse {
  refund: { id: string; status: string };
}

/**
 * Issues a Square refund against a previously captured payment. Used by the
 * allocation adjustment flow when a customer's paid percentage is reduced —
 * never called speculatively; the caller must already know the exact
 * amount owed before invoking this.
 */
export async function createRefund(
  paymentId: string,
  amountCents: number,
  reason: string
): Promise<{ refundId: string; status: string }> {
  const { refund } = await squarePost<SquareRefundResponse>("/refunds", {
    idempotency_key: crypto.randomUUID(),
    payment_id: paymentId,
    amount_money: { amount: amountCents, currency: "USD" },
    reason,
  });
  return { refundId: refund.id, status: refund.status };
}
