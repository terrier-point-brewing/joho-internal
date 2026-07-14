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

export interface DailyTips {
  date: string; // YYYY-MM-DD Eastern local date
  tipsPooledCents: number;
}

/**
 * Fetches all COMPLETED payments and returns per-day pooled (card) tip totals,
 * keyed by Eastern local date. Cash tips are no longer estimated from cash take —
 * they come per-employee from Square-declared shift cash tips (see lib/square/labor.ts).
 */
export async function fetchTipsAndCashTakeByDay(
  startDate: string,
  endDate: string
): Promise<DailyTips[]> {
  const payments = (await fetchPayments(startDate, endDate)).filter(
    (p) => p.status === "COMPLETED"
  );

  const acc = new Map<string, { tips: number }>();
  for (const p of payments) {
    const date = toEasternDate(p.created_at);
    if (!acc.has(date)) acc.set(date, { tips: 0 });
    acc.get(date)!.tips += p.tip_money?.amount ?? 0;
  }

  return Array.from(acc.entries()).map(([date, { tips }]) => ({
    date,
    tipsPooledCents: tips,
  }));
}
