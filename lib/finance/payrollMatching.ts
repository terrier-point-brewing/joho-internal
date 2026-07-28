/**
 * Payroll period matching + proportional GL-split auto-fill.
 *
 * An expense whose counterparty routing is 'payroll_split' (see ./expenses's
 * resolveExpenseMapping payroll_split skip) surfaces here instead of the
 * normal single-account resolution: the user matches it to a pay_periods row
 * (suggestPayPeriod proposes a candidate, never auto-confirms), and once the
 * period has an active Gusto upload (payroll_gl_reports/payroll_gl_report_totals),
 * computeProportionalSplits allocates that upload's per-GL-account totals
 * across all expenses matched to the period, proportional to each expense's
 * own amount -- except for tips (payroll_gl_report_totals.bucket_kind='tips'),
 * which are a balance-sheet pass-through and are carved out at their EXACT
 * reported amount before that proportional fill runs.
 * recomputePeriodExpenseSplits is the single DB-orchestrating
 * entry point that regenerates 'payroll_auto' expense_gl_splits rows for a
 * period — used by the match action and by an on-demand recompute route.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const SUGGESTION_WINDOW_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SuggestPeriodInput {
  expenseDate: string; // "YYYY-MM-DD"
  candidatePeriods: { id: string; endDate: string }[]; // unmatched periods only, pre-filtered by caller
}

/** Nearest candidate by |endDate - expenseDate|, within a 10-day window; null if none qualify. */
export function suggestPayPeriod(input: SuggestPeriodInput): string | null {
  const expenseTime = Date.parse(`${input.expenseDate}T00:00:00Z`);
  let best: { id: string; diffDays: number } | null = null;

  for (const c of input.candidatePeriods) {
    const endTime = Date.parse(`${c.endDate}T00:00:00Z`);
    const diffDays = Math.abs(endTime - expenseTime) / MS_PER_DAY;
    if (diffDays > SUGGESTION_WINDOW_DAYS) continue;
    if (!best || diffDays < best.diffDays) best = { id: c.id, diffDays };
  }

  return best?.id ?? null;
}

export interface UnmatchedPayrollExpense {
  id: string;
  expenseDate: string; // "YYYY-MM-DD"
}

/**
 * Bulk counterpart to suggestPayPeriod: for each unmatched payroll expense,
 * pick its nearest in-window pay period (same 10-day rule) and emit an
 * (expenseId → payPeriodId) match. Expenses with no qualifying period are
 * dropped (never force-matched). Pure — the DB read/write orchestration lives
 * in autoMapPayrollExpenses.
 */
export function planPayrollMatches(
  expenses: UnmatchedPayrollExpense[],
  candidatePeriods: { id: string; endDate: string }[],
): { expenseId: string; payPeriodId: string }[] {
  const plans: { expenseId: string; payPeriodId: string }[] = [];
  for (const e of expenses) {
    const payPeriodId = suggestPayPeriod({ expenseDate: e.expenseDate, candidatePeriods });
    if (payPeriodId) plans.push({ expenseId: e.id, payPeriodId });
  }
  return plans;
}

export interface MatchedExpenseAmount {
  expenseId: string;
  amountCents: number; // absolute value of the expense's signed amount_cents
}

interface ProportionalLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto";
}

export interface PeriodBucket {
  chartOfAccountsId: string;
  /**
   * Precondition: must be >= 0. A negative tips bucket is silently dropped by
   * the `bucketAmount <= 0` guard at the top of the stage-1 carve-out loop
   * below, not rejected -- callers must not pass a negative amount here.
   */
  amountCents: number;
  /**
   * Which side of the payroll journal this bucket is. Absent (pre-backfill
   * rows, and every caller that predates payroll_gl_report_totals.bucket_kind)
   * is deliberately treated as NON-tips, so the code path is provably
   * equivalent to the pre-tips implementation until the backfill lands.
   */
  kind?: "wages" | "employer_tax" | "tips";
}

