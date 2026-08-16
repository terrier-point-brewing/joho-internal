import crypto from "crypto";
import { unstable_cache } from "next/cache";
import { squareGetAll, squarePost, SquareApiError } from "./client";
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
 * Statuses that mean Square accepted the refund and the money is on its way.
 * `PENDING` belongs here: an ACH refund is never immediately `COMPLETED`, and
 * treating it as a failure would leave a real credit unrecorded.
 */
const ACCEPTED_REFUND_STATUSES = new Set(["COMPLETED", "PENDING"]);

/**
 * Thrown when Square declined the refund and NO money moved — either a non-2xx
 * response, or a 200 carrying a terminal `FAILED`/`REJECTED` status. Callers
 * may report this to the operator as "nothing happened, safe to try again";
 * every other error must be treated as ambiguous.
 */
export class RefundDeclinedError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = "RefundDeclinedError";
  }
}

/**
 * Issues a Square refund against a previously captured payment. Used by the
 * allocation adjustment flow when a customer's paid percentage is reduced —
 * never called speculatively; the caller must already know the exact
 * amount owed before invoking this.
 *
 * Returning normally means Square accepted the refund. A declined refund throws
 * `RefundDeclinedError` rather than returning a failed status, because every
 * caller's next move is to write a credit to the books: a `FAILED` refund handed
 * back as a normal return reads as success and records money that never moved.
 */
export async function createRefund(
  paymentId: string,
  amountCents: number,
  reason: string
): Promise<{ refundId: string; status: string }> {
  let refund: SquareRefundResponse["refund"];
  try {
    ({ refund } = await squarePost<SquareRefundResponse>("/refunds", {
      idempotency_key: crypto.randomUUID(),
      payment_id: paymentId,
      amount_money: { amount: amountCents, currency: "USD" },
      reason,
    }));
  } catch (e) {
    // A rejected request never moved money. Anything else — a dropped
    // connection, a timeout — is genuinely ambiguous and is rethrown as-is so
    // the caller does not tell the operator "nothing happened" on a maybe.
    if (e instanceof SquareApiError) {
      throw new RefundDeclinedError(`Square declined the refund: ${e.message}`, e.code);
    }
    throw e;
  }

  if (!ACCEPTED_REFUND_STATUSES.has(refund.status)) {
    throw new RefundDeclinedError(
      `Square returned the refund as ${refund.status} — no money was moved. This usually means the original payment can no longer be refunded (an ACH payment past its window, or a card that has been closed). Refund the partner another way and record it by hand.`,
    );
  }

  return { refundId: refund.id, status: refund.status };
}
