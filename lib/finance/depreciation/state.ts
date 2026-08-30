/**
 * The IO half of depreciation: what is scheduled, and what has been coded to
 * the scheduled accounts. The arithmetic lives in ./engine.ts; this module
 * only assembles its inputs, so the P&L injection, the balance-sheet provider
 * and retained earnings all feed the engine identical facts.
 *
 * ── Where additions come from ────────────────────────────────────────────────
 * The dated postings into each scheduled asset account, from the same sources
 * the balance-sheet postings roll-up reads: expenses (minus split parents),
 * expense GL splits, bank lines (minus split parents, behind the operator's
 * feed-inclusion rules), bank GL splits (gated by their PARENT's inclusion),
 * and hand-typed flow entries. Signs go through normalizeSignedCents with the
 * account's own section, so "money out bought an asset" cannot drift from how
 * the balance sheet reads the same rows.
 *
 * POS lines, invoice lines and refunds are deliberately NOT read: a fixed
 * asset acquired through a till sale is not a state this business has, and
 * every source read here is one that must stay sign-consistent forever. If
 * one ever appears, the account's balance (which does count them) will
 * disagree with the depreciable basis and the explainer's source list says
 * why.
 *
 * ── This module must not import from lib/finance/balances ────────────────────
 * It feeds the P&L path, and scripts/check-statement-isolation.mjs forbids the
 * frozen P&L modules from reaching the balances tree even transitively through
 * a helper like this one. Everything here comes from lib/finance/* proper.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { normalizeSignedCents } from "@/lib/finance/financials/normalizeSign";
import { coaSection, type CoaRecord } from "@/lib/finance/financials/aggregateRows";
import { applyExpenseStatementFilters } from "@/lib/finance/financials/expenseFilters";
import { proratedManualAdjustment } from "@/lib/finance/financials/manualNetSales";
import { loadBankLedgerInclusion, INCLUSION_COLUMNS, type InclusionFacts } from "@/lib/finance/bankLedgerInclusion";
import { computeDepreciationSeries, type Addition, type DepreciationSeries, type LifeRevision } from "./engine";

export interface DepreciationSchedule {
  id: string;
  assetChartOfAccountsId: string;
  expenseChartOfAccountsId: string;
  contraChartOfAccountsId: string;
  /** "YYYY-MM" of the month the schedule stopped accruing, or null while live. */
  endedMonth: string | null;
  /** Inception life first (effectiveMonth null), later revisions ascending. */
  revisions: LifeRevision[];
}

/** A schedule with its additions resolved — everything the engine needs. */
export interface ScheduleState extends DepreciationSchedule {
  additions: Addition[];
}

function monthOf(dateStr: string | null | undefined): string | null {
  return dateStr && dateStr.length >= 7 ? dateStr.slice(0, 7) : null;
}