/**
 * Splits each matchedExpense across periodTotals' buckets in TWO stages.
 *
 * Stage 1 (EXACT -- tips): employee tips are a balance-sheet pass-through, not
 * an expense, so a `kind: "tips"` bucket must reach its liability account at
 * its EXACT reported amount. Each tips bucket is distributed across the matched
 * expenses by each expense's share of the MATCHED total (floor, then leftover
 * cents to the largest remainders first), so the tip lines summed over all of
 * the period's expenses equal that bucket's amount to the cent -- never scaled
 * by the reconciliation variance between matched cash and the period's GL total.
 *
 * Stage 2 (FILL -- wages/tax): whatever is left of each expense after its tip
 * shares are carved out is force-filled across the non-tips buckets using the
 * period's own wage/tax mix, with the same floor + largest-remainder rounding
 * as before. This is the pre-existing behavior and is what absorbs the
 * reconciliation residual (a deliberate product decision: the variance lands on
 * wage/tax accounts rather than being surfaced as its own line).
 *
 * Three invariants hold simultaneously:
 *   1. Each expense's lines sum exactly to its own amountCents.
 *   2. The residual is absorbed by the wage/tax buckets.
 *   3. Tip lines across all of a period's expenses sum exactly to the period's
 *      tip total.
 * Where (1) and (3) cannot both hold -- tipsTotal > matchedTotal, so an
 * expense's tip share would exceed the whole expense -- (1) wins: the share is
 * clamped to the expense's own amount rather than emitting negative wage lines.
 *
 * Works purely in magnitudes; callers re-apply each expense's cash-direction
 * sign (see recomputePeriodExpenseSplits).
 */
export function computeProportionalSplits(
  matchedExpenses: MatchedExpenseAmount[],
  periodTotals: PeriodBucket[],
): Map<string, ProportionalLine[]> {
  const result = new Map<string, ProportionalLine[]>();
  if (matchedExpenses.length === 0) return result;

  const tipIdx = periodTotals.flatMap((b, i) => (b.kind === "tips" ? [i] : []));
  const restIdx = periodTotals.flatMap((b, i) => (b.kind === "tips" ? [] : [i]));
  const matchedTotal = matchedExpenses.reduce((s, e) => s + e.amountCents, 0);

  // Mirrors the old periodTotal > 0 guard: nothing to allocate, no lines.
  if (matchedTotal <= 0) {
    for (const e of matchedExpenses) result.set(e.expenseId, []);
    return result;
  }

  // amounts[expenseIndex][bucketIndex] -- built in periodTotals order so the
  // emitted line order is identical to the pre-change implementation.
  const amounts = matchedExpenses.map(() => periodTotals.map(() => 0));
  // Remaining capacity per expense after its tip carve-outs.
  const remaining = matchedExpenses.map((e) => e.amountCents);

  // ---- Stage 1: exact tip carve-out, one bucket at a time ----
  for (const bi of tipIdx) {
    const bucketAmount = periodTotals[bi].amountCents;
    if (bucketAmount <= 0) continue;

    const remainders = matchedExpenses.map((e, ei) => {
      const raw = (bucketAmount * e.amountCents) / matchedTotal;
      const floored = Math.min(Math.floor(raw), remaining[ei]); // clamp: never exceed the expense itself
      amounts[ei][bi] = floored;
      remaining[ei] -= floored;
      return raw - Math.floor(raw);
    });

    let leftover = bucketAmount - matchedExpenses.reduce((s, _e, ei) => s + amounts[ei][bi], 0);
    // Largest remainder first; ties keep matchedExpenses' original order.
    const order = [...remainders.keys()].sort((a, b) => remainders[b] - remainders[a]);
    // Normally one pass suffices (leftover < expense count); the loop only
    // repeats when clamping pushed cents onto expenses that had no capacity.
    let progressed = true;
    while (leftover > 0 && progressed) {
      progressed = false;
      for (const ei of order) {
        if (leftover <= 0) break;
        if (remaining[ei] <= 0) continue;
        amounts[ei][bi] += 1;
        remaining[ei] -= 1;
        leftover -= 1;
        progressed = true;
      }
    }
  }

  // ---- Stage 2: force-fill the remainder across the wage/tax buckets ----
  const restTotal = restIdx.reduce((s, i) => s + periodTotals[i].amountCents, 0);
  // Fall back to the tips buckets only when there is no wage/tax bucket at all
  // (degenerate: a report with nothing but tips) -- invariant 1 outranks 3.
  const fillIdx = restIdx.length > 0 ? restIdx : tipIdx;
  const fillTotal = restIdx.length > 0 ? restTotal : tipIdx.reduce((s, i) => s + periodTotals[i].amountCents, 0);
  // Weight by each bucket's share; if every fill bucket is zero, weight evenly
  // so the expense still allocates in full rather than dropping cents.
  const weights = fillIdx.map((i) => (fillTotal > 0 ? periodTotals[i].amountCents / fillTotal : 1 / fillIdx.length));

  for (let ei = 0; ei < matchedExpenses.length; ei++) {
    const toFill = remaining[ei];
    if (fillIdx.length > 0 && toFill > 0) {
      let flooredSum = 0;
      const remainders = fillIdx.map((bi, k) => {
        const raw = toFill * weights[k];
        const floored = Math.floor(raw);
        amounts[ei][bi] += floored;
        flooredSum += floored;
        return raw - floored;
      });

      let leftover = toFill - flooredSum;
      // Largest remainder first; ties keep periodTotals' original order.
      const order = [...remainders.keys()].sort((a, b) => remainders[b] - remainders[a]);
      for (const k of order) {
        if (leftover <= 0) break;
        amounts[ei][fillIdx[k]] += 1;
        leftover -= 1;
      }
    }

    result.set(
      matchedExpenses[ei].expenseId,
      periodTotals.map((b, bi) => ({
        chartOfAccountsId: b.chartOfAccountsId,
        amountCents: amounts[ei][bi],
        splitSource: "payroll_auto" as const,
      })),
    );
  }

  return result;
}

