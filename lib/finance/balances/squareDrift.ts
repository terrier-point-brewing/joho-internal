/**
 * Re-anchoring, and the record of what re-anchoring absorbed.
 *
 * When an operator closes a month by entering the real Square balance, that
 * figure replaces the derived one and becomes the next month's starting point.
 * The gap between the two is the drift, and it is the ONLY visibility anyone
 * gets into money that left the Square balance -- sweeps to the bank appear in
 * no feed and in no posting (see providers/squareBalance.ts for the evidence).
 *
 * Recording it turns a silent correction into a number someone can look at,
 * because re-anchoring is by construction self-healing and would otherwise hide
 * its own errors completely.
 *
 * ── What this log can and cannot tell you, today ─────────────────────────────
 * Be honest about the limit. Sweeps from the Square balance to the linked Chase
 * account are real and regular, so the expected drift is LARGE and negative --
 * roughly a month of sweeping -- not a small residual. That means a big
 * negative number here is normal, and this log cannot presently separate "swept
 * to the bank" from "the derivation is wrong".
 *
 * What it CAN do is establish the shape: drift that is positive, or wildly
 * out of step with the month's takings, is not explainable as sweeping and
 * wants investigating. And it preserves the inputs, so once GL 1020's Chase
 * feed exists (Plaid's half, unbuilt) the recorded sweeps can be subtracted
 * from these rows and the residual becomes a true error term.
 *
 * Deliberately not an adjusting journal entry. A correcting posting would have
 * to be coded somewhere, would flow into the P&L if coded wrongly, and would
 * make month two's balance depend on month one's correction being right. Re-
 * anchoring keeps each month's derivation independent; this table keeps the
 * evidence.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sumNetPayoutCents } from "@/lib/square/payouts";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface DriftInputs {
  anchorCents: number;
  payoutsCents: number;
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
  const derivedCents = inputs.anchorCents + inputs.payoutsCents;
  return { derivedCents, driftCents: inputs.actualCents - derivedCents };
}

interface AnchorRow {
  as_of_date: string;
  amount_cents: number;
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
 * the log growing a row per run.
 */
export async function recordSquareDrift(
  supabase: AdminClient,
  coaId: string,
  periodEnd: string,
): Promise<DriftResult | null> {
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
  const result = computeDrift({
    anchorCents: priorRow.amount_cents,
    payoutsCents,
    actualCents: closingRow.amount_cents,
  });

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
      computed_at: new Date().toISOString(),
    },
    { onConflict: "chart_of_accounts_id,period_end" },
  );
  if (writeError) throw new Error(writeError.message);

  return result;
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
