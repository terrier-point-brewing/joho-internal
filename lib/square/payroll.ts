import { squareGetAll, squareLocationId } from "./client";

interface SquarePayment {
  id: string;
  status: string;
  source_type: string;
  created_at: string; // RFC 3339 UTC
  amount_money: { amount: number; currency: string };
  tip_money?: { amount: number; currency: string };
  total_money: { amount: number; currency: string };
}

function fetchPayments(startDate: string, endDate: string) {
  return squareGetAll<SquarePayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: `${startDate}T00:00:00Z`,
    end_time:   `${endDate}T23:59:59Z`,
    sort_order: "ASC",
  });
}

/** Convert UTC RFC 3339 to Eastern local date (YYYY-MM-DD). */
function toEasternDate(utcStr: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcStr));
}

/**
 * Fetches all COMPLETED payments for the location within [startDate, endDate].
 * Returns:
 *   totalPooledTipsCents — sum of tip_money across all payments (card + cash)
 *   totalCashTakeCents   — sum of total_money where source_type = "CASH"
 */
export async function fetchTipsAndCashTake(
  startDate: string,
  endDate: string
): Promise<{ totalPooledTipsCents: number; totalCashTakeCents: number }> {
  const payments = (await fetchPayments(startDate, endDate)).filter(
    (p) => p.status === "COMPLETED"
  );
  return {
    totalPooledTipsCents: payments.reduce((sum, p) => sum + (p.tip_money?.amount ?? 0), 0),
    totalCashTakeCents: payments
      .filter((p) => p.source_type === "CASH")
      .reduce((sum, p) => sum + p.total_money.amount, 0),
  };
}

export interface DailyTips {
  date: string; // YYYY-MM-DD Eastern local date
  tipsPooledCents: number;
  cashTakeCents: number;
}

/**
 * Same as fetchTipsAndCashTake but returns per-day totals (Eastern local date).
 * Used when tip_pool_frequency is "daily" or "weekly".
 */
export async function fetchTipsAndCashTakeByDay(
  startDate: string,
  endDate: string
): Promise<DailyTips[]> {
  const payments = (await fetchPayments(startDate, endDate)).filter(
    (p) => p.status === "COMPLETED"
  );

  const acc = new Map<string, { tips: number; cash: number }>();
  for (const p of payments) {
    const date = toEasternDate(p.created_at);
    if (!acc.has(date)) acc.set(date, { tips: 0, cash: 0 });
    const day = acc.get(date)!;
    day.tips += p.tip_money?.amount ?? 0;
    if (p.source_type === "CASH") day.cash += p.total_money.amount;
  }

  return Array.from(acc.entries()).map(([date, { tips, cash }]) => ({
    date,
    tipsPooledCents: tips,
    cashTakeCents: cash,
  }));
}