/**
 * DB-orchestration wrapper, the single shared entry point for "regenerate
 * payroll_auto splits for every expense matched to this period" — used by
 * the "match" action and by the period-recompute route exposed for the
 * post-upload trigger. Reads payroll_period_expense_matches + expenses.
 * amount_cents for payPeriodId, reads the period's active payroll_gl_reports'
 * payroll_gl_report_totals, calls computeProportionalSplits, then per
 * expense: if it has any existing expense_gl_splits row with
 * split_source='manual', skip it entirely (don't touch its rows); otherwise
 * delete its existing 'payroll_auto' rows and insert the freshly computed
 * ones. No-ops (returns immediately) if the period has no active report yet.
 */
export async function recomputePeriodExpenseSplits(sb: SupabaseClient, payPeriodId: string): Promise<void> {
  const { data: reportRows, error: reportErr } = await sb
    .from("payroll_gl_reports")
    .select("id")
    .eq("pay_period_id", payPeriodId)
    .is("superseded_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (reportErr) throw new Error(`Load payroll GL report failed: ${reportErr.message}`);
  const report = (reportRows as { id: string }[] | null)?.[0];
  if (!report) return; // no active report -- no-op

  const { data: totalRows, error: totalsErr } = await sb
    .from("payroll_gl_report_totals")
    .select("chart_of_accounts_id, amount_cents, bucket_kind")
    .eq("report_id", report.id);
  if (totalsErr) throw new Error(`Load payroll GL report totals failed: ${totalsErr.message}`);
  // bucket_kind drives the exact tips carve-out in computeProportionalSplits;
  // anything unrecognised (or null, pre-backfill) is left undefined and is
  // therefore treated as non-tips, i.e. the pre-change force-fill behavior.
  const BUCKET_KINDS = ["wages", "employer_tax", "tips"] as const;
  const periodTotals: PeriodBucket[] = (
    (totalRows ?? []) as { chart_of_accounts_id: string; amount_cents: number; bucket_kind: string | null }[]
  ).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents,
    kind: (BUCKET_KINDS as readonly string[]).includes(r.bucket_kind ?? "")
      ? (r.bucket_kind as PeriodBucket["kind"])
      : undefined,
  }));

  const { data: matchRows, error: matchErr } = await sb
    .from("payroll_period_expense_matches")
    .select("expense_id")
    .eq("pay_period_id", payPeriodId);
  if (matchErr) throw new Error(`Load payroll period expense matches failed: ${matchErr.message}`);
  const expenseIds = ((matchRows ?? []) as { expense_id: string }[]).map((r) => r.expense_id);
  if (expenseIds.length === 0) return;

  const { data: expenseRows, error: expErr } = await sb
    .from("expenses")
    .select("id, amount_cents")
    .in("id", expenseIds);
  if (expErr) throw new Error(`Load matched expenses failed: ${expErr.message}`);
  const amountByExpenseId = new Map(
    ((expenseRows ?? []) as { id: string; amount_cents: number | null }[]).map((r) => [r.id, Math.abs(r.amount_cents ?? 0)]),
  );
  // Raw (signed) amount_cents per expense, used to re-apply each expense's
  // own cash-direction sign to its computed split lines below -- expenses is
  // stored negative for outflows (see rampExpenses.ts), and
  // computeProportionalSplits works purely in magnitudes, so its output must
  // be re-signed before it's written to expense_gl_splits or Financials'
  // pass-through sign handling (normalizeSign.ts's "C1 fix") will read every
  // payroll split as a positive credit instead of a cost.
  const signByExpenseId = new Map(
    ((expenseRows ?? []) as { id: string; amount_cents: number | null }[]).map((r) => [r.id, r.amount_cents ?? 0]),
  );

  const { data: splitRows, error: splitErr } = await sb
    .from("expense_gl_splits")
    .select("expense_id, split_source, chart_of_accounts_id, amount_cents")
    .in("expense_id", expenseIds);
  if (splitErr) throw new Error(`Load existing expense GL splits failed: ${splitErr.message}`);
  const typedSplitRows = (splitRows ?? []) as {
    expense_id: string;
    split_source: string;
    chart_of_accounts_id: string;
    amount_cents: number;
  }[];
  const manualExpenseIds = new Set(typedSplitRows.filter((r) => r.split_source === "manual").map((r) => r.expense_id));

  // Tips are a balance-sheet pass-through: a manual override that already
  // posts (some or all of) the period's tips to the tips liability account
  // must be netted out of the auto side's target before the exact carve-out
  // runs below, or the auto allocation would either double-post on top of the
  // override or (pre-fix) drop the override's share entirely. Self-correcting
  // and clamped at zero: hand-post more on the override and the auto side
  // allocates less, never negative -- see PR review finding #1.
  const tipAccountIds = new Set(periodTotals.filter((b) => b.kind === "tips").map((b) => b.chartOfAccountsId));
  const alreadyPostedByTipAccount = new Map<string, number>();
  for (const r of typedSplitRows) {
    if (r.split_source !== "manual" || !tipAccountIds.has(r.chart_of_accounts_id)) continue;
    alreadyPostedByTipAccount.set(
      r.chart_of_accounts_id,
      (alreadyPostedByTipAccount.get(r.chart_of_accounts_id) ?? 0) + Math.abs(r.amount_cents),
    );
  }
  const nettedPeriodTotals: PeriodBucket[] = periodTotals.map((b) =>
    b.kind !== "tips"
      ? b
      : { ...b, amountCents: Math.max(0, b.amountCents - (alreadyPostedByTipAccount.get(b.chartOfAccountsId) ?? 0)) },
  );

  // Only the WRITABLE (non-manual) expenses are allocated a share -- a manual
  // override's own rows are left exactly as the user set them (see the write
  // loop below), and its already-posted tips are netted into
  // nettedPeriodTotals above instead of diluting the writable expenses' ratio
  // (and instead of being silently discarded, the pre-fix bug).
  const matchedExpenses: MatchedExpenseAmount[] = expenseIds
    .filter((id) => !manualExpenseIds.has(id))
    .map((id) => ({
      expenseId: id,
      amountCents: amountByExpenseId.get(id) ?? 0,
    }));

  const splitsByExpense = computeProportionalSplits(matchedExpenses, nettedPeriodTotals);

  for (const [expenseId, lines] of splitsByExpense) {
    if (manualExpenseIds.has(expenseId)) continue; // full skip -- don't touch this expense's rows

    const { error: delErr } = await sb
      .from("expense_gl_splits")
      .delete()
      .eq("expense_id", expenseId)
      .eq("split_source", "payroll_auto");
    if (delErr) throw new Error(`Delete existing payroll_auto splits failed: ${delErr.message}`);

    if (lines.length === 0) continue;

    // Re-apply the parent expense's cash-direction sign: computeProportionalSplits
    // only ever produces magnitudes derived from matchedExpenses' abs'd
    // amountCents, so a negative (outflow) expense's split lines must be
    // negated before insert. amount_cents === 0 has no direction to preserve
    // -- treat it as a no-op sign (Math.sign(0) === 0 would zero every line).
    const rawAmount = signByExpenseId.get(expenseId) ?? 0;
    const sign = rawAmount < 0 ? -1 : 1;

    const { error: insErr } = await sb.from("expense_gl_splits").insert(
      lines.map((l) => ({
        expense_id: expenseId,
        chart_of_accounts_id: l.chartOfAccountsId,
        amount_cents: l.amountCents * sign,
        split_source: l.splitSource,
      })),
    );
    if (insErr) throw new Error(`Insert payroll_auto splits failed: ${insErr.message}`);
  }
}

