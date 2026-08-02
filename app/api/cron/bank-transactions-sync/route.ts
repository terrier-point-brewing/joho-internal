/**
 * Daily import of bank transactions from Plaid.
 *
 * Exists for one reason: Square publishes nothing about money leaving its
 * stored balance, so the only place a sweep is visible is the bank account it
 * arrives in. This job fetches those bank lines; balance-close then matches them
 * against Square's ACH originator id and splits GL 1040's month-end drift into
 * "swept to the bank" and "genuinely unexplained".
 *
 * The rows land in the shared bank ledger but are imported EXCLUDED from the
 * general ledger, so the profit and loss, the cash-flow statement, the balance
 * sheet and the transactions grid are unchanged by this job running. Opting a
 * source in is a deliberate act with its own switch. See
 * lib/finance/balances/plaidTransactionSync.ts for the three properties that
 * enforce it.
 *
 * ── Why 03:00 UTC ────────────────────────────────────────────────────────────
 * Two constraints, and one slot satisfies both.
 *
 * It has to be well before balance-close at 09:00 UTC, which is what reads these
 * transactions to explain the drift — a sync running after it would leave every
 * month end explained by yesterday's data.
 *
 * And it has to be clear of balance-capture at 02:00 UTC. That job calls the
 * bank synchronously and is allowed five minutes; overlapping two jobs on the
 * same Plaid item invites a mid-pagination mutation on this one for no benefit.
 * An hour of headroom costs nothing, because unlike the balance capture this
 * feed has no deadline: /transactions/sync replays everything since its cursor,
 * so a missed run is picked up in full by the next one. A missed BALANCE capture
 * is a month end that can never be recovered; a missed transaction sync is a day
 * of latency.
 *
 * ── The first run is not like the others ─────────────────────────────────────
 * The link token asks for 730 days of history, so the first sync after a bank is
 * connected walks up to two years — many pages, where every subsequent run is
 * one page of nothing. The cursor is persisted per page, so a first run that
 * does not finish inside the function's time limit simply continues tomorrow
 * rather than starting over. `incomplete` in the response says that happened.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { syncPlaidTransactions } from "@/lib/finance/balances/plaidTransactionSync";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";
/** A long first sync pages against the bank; give it the same headroom as the balance capture. */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("bank-transactions-sync", async () => {
    const supabase = createSupabaseAdminClient();
    // Reported rather than thrown, matching balance-capture: one bank failing is
    // a fact for the Settings status line, not a reason to mark the whole run
    // failed and discard what the others imported.
    return await syncPlaidTransactions(supabase);
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}
