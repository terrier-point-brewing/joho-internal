/**
 * Cash on hand, right now — the sum every runway question starts from.
 *
 * ── Why only the bank-section sources are computed ───────────────────────────
 * `computeLiveBalances` answers this and forty other accounts, and among the
 * forty are retained earnings (a from-inception P&L recompute) and the
 * inventory valuations — seconds of work to answer a question about four cash
 * accounts. This filters the declared sources to bank-section accounts BEFORE
 * expanding them, and then runs the snapshot's own machinery over just those,
 * so the figure is the same one the balance sheet's Bank & Cash section shows
 * for the open month, at a fraction of the cost.
 *
 * ── It agrees with the balance sheet, gaps and all ───────────────────────────
 * An account whose method produced nothing — an unentered till count on GL
 * 1010, a postings account nothing posts to — is absent here exactly as it is
 * absent from the statement's Bank & Cash section. Summing a DIFFERENT set of
 * accounts than the statement would give the app two answers to "how much cash
 * do we have", which is the disagreement this module was extracted to prevent;
 * the month-end close already chases the unentered balances by name. Null is
 * returned only when nothing computed at all (no bank sources, or every one of
 * them failed), which renders as "n/a" rather than as a confident $0.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCoa } from "@/lib/finance/financials/fetchSources";
import { coaSection } from "@/lib/finance/financials/aggregateRows";
import { expandSources, fetchDeclaredSources, resolveSnapshotWrites } from "./snapshot";
import { openPeriodEnd } from "./liveBalances";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function computeCashOnHandCents(
  supabase: AdminClient,
  todayIso: string,
): Promise<number | null> {
  const coa = await fetchCoa(supabase);
  const bankIds = new Set(coa.filter((c) => coaSection(c) === "bank").map((c) => c.id));

  const declared = (await fetchDeclaredSources(supabase)).filter((s) => bankIds.has(s.coaId));
  if (declared.length === 0) return null;

  const { sources, results, failedAccounts } = await expandSources(
    supabase,
    openPeriodEnd(todayIso),
    declared,
  );

  const writes = resolveSnapshotWrites(sources, results, new Map()).filter(
    (w) => !failedAccounts.has(w.coaId),
  );
  if (writes.length === 0) return null;

  return writes.reduce((sum, w) => sum + w.balanceCents, 0);
}

/**
 * Average operating cash of the last `window` ENDED months, signed — negative
 * is a burn. Pure; the route feeds it the cash-flow statement's own
 * `operatingCashCents`, so the burn a runway is quoted against is exactly the
 * figure printed on the statement below it.
 *
 * The OPEN month is excluded: three weeks of August's inflows divided into a
 * month's rent reads as a burn that ends at month end. Months before the
 * business had any activity (all-zero) are excluded too, or a young company's
 * real burn would be averaged toward zero by months it did not exist.
 */
export function burnRateCents(
  operatingCashByMonth: Record<string, number>,
  openMonth: string | null,
  window = 3,
): number | null {
  const active = Object.entries(operatingCashByMonth)
    .filter(([month, cents]) => month !== openMonth && cents !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-window)
    .map(([, cents]) => cents);
  if (active.length === 0) return null;
  return Math.round(active.reduce((a, b) => a + b, 0) / active.length);
}

/** Months of cash left at the given burn. Null when there is no burn to divide by. */
export function runwayMonths(cashOnHand: number | null, burn: number | null): number | null {
  if (cashOnHand === null || burn === null || burn >= 0) return null;
  return Math.round((cashOnHand / -burn) * 10) / 10;
}
