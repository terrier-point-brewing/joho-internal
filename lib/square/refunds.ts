import { squareGetAll } from "./client";

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
  const begin = new Date(startDate + "T00:00:00").toISOString();
  const end   = new Date(endDate   + "T23:59:59").toISOString();
  return squareGetAll<SquareRefund>("/refunds", "refunds", {
    begin_time: begin,
    end_time: end,
    limit: "100",
  });
}
