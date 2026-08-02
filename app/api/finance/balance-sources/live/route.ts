/**
 * GET /api/finance/balance-sources/live
 *   Every balance-sheet account's balance right now, for the month still in
 *   progress.
 *
 * ── Why this is its own route ────────────────────────────────────────────────
 * This is the expensive half of what the Settings screen shows: it runs every
 * active source, which for integration methods means calling Ramp and Square,
 * one account at a time (see expandSources). It used to run inline inside GET
 * /api/finance/balance-sources, which meant every save on that screen --
 * flipping a source on, finishing a setup field, excluding an account --
 * re-triggered this same multi-second compute for every OTHER account too,
 * because the save handler invalidated the one query that carried both. A save
 * only ever changes what GET /api/finance/balance-sources itself returns; it
 * never needs this to be recomputed to prove the save landed. Splitting the
 * two lets the settings query stay a fast, DB-only round trip, and lets this
 * one refresh in the background instead of blocking the "saving…" state.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
// Side-effect import: registers every provider and method so the compute has
// something to resolve against, same as the settings route.
import "@/lib/finance/balances/methods";
import { computeOpenMonthBalances } from "@/lib/finance/balances/liveBalances";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";
/** Runs every active source, including live reads against Ramp and Square. */
export const maxDuration = 60;

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();
    const live = await computeOpenMonthBalances(supabase, todayLocalDate());

    const balances: Record<string, { cents: number; contributions: Record<string, number> }> = {};
    for (const [coaId, b] of live.balances) balances[coaId] = { cents: b.balanceCents, contributions: b.contributions };

    return NextResponse.json({
      balances,
      errors: live.errors,
      failedAccounts: Array.from(live.failedAccounts),
    });
  } catch (err) {
    return apiError(err);
  }
}
