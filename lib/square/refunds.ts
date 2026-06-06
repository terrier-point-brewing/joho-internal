import { squareGetAll } from "./client";
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
