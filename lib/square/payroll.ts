import { unstable_cache } from "next/cache";
import { squareGetAll, squareLocationId } from "./client";
import { fetchRefunds } from "./refunds";
import { fetchCompletedOrders } from "./orders";
import type { Order } from "@/types/square";

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

/** The slice of a Square order the pool needs: when, which payment(s), and the
 *  automatic-gratuity service charges (Square's "20% for Large Parties"). */
export type OrderInput = Pick<Order, "id" | "state" | "created_at" | "service_charges" | "tenders">;

/** Automatic gratuity on one order, in cents. Only AUTO_GRATUITY charges —
 *  a CUSTOM service charge (a rental fee, say) is house revenue, not tips. */
export function autoGratuityCents(order: Pick<Order, "service_charges">): number {
  return (order.service_charges ?? [])
    .filter(sc => sc.type === "AUTO_GRATUITY")
    .reduce((sum, sc) => sum + (sc.applied_money?.amount ?? 0), 0);
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
  /** Card tips + automatic gratuity, net of refunds. */
  tipsPooledCents: number;
}

/**
 * Pure aggregation of payments + orders + refunds into per-day pooled (card)
 * tip totals. The pool is tip_money on each payment PLUS the order's automatic
 * gratuity (a large-party service charge Square books outside tip_money —
 * without it a bartender's real card tips can never be pinned, because the
 * pool guard sees a pool that is short by exactly the gratuity).
 *
 * Square keeps a payment's status COMPLETED even after it's refunded (the refund
 * is a separate object), so a refunded tip is netted out here or it silently
 * inflates the day's pool. A refund is attributed to its original payment's day
 * (not the refund's own date). Netting order: the refund comes out of the tip
 * first, then any remainder out of that order's auto gratuity, then it's the
 * sale's problem — a payment's net can never go below zero.
 * Extracted for unit testing; fetchTipsAndCashTakeByDay wraps the Square calls.
 */
export function aggregateDailyTips(
  payments: PaymentInput[],
  refunds: RefundInput[],
  orders: OrderInput[] = [],
): DailyTips[] {
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds) {
    if (r.status !== "COMPLETED") continue;
    refundedByPayment.set(r.payment_id, (refundedByPayment.get(r.payment_id) ?? 0) + r.amount_money.amount);
  }

  const acc = new Map<string, number>();
  const add = (date: string, cents: number) => acc.set(date, (acc.get(date) ?? 0) + cents);

  // Refund left over after the tip absorbed its share, keyed by payment.
  const refundLeftover = new Map<string, number>();
  for (const p of payments) {
    if (p.status !== "COMPLETED") continue;
    const tip = p.tip_money?.amount ?? 0;
    const refunded = refundedByPayment.get(p.id) ?? 0;
    add(toEasternDate(p.created_at), Math.max(0, tip - refunded));
    if (refunded > tip) refundLeftover.set(p.id, refunded - tip);
  }

  for (const o of orders) {
    if (o.state !== "COMPLETED") continue;
    const gratuity = autoGratuityCents(o);
    if (gratuity <= 0) continue;
    let leftover = 0;
    for (const t of o.tenders ?? []) {
      if (t.payment_id) leftover += refundLeftover.get(t.payment_id) ?? 0;
    }
    add(toEasternDate(o.created_at), Math.max(0, gratuity - leftover));
  }

  return Array.from(acc.entries())
    .map(([date, tips]) => ({ date, tipsPooledCents: tips }));
}

/**
 * Fetches all COMPLETED payments, orders and refunds and returns per-day pooled
 * (card) tip totals — tip_money plus automatic gratuity, net of refunds — keyed
 * by Eastern local date. Cash tips are no
 * longer estimated from cash take — they come per-employee from Square-declared
 * shift cash tips (see lib/square/labor.ts).
 */
export async function fetchTipsAndCashTakeByDay(
  startDate: string,
  endDate: string
): Promise<DailyTips[]> {
  const [payments, refunds, orders] = await Promise.all([
    fetchPayments(startDate, endDate),
    fetchRefunds(startDate, endDate),
    fetchCompletedOrders(startDate, endDate),
  ]);

  return aggregateDailyTips(payments, refunds, orders);
}
