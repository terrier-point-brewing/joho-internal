/**
 * Daily cron: reconcile finance transactions (Square orders + refunds) into
 * square_orders / pos_line_items / square_refunds.
 *
 * Safety net for the Square webhook (app/api/webhooks/square) — if a delivery is
 * missed, this re-syncs a trailing window so the finance grid and financial
 * statements self-heal within a day. Idempotent (upsert per square_order_id /
 * square_refund_id), so overlap with the webhook is harmless. The run summary
 * lands in cron_runs.detail for the Settings → Cron Jobs monitor.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { syncPosTransactionsForRange } from "@/lib/finance/syncPosTransactions";
import { syncRefundsForRange } from "@/lib/finance/syncRefunds";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 3;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("finance-sync", async () => {
    const supabase = createSupabaseAdminClient();
    const now = new Date();
    const endDate = now.toISOString().slice(0, 10);
    const startDate = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

    const orders = await syncPosTransactionsForRange(supabase, startDate, endDate);
    const refunds = await syncRefundsForRange(supabase, startDate, endDate);
    return { windowDays: WINDOW_DAYS, orders, refunds };
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}