/** Every active schedule with its life history, unfiltered. */
export async function fetchDepreciationSchedules(supabase: SupabaseClient): Promise<DepreciationSchedule[]> {
  const { data: rows, error } = await supabase
    .from("depreciation_schedules")
    .select("id, asset_chart_of_accounts_id, expense_chart_of_accounts_id, contra_chart_of_accounts_id, ended_month")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Load depreciation schedules failed: ${error.message}`);
  if (!rows || rows.length === 0) return [];

  const { data: revRows, error: revErr } = await supabase
    .from("depreciation_life_revisions")
    .select("schedule_id, effective_month, life_months")
    .in("schedule_id", rows.map((r) => r.id))
    // Nulls (the inception life) first, then ascending — the engine's expected
    // order, though it re-sorts defensively.
    .order("effective_month", { ascending: true, nullsFirst: true });
  if (revErr) throw new Error(`Load depreciation life revisions failed: ${revErr.message}`);

  const revisionsBySchedule = new Map<string, LifeRevision[]>();
  for (const r of revRows ?? []) {
    const list = revisionsBySchedule.get(r.schedule_id as string) ?? [];
    list.push({ effectiveMonth: monthOf(r.effective_month as string | null), lifeMonths: r.life_months as number });
    revisionsBySchedule.set(r.schedule_id as string, list);
  }

  return rows.map((r) => ({
    id: r.id as string,
    assetChartOfAccountsId: r.asset_chart_of_accounts_id as string,
    expenseChartOfAccountsId: r.expense_chart_of_accounts_id as string,
    contraChartOfAccountsId: r.contra_chart_of_accounts_id as string,
    endedMonth: monthOf(r.ended_month as string | null),
    revisions: revisionsBySchedule.get(r.id as string) ?? [],
  }));
}

/**
 * Net additions per month for each of `coaIds`, in internal balance-sheet
 * convention (positive = asset acquired). Keyed by account id.
 */
async function fetchAdditionsByAccount(
  supabase: SupabaseClient,
  coaIds: string[],
  sectionByCoaId: Map<string, string>,
): Promise<Map<string, Addition[]>> {
  const byAccount = new Map<string, Map<string, number>>();
  const add = (coaId: string, month: string | null, cents: number) => {
    if (!month || cents === 0) return;
    const months = byAccount.get(coaId) ?? new Map<string, number>();
    months.set(month, (months.get(month) ?? 0) + cents);
    byAccount.set(coaId, months);
  };
  const sectionOf = (coaId: string) => sectionByCoaId.get(coaId) ?? "fixed_assets";

  const inclusion = await loadBankLedgerInclusion(supabase);

  // ── expenses, minus split parents ──────────────────────────────────────────
  const expenseRows = await fetchAllRows<{ id: string; chart_of_accounts_id: string; accounting_date: string | null; amount_cents: number | null }>(() =>
    applyExpenseStatementFilters(
      supabase
        .from("expenses")
        .select("id, chart_of_accounts_id, accounting_date, amount_cents")
        .in("chart_of_accounts_id", coaIds)
        .order("id", { ascending: true }),
      false,
    ),
  );
  const expenseIds = expenseRows.map((r) => r.id);
  const splitParents = new Set<string>();
  if (expenseIds.length > 0) {
    const parents = await fetchAllRows<{ expense_id: string }>(() =>
      supabase.from("expense_gl_splits").select("expense_id").in("expense_id", expenseIds).order("id", { ascending: true }),
    );
    for (const p of parents) splitParents.add(p.expense_id);
  }
  for (const r of expenseRows) {
    if (splitParents.has(r.id)) continue;
    add(r.chart_of_accounts_id, monthOf(r.accounting_date), normalizeSignedCents(r.amount_cents ?? 0, sectionOf(r.chart_of_accounts_id), "expense"));
  }

  // ── expense GL splits, dated by their parent ───────────────────────────────
  const splitRows = await fetchAllRows<{ chart_of_accounts_id: string; amount_cents: number | null; expenses: { accounting_date: string | null } | null }>(() =>
    supabase
      .from("expense_gl_splits")
      .select("chart_of_accounts_id, amount_cents, expenses!inner ( accounting_date, state, excluded_at )")
      .in("chart_of_accounts_id", coaIds)
      .or("state.is.null,state.neq.DECLINED", { referencedTable: "expenses" })
      .is("expenses.excluded_at", null)
      .order("id", { ascending: true }),
  );
  for (const r of splitRows) {
    add(r.chart_of_accounts_id, monthOf(r.expenses?.accounting_date), normalizeSignedCents(r.amount_cents ?? 0, sectionOf(r.chart_of_accounts_id), "expense"));
  }

  // ── bank lines, inclusion-gated, minus split parents ───────────────────────
  const bankRows = await fetchAllRows<{ id: string; chart_of_accounts_id: string; transaction_date: string | null; amount_cents: number | null } & InclusionFacts>(() =>
    inclusion.applyTo(
      supabase
        .from("bank_ledger")
        .select(`id, chart_of_accounts_id, transaction_date, amount_cents, ${INCLUSION_COLUMNS}`)
        .in("chart_of_accounts_id", coaIds)
        .order("id", { ascending: true }),
    ),
  );
  const counted = bankRows.filter((r) => inclusion.allows(r));
  const bankSplitParents = new Set<string>();
  if (counted.length > 0) {
    const parents = await fetchAllRows<{ bank_ledger_id: string }>(() =>
      supabase.from("bank_ledger_gl_splits").select("bank_ledger_id").in("bank_ledger_id", counted.map((r) => r.id)).order("id", { ascending: true }),
    );
    for (const p of parents) bankSplitParents.add(p.bank_ledger_id);
  }
  for (const r of counted) {
    if (bankSplitParents.has(r.id)) continue;
    add(r.chart_of_accounts_id, monthOf(r.transaction_date), normalizeSignedCents(r.amount_cents ?? 0, sectionOf(r.chart_of_accounts_id), "bank"));
  }

  // ── bank GL splits, dated and gated by their parent ────────────────────────
  const bankSplits = await fetchAllRows<{ chart_of_accounts_id: string; bank_ledger_id: string; amount_cents: number | null }>(() =>
    supabase
      .from("bank_ledger_gl_splits")
      .select("chart_of_accounts_id, bank_ledger_id, amount_cents")
      .in("chart_of_accounts_id", coaIds)
      .order("id", { ascending: true }),
  );
  if (bankSplits.length > 0) {
    const parents = await fetchAllRows<{ id: string; transaction_date: string | null } & InclusionFacts>(() =>
      inclusion.applyTo(
        supabase
          .from("bank_ledger")
          .select(`id, transaction_date, ${INCLUSION_COLUMNS}`)
          .in("id", [...new Set(bankSplits.map((s) => s.bank_ledger_id))])
          .order("id", { ascending: true }),
      ),
    );
    const eligibleParents = new Map(parents.filter((p) => inclusion.allows(p)).map((p) => [p.id, p.transaction_date]));
    for (const s of bankSplits) {
      if (!eligibleParents.has(s.bank_ledger_id)) continue;
      add(s.chart_of_accounts_id, monthOf(eligibleParents.get(s.bank_ledger_id)), normalizeSignedCents(s.amount_cents ?? 0, sectionOf(s.chart_of_accounts_id), "bank"));
    }
  }

  // ── hand-typed flow entries, prorated across their own months ──────────────
  const manualRows = await fetchAllRows<{ id: string; chart_of_accounts_id: string; start_date: string | null; end_date: string | null; amount_cents: number | null }>(() =>
    supabase
      .from("manual_entries")
      .select("id, chart_of_accounts_id, start_date, end_date, amount_cents")
      .eq("entry_kind", "flow")
      .in("chart_of_accounts_id", coaIds)
      .order("id", { ascending: true }),
  );
  for (const r of manualRows) {
    if (!r.start_date || !r.end_date) continue;
    const entry = { id: r.id, startDate: r.start_date, endDate: r.end_date, amountCents: r.amount_cents ?? 0, chartOfAccountsId: r.chart_of_accounts_id };
    // Walk the entry's own months; proratedManualAdjustment answers one month
    // at a time and is the same day-weighting the P&L uses.
    let [y, m] = [Number(r.start_date.slice(0, 4)), Number(r.start_date.slice(5, 7))];
    const endMonth = r.end_date.slice(0, 7);
    for (let month = `${y}-${String(m).padStart(2, "0")}`; month <= endMonth; ) {
      // Manual entries are stored in the internal convention already; no flip.
      add(r.chart_of_accounts_id, month, proratedManualAdjustment([entry], month).cents);
      if (++m > 12) { m = 1; y += 1; }
      month = `${y}-${String(m).padStart(2, "0")}`;
    }
  }

  const out = new Map<string, Addition[]>();
  for (const [coaId, months] of byAccount) {
    out.set(
      coaId,
      [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, cents]) => ({ month, cents })),
    );
  }
  return out;
}

/**
 * Every schedule with its additions resolved — the one call the three readers
 * make. `coa` supplies each asset account's section for sign normalization.
 */
export async function fetchDepreciationState(supabase: SupabaseClient, coa: CoaRecord[]): Promise<ScheduleState[]> {
  const schedules = await fetchDepreciationSchedules(supabase);
  if (schedules.length === 0) return [];

  const sectionByCoaId = new Map(coa.map((c) => [c.id, coaSection(c)]));
  const additionsByAccount = await fetchAdditionsByAccount(
    supabase,
    schedules.map((s) => s.assetChartOfAccountsId),
    sectionByCoaId,
  );

  return schedules.map((s) => ({ ...s, additions: additionsByAccount.get(s.assetChartOfAccountsId) ?? [] }));
}

/** The engine, applied to one schedule's state. */
export function seriesFor(state: ScheduleState, throughMonth: string): DepreciationSeries {
  return computeDepreciationSeries(state.additions, state.revisions, throughMonth, state.endedMonth);
}
