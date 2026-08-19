/**
 * Re-anchoring, and the record of what re-anchoring absorbed.
 *
 * When an operator closes a month by entering the real Square balance, that
 * figure replaces the derived one and becomes the next month's starting point.
 * The gap between the two is the drift. It used to be the ONLY visibility
 * anyone had into money leaving the Square balance; now that the derivation
 * deducts the sweeps its own declared bank account can see, the drift is what
 * is left AFTER that -- see providers/squareBalance.ts.
 *
 * Recording it turns a silent correction into a number someone can look at,
 * because re-anchoring is by construction self-healing and would otherwise hide
 * its own errors completely.
 *
 * ── What this log can and cannot tell you ────────────────────────────────────
 * Sweeps from the Square balance to the linked Chase account are real and
 * regular, and Square reports none of them. Where the method names a
 * `sweepDestinationCoaId` with an imported feed, the derivation now DEDUCTS
 * those sweeps as they post (providers/squareBalance.ts), so the expected drift
 * is a small residual and a large one is a signal rather than the norm.
 *
 * Where there is no such feed, nothing is deducted and the old shape holds: the
 * drift is roughly a month of sweeping, undifferentiated, with the split
 * columns left NULL. A missing feed must never produce a confident-looking zero
 * swept.
 *
 * What the residual means, once sweeps are being deducted: money that left the
 * Square balance by a route the declared bank account never saw. Positive drift
 * -- money arriving that the payouts feed did not account for -- is not
 * explainable by sweeping in either direction and always wants investigating.
 *
 * The inputs are preserved on every row, so a month recorded under either
 * arrangement can be recomputed and compared.
 *
 * Deliberately not an adjusting journal entry. A correcting posting would have
 * to be coded somewhere, would flow into the P&L if coded wrongly, and would
 * make month two's balance depend on month one's correction being right. Re-
 * anchoring keeps each month's derivation independent; this table keeps the
 * evidence.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sumNetPayoutCents } from "@/lib/square/payouts";
import { readBankLines } from "./bankTransactions";
import { totalSquareSweeps, type SweepTotals } from "./squareSweeps";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface DriftInputs {
  anchorCents: number;
  payoutsCents: number;
  /**
   * Transfers to the bank the derivation already deducted, as a positive
   * figure. Zero is the right default and is NOT the same claim as "nothing was
   * swept" -- it means the derivation deducted nothing, which is exactly the
   * case for an account with no declared destination or no imported feed.
   */
  sweptCents?: number;
  actualCents: number;
}

export interface DriftResult {
  derivedCents: number;
  driftCents: number;
}

/**
 * Pure. What the derivation said, and how far off it was.
 *
 * Sign: NEGATIVE drift means the real balance came in below the derived one,
 * which is what an unrecorded withdrawal looks like and is the expected
 * direction. Positive drift means money arrived that the payouts feed did not
 * account for, which is not expected and is worth a look.
 */
export function computeDrift(inputs: DriftInputs): DriftResult {
  // Mirrors providers/squareBalance.ts step for step, and must keep doing so.
  // `derived_cents` is what the balance sheet SHOWED for this month; a
  // reconciliation whose starting figure is not the published one explains a
  // number nobody saw.
  const derivedCents = inputs.anchorCents + inputs.payoutsCents - (inputs.sweptCents ?? 0);
  return { derivedCents, driftCents: inputs.actualCents - derivedCents };
}

/** The drift, less whatever the bank can account for. */
export interface DriftSplit extends SweepTotals {
  /** Drift that the bank's own record does NOT explain. Zero means it reconciles. */
  unexplainedCents: number;
}

/**
 * Pure. The sweep totals behind a month's derivation, and what it still cannot
 * explain.
 *
 * `unexplainedCents` is simply the drift, and that is the point of the change
 * that made it so. The sweeps are no longer subtracted here after the fact --
 * providers/squareBalance.ts deducted them from the balance as they posted, so
 * they are already inside `derivedCents` and adding them again would explain
 * the same dollars twice. What is left over is the genuine error term: money
 * that left Square by a route the declared bank account never saw.
 *
 * The totals are still carried and still split exact from name-only. They are
 * no longer the explanation -- they are the evidence for the deduction the
 * derivation already made, and a reader checking a month needs to see how much
 * of it rested on prose rather than on Square's ACH originator id.
 */
export function splitDrift(driftCents: number, lines: Parameters<typeof totalSquareSweeps>[0]): DriftSplit {
  const totals = totalSquareSweeps(lines);
  return { ...totals, unexplainedCents: driftCents };
}

interface AnchorRow {
  as_of_date: string;
  amount_cents: number;
}

/**
 * The bank account the operator declared Square pays out to, or null.
 *
 * Optional on the method's setup and therefore optional here. An account with
 * nothing declared reconciles exactly as it did before the Chase feed existed --
 * which is the correct outcome, not a degraded one, because nothing else in the
 * system knows where the money went either.
 */
