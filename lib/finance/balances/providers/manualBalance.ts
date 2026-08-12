// Reads an operator-supplied balance from manual_entries (entry_kind =
// 'balance'), keyed to (chart_of_accounts_id, as_of_date = periodEnd) --
// enforced unique by manual_entries_one_balance_per_period
// (20260904120000_manual_entries.sql). amount_cents is already stored in the
// internal sign convention (manual_entries has no positivity constraint --
// see that migration's header comment), so it's returned as-is, no
// normalization.
//
// Returns null when absent -- NOT 0. A later task turns that null into an
// open balance_close_tasks row (the month-end close workflow); returning 0
// here would silently mark an unfilled account as "closed at zero".

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/**
 * The balance somebody stated for this account at EXACTLY this month end, or
 * null if nobody has.
 *
 * Exported because two callers need the same question answered the same way:
 * this provider, for an account whose whole answer is the stated figure, and
 * runMethod's stated-balance override, for an account where the figure
 * restates what a feed reported. A second copy of this query is a second set
 * of date semantics -- and "exactly this month end" versus "the most recent one
 * up to here" is precisely the distinction squareBalance.ts had to write a
 * paragraph about.
 */
export async function readStatedBalanceCents(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  coaId: string,
  periodEnd: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("manual_entries")
    .select("amount_cents")
    .eq("entry_kind", "balance")
    .eq("chart_of_accounts_id", coaId)
    .eq("as_of_date", periodEnd)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { amount_cents: number | null }).amount_cents ?? null;
}

export const manualBalance: BalanceProvider = {
  key: "manualBalance",
  label: "Manual entry",
  kind: "manual",
  async compute(ctx: BalanceContext): Promise<number | null> {
    return readStatedBalanceCents(ctx.supabase, ctx.coaId, ctx.periodEnd);
  },
};

registerProvider(manualBalance);
