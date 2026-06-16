/**
 * GET /api/finance/statements/cash-flow?year=YYYY[&month=M]
 *
 * Direct-method operating cash flow from Square sources only.
 * Returns monthly columns (month=0 → all months of the year).
 *
 * Cash In:
 *   - Square POS: net_sales_cents from completed orders in the period
 *   - Square Invoices: total_cents from paid invoices in the period
 *
 * Cash Out:
 *   - Ramp card spend — NOT YET CONNECTED
 *
 * Note: month=0 returns a full-year MoM breakdown (one entry per month).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export interface CashFlowMonth {
  month: string;           // "YYYY-MM"
  pos_cents: number;       // Square POS net sales
  invoices_paid_cents: number; // Square paid invoices
  cash_in_cents: number;   // pos + invoices_paid
  cash_out_cents: number;  // 0 until Ramp connected
  net_cents: number;       // cash_in - cash_out
}

export interface CashFlowResponse {
  year: number;
  months: CashFlowMonth[];
  totals: CashFlowMonth;  // sum across all months
}

export async function GET(req: NextRequest) {
  try { await requireRole("viewer"); } catch (res) { return res as Response; }

  const year    = Number(req.nextUrl.searchParams.get("year") ?? new Date().getFullYear());
  const supabase = createSupabaseAdminClient();

  const start = `${year}-01-01`;
  const end   = `${year + 1}-01-01`;

  // POS: net_sales_cents from completed square_orders in the year, by month
  const { data: posRows } = await supabase
    .from("pos_line_items")
    .select("net_sales_cents, square_orders!inner ( transaction_date )")
    .gte("square_orders.transaction_date", `${start}T00:00:00Z`)
    .lt("square_orders.transaction_date", `${end}T00:00:00Z`);

  // Paid invoices: total_cents of invoices with status=paid, by invoice_date month
  // Use invoice_date as the recognition date for cash-basis cash flow
  const { data: paidInvoices } = await supabase
    .from("invoices")
    .select("total_cents, invoice_date")
    .eq("status", "paid")
    .gte("invoice_date", start)
    .lt("invoice_date", end);

  // Accumulate into monthly buckets
  const posMap     = new Map<string, number>();
  const invoiceMap = new Map<string, number>();

  for (const row of posRows ?? []) {
    const txn = row.square_orders as unknown as { transaction_date: string };
    const d   = new Date(txn.transaction_date);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    posMap.set(key, (posMap.get(key) ?? 0) + (row.net_sales_cents ?? 0));
  }

  for (const inv of paidInvoices ?? []) {
    if (!inv.invoice_date) continue;
    const key = inv.invoice_date.slice(0, 7);
    invoiceMap.set(key, (invoiceMap.get(key) ?? 0) + inv.total_cents);
  }

  // Build 12-month result (or up to current month for current year)
  const now      = new Date();
  const maxMonth = year < now.getFullYear() ? 12 : now.getMonth() + 1;

  const months: CashFlowMonth[] = [];
  for (let m = 1; m <= maxMonth; m++) {
    const key        = `${year}-${String(m).padStart(2, "0")}`;
    const pos        = posMap.get(key) ?? 0;
    const inv        = invoiceMap.get(key) ?? 0;
    const cash_in    = pos + inv;
    const cash_out   = 0; // Ramp not yet connected
    months.push({ month: key, pos_cents: pos, invoices_paid_cents: inv, cash_in_cents: cash_in, cash_out_cents: cash_out, net_cents: cash_in - cash_out });
  }

  const totals: CashFlowMonth = months.reduce(
    (acc, m) => ({
      month: `${year}`,
      pos_cents:            acc.pos_cents            + m.pos_cents,
      invoices_paid_cents:  acc.invoices_paid_cents  + m.invoices_paid_cents,
      cash_in_cents:        acc.cash_in_cents        + m.cash_in_cents,
      cash_out_cents:       acc.cash_out_cents       + m.cash_out_cents,
      net_cents:            acc.net_cents             + m.net_cents,
    }),
    { month: `${year}`, pos_cents: 0, invoices_paid_cents: 0, cash_in_cents: 0, cash_out_cents: 0, net_cents: 0 }
  );

  return NextResponse.json({ year, months, totals } satisfies CashFlowResponse);
}
