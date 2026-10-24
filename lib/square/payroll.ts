import { unstable_cache } from "next/cache";
import { squareGetAll, squareLocationId } from "./client";
import { fetchRefunds } from "./refunds";
import { fetchCompletedOrders } from "./orders";
import type { Order } from "@/types/square";
import { dayStartUtc, dayEndUtc, addDaysStr } from "@/lib/utils/datetime";

interface SquarePayment {
  id: string;
  status: string;
  source_type: string;
  created_at: string; // RFC 3339 UTC
  order_id?: string;
  amount_money: { amount: number; currency: string };
  tip_money?: { amount: number; currency: string };
  total_money: { amount: number; currency: string };
}

interface PaymentInput {
  id: string;
  status: string;
  created_at: string;
  order_id?: string;
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

// Tabs opened on the last day of the range are often paid after local
// midnight (the close-out). Those payments carry the range's tips, so the
// window runs to brewery-local day end plus a 12h tail, not UTC midnight —
// which in Raleigh is 8pm the evening before, and used to drop every late
// payment on a period's last day outright.
const CLOSE_OUT_TAIL_MS = 12 * 60 * 60 * 1000;

function fetchPaymentsUncached(startDate: string, endDate: string) {
  const endUtc = new Date(new Date(dayEndUtc(endDate)).getTime() + CLOSE_OUT_TAIL_MS).toISOString();
  return squareGetAll<SquarePayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: dayStartUtc(startDate),
    end_time:   endUtc,
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
 *
 * A tip belongs to the day the tab was OPENED (the order's created_at), not the
 * day the card was run. A Friday tab settled at 12:01am Saturday was earned by
 * Friday's crew; keyed by payment time it fell into Saturday's pool, where the
 * hours that earned it don't exist. Auto gratuity always used the order's open
 * time; card tips now match. Payment time is only the fallback for a payment
 * whose order isn't in the window (a payment with no order, or an order still
 * open when the range was fetched).
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

  const orderOpenedAt = new Map<string, string>();
  for (const o of orders) if (o.created_at) orderOpenedAt.set(o.id, o.created_at);

  // Refund left over after the tip absorbed its share, keyed by payment.
  const refundLeftover = new Map<string, number>();
  for (const p of payments) {
    if (p.status !== "COMPLETED") continue;
    const tip = p.tip_money?.amount ?? 0;
    const refunded = refundedByPayment.get(p.id) ?? 0;
    const openedAt = (p.order_id && orderOpenedAt.get(p.order_id)) || p.created_at;
    add(toEasternDate(openedAt), Math.max(0, tip - refunded));
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
  // Orders are fetched one day past the range so a payment in the 12h tail
  // resolves to its tab's open day. The extra day is its own small fetch so the
  // main range stays on the cache entry every other payroll query shares.
  const [payments, refunds, orders, nextDayOrders] = await Promise.all([
    fetchPayments(startDate, endDate),
    fetchRefunds(startDate, endDate),
    fetchCompletedOrders(startDate, endDate),
    fetchCompletedOrders(addDaysStr(endDate, 1), addDaysStr(endDate, 1)),
  ]);

  // Only the range's own days: a tab opened after midnight on the day past the
  // range belongs to the next period, which fetches it as its own first day.
  return aggregateDailyTips(payments, refunds, [...orders, ...nextDayOrders])
    .filter((r) => r.date >= startDate && r.date <= endDate);
}
