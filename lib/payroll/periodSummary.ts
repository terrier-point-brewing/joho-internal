/**
 * Per-period rollups for the Finance → Payroll periods table.
 *
 * Everything here is derived from data already in Postgres — NO Square calls.
 * The app-side payroll "basis" is only available for LOCKED periods, because
 * the lock route (app/api/payroll/periods/[id]/lock/route.ts) is what snapshots
 * the Square-derived effective hours/tips/bonus into payroll_entries. Open
 * periods carry only adjustment overrides, so their basis is null ("pending
 * lock") rather than a live recompute.
 *
 * Pure computation (computePeriodBasis / pickBaseRate / withinTolerance /
 * deriveSplitStatus) is separated from the DB-orchestrating getPeriodSummaries
 * so the money math is unit-testable without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PayPeriod, PayPeriodSummary } from "./types";

/** Default drift/reconciliation tolerance: $1. Gusto debit timing and per-entry
 *  cent rounding make sub-dollar variance meaningless. */
export const VARIANCE_TOLERANCE_CENTS = 100;

/** Snapshot fields the basis needs — the effective (post-adjustment) values the
 *  lock route persists. */
export interface BasisEntry {
  hours_worked: number | null;
  paycheck_tips_cents: number | null;
  cash_tips_cents: number | null;
  bonus_cents: number | null;
}

/**
 * App-side payroll basis from a period's snapshot entries.
 * - wages     = Σ round(hours × baseRate) + paycheck tips + bonus   (what Gusto disburses)
 * - totalComp = wages + cash tips                                    (cash tips aren't disbursed by Gusto)
 * Returns null when the period has no snapshot rows (i.e. not locked yet).
 * Base pay is rounded per-entry to mirror the lock-time per-employee snapshot.
 */
export function computePeriodBasis(
  entries: BasisEntry[],
  baseRateCents: number,
): { totalCompCents: number; wagesCents: number } | null {
  if (entries.length === 0) return null;
  let basePay = 0;
  let paycheckTips = 0;
  let cashTips = 0;
  let bonus = 0;
  for (const e of entries) {
    basePay += Math.round((e.hours_worked ?? 0) * baseRateCents);
    paycheckTips += e.paycheck_tips_cents ?? 0;
    cashTips += e.cash_tips_cents ?? 0;
    bonus += e.bonus_cents ?? 0;
  }
  const wagesCents = basePay + paycheckTips + bonus;
  return { wagesCents, totalCompCents: wagesCents + cashTips };
}

/** base_rate from the payroll_config effective at startDate (latest effective_from ≤ startDate);
 *  falls back to the earliest config, then 0. */
export function pickBaseRate(
  configs: { effective_from: string; base_rate_cents: number }[],
  startDate: string,
): number {
  if (configs.length === 0) return 0;
  const sorted = [...configs].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let chosen = sorted[0];
  for (const c of sorted) {
    if (c.effective_from <= startDate) chosen = c;
    else break;
  }
  return chosen.base_rate_cents;
}

/** |diff| within tolerance — used to tone the Drift / Reconciliation badges green vs. red. */
export function withinTolerance(diffCents: number, tolCents: number = VARIANCE_TOLERANCE_CENTS): boolean {
  return Math.abs(diffCents) <= tolCents;
}

export type SplitStatus = "split" | "awaiting" | "none";

/** Split status for a period given its matched expense ids and which expense ids carry split rows. */
export function deriveSplitStatus(matchedExpenseIds: string[], expenseIdsWithSplits: Set<string>): SplitStatus {
  if (matchedExpenseIds.length === 0) return "none";
  return matchedExpenseIds.some((id) => expenseIdsWithSplits.has(id)) ? "split" : "awaiting";
}

/**
 * Batch-fetches every per-period rollup in a handful of queries (no Square, no
 * N+1) and composes PayPeriodSummary[] ordered newest-period-first.
 */
