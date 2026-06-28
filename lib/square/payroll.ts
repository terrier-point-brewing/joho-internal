import { squareGetAll, squareLocationId } from "./client";

interface SquarePayment {
  id: string;
  status: string;
  source_type: string;
  amount_money: { amount: number; currency: string };
  tip_money?: { amount: number; currency: string };
  total_money: { amount: number; currency: string };
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
  const payments = await squareGetAll<SquarePayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: `${startDate}T00:00:00Z`,
    end_time: `${endDate}T23:59:59Z`,
    sort_order: "ASC",
  });

  const completed = payments.filter((p) => p.status === "COMPLETED");

  const totalPooledTipsCents = completed.reduce(
    (sum, p) => sum + (p.tip_money?.amount ?? 0),
    0
  );
  const totalCashTakeCents = completed
    .filter((p) => p.source_type === "CASH")
    .reduce((sum, p) => sum + p.total_money.amount, 0);

  return { totalPooledTipsCents, totalCashTakeCents };
}