/**
 * Bulk "auto-map payroll split" for a date range: matches every unmatched
 * payroll_split-routed bank expense in [from, to] to its nearest pay period
 * (planPayrollMatches), inserts the matches, then recomputes every touched
 * period so its proportional GL splits regenerate (recomputePeriodExpenseSplits
 * no-ops on periods without an active Gusto report). Only ever ADDS matches for
 * currently-unmatched expenses, so it's safe to re-run. Mirrors the per-row
 * "Match payroll period" action in app/api/finance/expenses/[id]/payroll-match.
 */
export async function autoMapPayrollExpenses(
  sb: SupabaseClient,
  opts: { from: string; to: string; matchedBy: string },
): Promise<{ matched: number; periodsRecomputed: number }> {
  // Counterparties routed to payroll splitting (e.g. Gusto).
  const { data: cpRows, error: cpErr } = await sb
    .from("expense_counterparty_mappings")
    .select("counterparty_key")
    .eq("routing", "payroll_split");
  if (cpErr) throw new Error(`Load payroll_split counterparties failed: ${cpErr.message}`);
  const keys = ((cpRows ?? []) as { counterparty_key: string }[]).map((r) => r.counterparty_key);
  if (keys.length === 0) return { matched: 0, periodsRecomputed: 0 };

  // Bank expenses in range for those counterparties.
  const { data: expRows, error: expErr } = await sb
    .from("expenses")
    .select("id, accounting_date, transaction_time")
    .eq("ramp_object", "bank")
    .in("counterparty_key", keys)
    .gte("accounting_date", opts.from)
    .lte("accounting_date", opts.to);
  if (expErr) throw new Error(`Load payroll expenses failed: ${expErr.message}`);
  const candidates = ((expRows ?? []) as { id: string; accounting_date: string | null; transaction_time: string | null }[])
    .map((r) => ({ id: r.id, expenseDate: r.accounting_date ?? r.transaction_time?.slice(0, 10) ?? null }))
    .filter((r): r is UnmatchedPayrollExpense => r.expenseDate != null);
  if (candidates.length === 0) return { matched: 0, periodsRecomputed: 0 };

  // Drop the ones already matched to any period.
  const { data: matchRows, error: matchErr } = await sb
    .from("payroll_period_expense_matches")
    .select("expense_id")
    .in("expense_id", candidates.map((c) => c.id));
  if (matchErr) throw new Error(`Load existing payroll matches failed: ${matchErr.message}`);
  const alreadyMatched = new Set(((matchRows ?? []) as { expense_id: string }[]).map((r) => r.expense_id));
  const unmatched = candidates.filter((c) => !alreadyMatched.has(c.id));
  if (unmatched.length === 0) return { matched: 0, periodsRecomputed: 0 };

  const { data: periodRows, error: periodErr } = await sb.from("pay_periods").select("id, end_date");
  if (periodErr) throw new Error(`Load pay periods failed: ${periodErr.message}`);
  const periods = ((periodRows ?? []) as { id: string; end_date: string }[]).map((p) => ({ id: p.id, endDate: p.end_date }));

  const plans = planPayrollMatches(unmatched, periods);
  if (plans.length === 0) return { matched: 0, periodsRecomputed: 0 };

  const { error: insErr } = await sb.from("payroll_period_expense_matches").insert(
    plans.map((p) => ({ pay_period_id: p.payPeriodId, expense_id: p.expenseId, matched_by: opts.matchedBy })),
  );
  if (insErr) throw new Error(`Insert payroll matches failed: ${insErr.message}`);

  // Recompute each touched period once (a period matching a new expense
  // reweights every already-matched expense in it).
  const touchedPeriods = Array.from(new Set(plans.map((p) => p.payPeriodId)));
  for (const periodId of touchedPeriods) {
    await recomputePeriodExpenseSplits(sb, periodId);
  }

  return { matched: plans.length, periodsRecomputed: touchedPeriods.length };
}
