/**
 * POST /api/finance/ramp/expenses/sync?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Pulls Ramp transactions for the range, imports them as clean ramp_expenses
 * rows, and auto-maps them to the chart of accounts via the GL→CoA rule table.
 * Manual per-expense overrides are preserved. Returns import + mapping counts.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampTransactions } from "@/lib/ramp";
import { syncRampExpenses } from "@/lib/finance/rampExpenseSync";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const to   = req.nextUrl.searchParams.get("to")   ?? undefined;

  try {
    const txns     = await getRampTransactions(from, to);
    const supabase = createSupabaseAdminClient();
    const result   = await syncRampExpenses(supabase, txns);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
