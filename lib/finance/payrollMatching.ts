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
 * own amount. recomputePeriodExpenseSplits is the single DB-orchestrating
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

export interface MatchedExpenseAmount {
  expenseId: string;
  amountCents: number; // absolute value of the expense's signed amount_cents
}

interface ProportionalLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto";
}

/**
 * Splits each matchedExpense across periodTotals' buckets using the period's
 * own wage/tax mix (each bucket's share of sum(periodTotals)), scaled to that
 * expense's own amountCents -- independent of every other matched expense and
 * independent of how sum(matchedExpenses) relates to sum(periodTotals). Rounds
 * down per line, then distributes leftover cents (from rounding) one at a
 * time to the largest remainders first, so every expense's lines sum exactly
 * to that expense's own amountCents by construction, for ANY reconciliation
 * variance between the matched total and the period total.
 */
export function computeProportionalSplits(
  matchedExpenses: MatchedExpenseAmount[],
  periodTotals: { chartOfAccountsId: string; amountCents: number }[],
): Map<string, ProportionalLine[]> {
  const periodTotal = periodTotals.reduce((s, b) => s + b.amountCents, 0);
  const ratios = periodTotals.map((b) => (periodTotal > 0 ? b.amountCents / periodTotal : 0));
  const result = new Map<string, ProportionalLine[]>();

  for (const e of matchedExpenses) {
    const lines = periodTotals.map((b, i) => {
      const raw = e.amountCents * ratios[i];
      const floored = Math.floor(raw);
      return { chartOfAccountsId: b.chartOfAccountsId, amountCents: floored, remainder: raw - floored };
    });

    const flooredSum = lines.reduce((s, l) => s + l.amountCents, 0);
    let toDistribute = e.amountCents - flooredSum;

    // Largest remainder first; ties keep periodTotals' original order (stable sort).
    const order = [...lines.keys()].sort((a, b) => lines[b].remainder - lines[a].remainder);
    for (const idx of order) {
      if (toDistribute <= 0) break;
      lines[idx].amountCents += 1;
      toDistribute -= 1;
    }

    result.set(
      e.expenseId,
      lines.map((l) => ({ chartOfAccountsId: l.chartOfAccountsId, amountCents: l.amountCents, splitSource: "payroll_auto" as const })),
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
    .select("chart_of_accounts_id, amount_cents")
    .eq("report_id", report.id);
  if (totalsErr) throw new Error(`Load payroll GL report totals failed: ${totalsErr.message}`);
  const periodTotals = ((totalRows ?? []) as { chart_of_accounts_id: string; amount_cents: number }[]).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents,
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
    .select("expense_id, split_source")
    .in("expense_id", expenseIds);
  if (splitErr) throw new Error(`Load existing expense GL splits failed: ${splitErr.message}`);
  const manualExpenseIds = new Set(
    ((splitRows ?? []) as { expense_id: string; split_source: string }[])
      .filter((r) => r.split_source === "manual")
      .map((r) => r.expense_id),
  );

  // Weight is computed across every expense matched to the period (including
  // any with a manual override) so the period's totals are allocated by each
  // expense's true relative share; only the WRITE is skipped for manual
  // expenses below -- their rows are left exactly as the user set them.
  const matchedExpenses: MatchedExpenseAmount[] = expenseIds.map((id) => ({
    expenseId: id,
    amountCents: amountByExpenseId.get(id) ?? 0,
  }));

  const splitsByExpense = computeProportionalSplits(matchedExpenses, periodTotals);

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
