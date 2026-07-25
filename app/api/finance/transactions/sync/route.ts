/**
 * POST /api/finance/transactions/sync?year=YYYY&month=M
 *
 * Pulls completed orders from Square and upserts them into square_orders.
 * POS orders → pos_line_items
 * Invoice-backed orders → invoice_line_items (linked to the invoices table)
 *
 * Idempotent — re-running updates existing records.
 * Syncs one month at a time (defaults to current month). Use month=0 for full year.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncPosTransactionsForRange } from "@/lib/finance/syncPosTransactions";
import { syncRefundsForRange } from "@/lib/finance/syncRefunds";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const year       = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const monthParam = req.nextUrl.searchParams.get("month");
  const supabase   = createSupabaseAdminClient();

  const now          = new Date();
  const defaultMonth = year === now.getFullYear() ? now.getMonth() + 1 : 1;
  const month        = monthParam !== null ? parseInt(monthParam) : defaultMonth;

  let startDate: string;
  let endDate: string;

  if (month === 0) {
    startDate = `${year}-01-01`;
    endDate   = `${year}-12-31`;
  } else {
    const m    = month.toString().padStart(2, "0");
    const last = new Date(year, month, 0).getDate();
    startDate  = `${year}-${m}-01`;
    endDate    = `${year}-${m}-${last}`;
  }

  const result = await syncPosTransactionsForRange(supabase, startDate, endDate);
  const refunds = await syncRefundsForRange(supabase, startDate, endDate);

  return NextResponse.json({ updated: 0, skipped: 0, ...result, refunds });
}
