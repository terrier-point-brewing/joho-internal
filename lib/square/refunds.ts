import crypto from "crypto";
import { squareGetAll, squarePost } from "./client";
import { dayRangeUtc } from "@/lib/utils/datetime";

export interface SquareRefund {
  id: string;
  status: string;
  amount_money: { amount: number; currency: string };
  payment_id: string;
  order_id: string;
  created_at: string;
  reason?: string;
}

export async function fetchRefunds(startDate: string, endDate: string): Promise<SquareRefund[]> {
  const { startUtc, endUtc } = dayRangeUtc(startDate, endDate);
  return squareGetAll<SquareRefund>("/refunds", "refunds", {
    begin_time: startUtc,
    end_time: endUtc,
    limit: "100",
  });
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
