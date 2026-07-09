/**
 * POST /api/finance/expenses/sync?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Imports Ramp spend for the range as clean `expenses` rows (source='ramp') and
 * auto-maps them to the chart of accounts via the account rule table. Manual
 * per-expense overrides are preserved. Returns import + mapping counts.
 *
 * Ramp is the only source wired today; add sibling importers here as needed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampTransactions, getRampBills } from "@/lib/ramp";
import { rampTxnToExpenseRecord, rampBillToExpenseRecords, syncExpenseRecords } from "@/lib/finance/rampExpenses";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const to   = req.nextUrl.searchParams.get("to")   ?? undefined;

  try {
    const [txns, bills] = await Promise.all([getRampTransactions(from, to), getRampBills(from, to)]);
    const records = [
      ...txns.map(rampTxnToExpenseRecord),
      ...bills.flatMap(rampBillToExpenseRecords),
    ];
    const supabase = createSupabaseAdminClient();
    const result = await syncExpenseRecords(supabase, records);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