async function sweepDestinationOf(supabase: AdminClient, coaId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("config")
    .eq("chart_of_accounts_id", coaId)
    .eq("provider_key", "squareStoredBalance")
    .maybeSingle();
  if (error || !data) return null;

  const value = ((data as { config: Record<string, unknown> | null }).config ?? {}).sweepDestinationCoaId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Records the drift for `periodEnd`, if this period was actually re-anchored.
 *
 * Does nothing and returns null when there is no closing figure for the period
 * (nothing to compare against) or no earlier anchor (the first anchor is a
 * starting point, not a correction -- there is no prior derivation it could
 * disagree with).
 *
 * Idempotent: re-running a month overwrites its row rather than accumulating
 * duplicates, so the daily cron can call this every day of the month without
 * the log growing a row per run. That idempotency is also what lets a month
 * recorded before the Chase feed existed pick up its split on a later run.
 */
export async function recordSquareDrift(
  supabase: AdminClient,
  coaId: string,
  periodEnd: string,
): Promise<(DriftResult & { split: DriftSplit | null }) | null> {
  const { data: closing, error: closingError } = await supabase
    .from("manual_entries")
    .select("as_of_date, amount_cents")
    .eq("entry_kind", "balance")
    .eq("chart_of_accounts_id", coaId)
    .eq("as_of_date", periodEnd)
    .maybeSingle();
  if (closingError || !closing) return null;

  const { data: prior, error: priorError } = await supabase
    .from("manual_entries")
    .select("as_of_date, amount_cents")
    .eq("entry_kind", "balance")
    .eq("chart_of_accounts_id", coaId)
    .lt("as_of_date", periodEnd)
    .order("as_of_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorError || !prior) return null;

  const closingRow = closing as AnchorRow;
  const priorRow = prior as AnchorRow;

  const payoutsCents = await sumNetPayoutCents(priorRow.as_of_date, periodEnd);

  // The same window the payouts term covers: the prior anchor date is already
  // reflected in the anchor figure, so a sweep dated that day belongs to the
  // period before this one.
  //
  // Read BEFORE the drift is computed, not after, because the derivation now
  // subtracts these -- they are an input to the figure rather than a
  // commentary on it.
  const destinationCoaId = await sweepDestinationOf(supabase, coaId);
  const lines = destinationCoaId
    ? await readBankLines(supabase, destinationCoaId, priorRow.as_of_date, periodEnd)
    : null;

  // Null all the way down when there is nothing to check against, and zero
  // deducted in that case -- which is what the provider did too, so the two
  // still agree. Writing zeroes into the swept columns would instead say "we
  // looked and found no sweeps", a different and much stronger claim than
  // "there was nothing to look at".
  const result = computeDrift({
    anchorCents: priorRow.amount_cents,
    payoutsCents,
    sweptCents: lines ? totalSquareSweeps(lines).totalCents : 0,
    actualCents: closingRow.amount_cents,
  });
  const split = lines ? splitDrift(result.driftCents, lines) : null;

  const { error: writeError } = await supabase.from("square_balance_reconciliations").upsert(
    {
      chart_of_accounts_id: coaId,
      period_end: periodEnd,
      anchor_date: priorRow.as_of_date,
      anchor_cents: priorRow.amount_cents,
      payouts_cents: payoutsCents,
      derived_cents: result.derivedCents,
      actual_cents: closingRow.amount_cents,
      drift_cents: result.driftCents,
      swept_exact_cents: split ? split.exactCents : null,
      swept_name_only_cents: split ? split.nameOnlyCents : null,
      swept_match_count: split ? split.matchedCount : null,
      unexplained_cents: split ? split.unexplainedCents : null,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "chart_of_accounts_id,period_end" },
  );
  if (writeError) throw new Error(writeError.message);

  return { ...result, split };
}

/** One month's reconciliation, as the Settings explainer shows it. */
export interface ReconciliationSummary {
  coaId: string;
  periodEnd: string;
  driftCents: number;
  /** Null when the destination bank account had nothing to check against. */
  sweptExactCents: number | null;
  sweptNameOnlyCents: number | null;
  sweptMatchCount: number | null;
  unexplainedCents: number | null;
}

interface ReconciliationRow {
  chart_of_accounts_id: string;
  period_end: string;
  drift_cents: number;
  swept_exact_cents: number | null;
  swept_name_only_cents: number | null;
  swept_match_count: number | null;
  unexplained_cents: number | null;
}

/**
 * The recent reconciliation history for a set of accounts, newest first.
 *
 * Returns an empty list rather than throwing when the table cannot be read, so
 * a screen that shows this alongside a dozen other things is never blanked by
 * an unavailable audit log.
 */
export async function listReconciliations(
  supabase: AdminClient,
  coaIds: string[],
  limit = 12,
): Promise<ReconciliationSummary[]> {
  if (coaIds.length === 0) return [];

  const { data, error } = await supabase
    .from("square_balance_reconciliations")
    .select(
      "chart_of_accounts_id, period_end, drift_cents, swept_exact_cents, swept_name_only_cents, swept_match_count, unexplained_cents",
    )
    .in("chart_of_accounts_id", coaIds)
    .order("period_end", { ascending: false })
    .limit(limit);
  if (error || !data) return [];

  return (data as ReconciliationRow[]).map((r) => ({
    coaId: r.chart_of_accounts_id,
    periodEnd: r.period_end,
    driftCents: r.drift_cents,
    sweptExactCents: r.swept_exact_cents,
    sweptNameOnlyCents: r.swept_name_only_cents,
    sweptMatchCount: r.swept_match_count,
    unexplainedCents: r.unexplained_cents,
  }));
}

/**
 * Every account whose selected method is the Square balance method. Used by the
 * close cron, which has no other way to know which accounts to reconcile.
 */
export async function squareBalanceAccountIds(supabase: AdminClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id")
    .eq("provider_key", "squareStoredBalance")
    .eq("active", true);
  if (error) throw new Error(error.message);
  return Array.from(new Set(((data ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id)));
}
