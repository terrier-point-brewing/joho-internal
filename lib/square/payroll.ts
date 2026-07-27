import { unstable_cache } from "next/cache";
import { squareGetAll, squareLocationId } from "./client";
import { fetchRefunds } from "./refunds";

interface SquarePayment {
  id: string;
  status: string;
  source_type: string;
  created_at: string; // RFC 3339 UTC
  amount_money: { amount: number; currency: string };
  tip_money?: { amount: number; currency: string };
  total_money: { amount: number; currency: string };
}

interface PaymentInput {
  id: string;
  status: string;
  created_at: string;
  tip_money?: { amount: number };
}

interface RefundInput {
  payment_id: string;
  status: string;
  amount_money: { amount: number };
}

function fetchPaymentsUncached(startDate: string, endDate: string) {
  return squareGetAll<SquarePayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: `${startDate}T00:00:00Z`,
    end_time:   `${endDate}T23:59:59Z`,
    sort_order: "ASC",
  });
}

// Same range is re-fetched by the payroll grid on every save and by both the
// Shifts and Summary queries. Cache cross-request (keyed by start/end) on the
// same tag as orders/refunds so one period hits /payments once.
// Bust via revalidateTag("square-sales") after a sale-data sync.
const fetchPayments = unstable_cache(
  fetchPaymentsUncached,
  ["square-payments"],
  { revalidate: 90, tags: ["square-sales"] },
);

/** Convert UTC RFC 3339 to Eastern local date (YYYY-MM-DD). */
function toEasternDate(utcStr: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcStr));
}

export interface DailyTips {
  date: string; // YYYY-MM-DD Eastern local date
  tipsPooledCents: number;
}

/**
 * Pure aggregation of payments + refunds into per-day pooled (card) tip totals.
 * Square keeps a payment's status COMPLETED even after it's refunded (the refund
 * is a separate object), so a refunded tip is netted out here or it silently
 * inflates the day's pool. A refund is attributed to its original payment's day
 * (not the refund's own date), and a payment's net tip is floored at zero so a
 * refund larger than the tip can't push the pool negative.
 * Extracted for unit testing; fetchTipsAndCashTakeByDay wraps the Square calls.
 */
export function aggregateDailyTips(
  payments: PaymentInput[],
  refunds: RefundInput[]
): DailyTips[] {
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds) {
    if (r.status !== "COMPLETED") continue;
    refundedByPayment.set(r.payment_id, (refundedByPayment.get(r.payment_id) ?? 0) + r.amount_money.amount);
  }

  const acc = new Map<string, number>();
  for (const p of payments) {
    if (p.status !== "COMPLETED") continue;
    const date = toEasternDate(p.created_at);
    const tip = p.tip_money?.amount ?? 0;
    const refunded = refundedByPayment.get(p.id) ?? 0;
    acc.set(date, (acc.get(date) ?? 0) + Math.max(0, tip - refunded));
  }

  return Array.from(acc.entries()).map(([date, tips]) => ({ date, tipsPooledCents: tips }));
}

/**
 * Fetches all COMPLETED payments and refunds and returns per-day pooled (card)
 * tip totals net of refunds, keyed by Eastern local date. Cash tips are no
 * longer estimated from cash take — they come per-employee from Square-declared
 * shift cash tips (see lib/square/labor.ts).
 */
export async function fetchTipsAndCashTakeByDay(
  startDate: string,
  endDate: string
): Promise<DailyTips[]> {
  const [payments, refunds] = await Promise.all([
    fetchPayments(startDate, endDate),
    fetchRefunds(startDate, endDate),
  ]);

  return aggregateDailyTips(payments, refunds);
}