export async function getPeriodSummaries(sb: SupabaseClient): Promise<PayPeriodSummary[]> {
  const { data: periodRows, error: pErr } = await sb
    .from("pay_periods")
    .select("*")
    .order("start_date", { ascending: false });
  if (pErr) throw new Error(`Load pay periods failed: ${pErr.message}`);
  const periods = (periodRows ?? []) as PayPeriod[];
  if (periods.length === 0) return [];

  const [
    { data: configRows },
    { data: entryRows },
    { data: settingsRow },
    { data: reportRows },
    { data: matchRows },
  ] = await Promise.all([
    sb.from("payroll_config").select("effective_from, base_rate_cents"),
    sb.from("payroll_entries").select("pay_period_id, hours_worked, paycheck_tips_cents, cash_tips_cents, bonus_cents"),
    sb.from("payroll_gl_settings").select("payroll_taxes_chart_of_accounts_id").maybeSingle(),
    sb.from("payroll_gl_reports").select("id, pay_period_id, uploaded_at, original_filename").is("superseded_at", null),
    sb.from("payroll_period_expense_matches").select("pay_period_id, expense_id"),
  ]);

  const configs = (configRows ?? []) as { effective_from: string; base_rate_cents: number }[];
  const taxesAccountId =
    (settingsRow as { payroll_taxes_chart_of_accounts_id: string } | null)?.payroll_taxes_chart_of_accounts_id ?? null;

  // entries grouped by period
  const entriesByPeriod = new Map<string, BasisEntry[]>();
  for (const e of (entryRows ?? []) as ({ pay_period_id: string } & BasisEntry)[]) {
    const arr = entriesByPeriod.get(e.pay_period_id) ?? [];
    arr.push(e);
    entriesByPeriod.set(e.pay_period_id, arr);
  }

  // active report per period (latest upload wins if more than one is non-superseded)
  const reports = (reportRows ?? []) as { id: string; pay_period_id: string; uploaded_at: string; original_filename: string }[];
  const reportByPeriod = new Map<string, (typeof reports)[number]>();
  for (const r of reports) {
    const cur = reportByPeriod.get(r.pay_period_id);
    if (!cur || r.uploaded_at > cur.uploaded_at) reportByPeriod.set(r.pay_period_id, r);
  }

  // report GL totals for the active reports
  const activeReportIds = [...reportByPeriod.values()].map((r) => r.id);
  const totalsByReport = new Map<string, { chart_of_accounts_id: string; amount_cents: number }[]>();
  if (activeReportIds.length > 0) {
    const { data: totalRows } = await sb
      .from("payroll_gl_report_totals")
      .select("report_id, chart_of_accounts_id, amount_cents")
      .in("report_id", activeReportIds);
    for (const t of (totalRows ?? []) as { report_id: string; chart_of_accounts_id: string; amount_cents: number }[]) {
      const arr = totalsByReport.get(t.report_id) ?? [];
      arr.push({ chart_of_accounts_id: t.chart_of_accounts_id, amount_cents: t.amount_cents });
      totalsByReport.set(t.report_id, arr);
    }
  }

  // matches grouped by period + matched expense amounts + split presence
  const matchedByPeriod = new Map<string, string[]>();
  for (const m of (matchRows ?? []) as { pay_period_id: string; expense_id: string }[]) {
    const arr = matchedByPeriod.get(m.pay_period_id) ?? [];
    arr.push(m.expense_id);
    matchedByPeriod.set(m.pay_period_id, arr);
  }
  const allMatchedIds = [...new Set([...matchedByPeriod.values()].flat())];

  const amountByExpense = new Map<string, number>();
  const expenseIdsWithSplits = new Set<string>();
  if (allMatchedIds.length > 0) {
    const [{ data: expRows }, { data: splitRows }] = await Promise.all([
      sb.from("expenses").select("id, amount_cents").in("id", allMatchedIds),
      sb.from("expense_gl_splits").select("expense_id").in("expense_id", allMatchedIds),
    ]);
    for (const e of (expRows ?? []) as { id: string; amount_cents: number | null }[]) {
      amountByExpense.set(e.id, Math.abs(e.amount_cents ?? 0));
    }
    for (const s of (splitRows ?? []) as { expense_id: string }[]) expenseIdsWithSplits.add(s.expense_id);
  }

  return periods.map((p) => {
    const entries = entriesByPeriod.get(p.id) ?? [];
    const basis = computePeriodBasis(entries, pickBaseRate(configs, p.start_date));

    const report = reportByPeriod.get(p.id) ?? null;
    const totals = report ? (totalsByReport.get(report.id) ?? []) : [];
    const gustoTotalCents = report ? totals.reduce((s, t) => s + t.amount_cents, 0) : null;
    const gustoWagesCents = report
      ? totals.filter((t) => t.chart_of_accounts_id !== taxesAccountId).reduce((s, t) => s + t.amount_cents, 0)
      : null;

    const matchedIds = matchedByPeriod.get(p.id) ?? [];
    const matchedSumCents = matchedIds.reduce((s, id) => s + (amountByExpense.get(id) ?? 0), 0);

    const driftCents =
      basis && gustoWagesCents !== null ? basis.wagesCents - gustoWagesCents : null;
    const reconciliationCents =
      gustoTotalCents !== null && matchedIds.length > 0 ? matchedSumCents - gustoTotalCents : null;

    return {
      ...p,
      entryCount: entries.length,
      appBasisCents: basis?.totalCompCents ?? null,
      appWagesCents: basis?.wagesCents ?? null,
      gustoTotalCents,
      gustoWagesCents,
      reportUploadedAt: report?.uploaded_at ?? null,
      reportFilename: report?.original_filename ?? null,
      driftCents,
      matchedCount: matchedIds.length,
      matchedSumCents,
      reconciliationCents,
      splitStatus: deriveSplitStatus(matchedIds, expenseIdsWithSplits),
    };
  });
}
