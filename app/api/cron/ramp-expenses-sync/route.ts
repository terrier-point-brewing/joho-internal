/**
 * Daily cron: keep imported expenses current without anyone clicking "Sync Ramp".
 *
 * Re-syncs a trailing window (idempotent upsert) so recently-posted transactions
 * land and state changes (e.g. PENDING → CLEARED, which the Cash Flow view cares
 * about) get picked up. Older history is backfilled via the on-demand full-year
 * sync on the Expenses tab.
 */
import { NextRequest, NextResponse } from "next/server";
import { getRampTransactions } from "@/lib/ramp";
import { syncRampExpenses } from "@/lib/finance/rampExpenses";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 45;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const to   = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  try {
    const txns     = await getRampTransactions(fromStr, toStr);
    const supabase = createSupabaseAdminClient();
    const result   = await syncRampExpenses(supabase, txns);
    return NextResponse.json({ ...result, window: { from: fromStr, to: toStr } });
  } catch (err) {
    return apiError(err);
  }
}
