/**
 * GL 1590 (and any future contra-asset account) — accumulated depreciation,
 * computed from the depreciation schedules rather than stated by hand.
 *
 * ── Derived, never posted ────────────────────────────────────────────────────
 * Nothing writes monthly depreciation rows anywhere. This provider feeds the
 * schedules and the scheduled accounts' own dated additions through ONE engine
 * (lib/finance/depreciation/engine.ts) — the same engine the P&L's injected
 * depreciation rows and retained earnings use — so the three statements cannot
 * disagree about what a month's depreciation was. The figure is deterministic
 * from recorded history, so it is safe to snapshot for any month
 * (no dependsOnCurrentState): asking about March recomputes March, not today.
 *
 * ── Why it filters by contra account ─────────────────────────────────────────
 * A schedule names where its charge accumulates. Today every schedule points at
 * 1590; the filter is what makes a second accumulated-depreciation account (by
 * asset class, someday) a Settings action instead of a code change.
 *
 * ── Null vs zero ─────────────────────────────────────────────────────────────
 * No schedules pointing here → null, the "not set up" answer, same as every
 * derived provider. Schedules with nothing yet coded to their asset accounts →
 * 0, which is true: configured, and nothing has depreciated.
 */
import { fetchCoa } from "@/lib/finance/financials/fetchSources";
import { fetchDepreciationState, seriesFor } from "@/lib/finance/depreciation/state";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

export const accumulatedDepreciation: BalanceProvider = {
  key: "accumulatedDepreciation",
  label: "Accumulated depreciation",
  kind: "derived",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const coa = await fetchCoa(ctx.supabase);
    const states = await fetchDepreciationState(ctx.supabase, coa);
    const mine = states.filter((s) => s.contraChartOfAccountsId === ctx.coaId);
    if (mine.length === 0) return null;

    const throughMonth = ctx.periodEnd.slice(0, 7);
    let sum = 0;
    for (const s of mine) sum += seriesFor(s, throughMonth).accumulatedCents;
    return sum; // internal convention: a contra-asset accumulates negative
  },
};

registerProvider(accumulatedDepreciation);
