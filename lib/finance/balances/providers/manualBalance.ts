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

import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

export const manualBalance: BalanceProvider = {
  key: "manualBalance",
  label: "Manual entry",
  kind: "manual",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const { data, error } = await ctx.supabase
      .from("manual_entries")
      .select("amount_cents")
      .eq("entry_kind", "balance")
      .eq("chart_of_accounts_id", ctx.coaId)
      .eq("as_of_date", ctx.periodEnd)
      .maybeSingle();

    if (error || !data) return null;
    return (data as { amount_cents: number | null }).amount_cents ?? null;
  },
};

registerProvider(manualBalance);
