/**
 * Database half of service periods (see ./servicePeriod.ts for the rule).
 *
 * Read by the statement fetch layer, the Prepaid Expenses balance provider and
 * the forecast drivers. Must not import from lib/finance/balances — the frozen
 * P&L path (fetchSources.ts) imports this.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { chunk } from "@/lib/utils/chunk";
import { applyExpenseStatementFilters } from "@/lib/finance/financials/expenseFilters";
import type { ServicePeriod } from "./servicePeriod";

/**
 * Every tagged expense's period, keyed by expense id.
 *
 * The whole table, on purpose: a bill gets a row only when somebody says it
 * covers more than a month, so there are a handful per year, and one unfiltered
 * read is cheaper than an `.in()` list of every expense id in the range (which
 * must be chunked to stay under the URL limit).
 */
export async function fetchServicePeriodsByExpenseId(supabase: SupabaseClient): Promise<Map<string, ServicePeriod>> {
  const rows = await fetchAllRows<{ expense_id: string; start_date: string; end_date: string }>(() =>
    supabase.from("expense_service_periods").select("expense_id, start_date, end_date").order("expense_id", { ascending: true }),
  );
  return new Map(rows.map((r) => [r.expense_id, { start: r.start_date, end: r.end_date }]));
}

/** One tagged bill with its income-statement coding resolved, as the balance sheet and the forecast need it. */
export interface SpreadExpense {
  id: string;
  /** The day the bill is dated — recognition never starts before this month. */
  accountingDate: string;
  /** The day the money left, or null while the bill is unpaid. */
  paidDate: string | null;
  period: ServicePeriod;
  /** Every GL line of the expense (its splits, or its own account). Raw cents: an outflow is negative. */
  lines: { chartOfAccountsId: string | null; amountCents: number }[];
}

const IN_FILTER_CHUNK = 200;

/**
 * Every statement-eligible tagged expense dated on or before `through`
 * ("YYYY-MM-DD"), or all of them when `through` is null.
 */
export async function fetchSpreadExpenses(supabase: SupabaseClient, through: string | null): Promise<SpreadExpense[]> {
  const periods = await fetchServicePeriodsByExpenseId(supabase);
  const ids = [...periods.keys()];
  if (ids.length === 0) return [];

  const [expensePages, splitPages] = await Promise.all([
    Promise.all(
      chunk(ids, IN_FILTER_CHUNK).map((part) =>
        fetchAllRows<{
          id: string;
          chart_of_accounts_id: string | null;
          amount_cents: number | null;
          accounting_date: string | null;
          settled_at: string | null;
          state: string | null;
        }>(() => {
          let q = supabase
            .from("expenses")
            .select("id, chart_of_accounts_id, amount_cents, accounting_date, settled_at, state")
            .in("id", part)
            .order("id", { ascending: true });
          if (through) q = q.lte("accounting_date", through);
          return applyExpenseStatementFilters(q, false);
        }),
      ),
    ),
    Promise.all(
      chunk(ids, IN_FILTER_CHUNK).map((part) =>
        fetchAllRows<{ expense_id: string; chart_of_accounts_id: string; amount_cents: number }>(() =>
          supabase
            .from("expense_gl_splits")
            .select("expense_id, chart_of_accounts_id, amount_cents")
            .in("expense_id", part)
            .order("id", { ascending: true }),
        ),
      ),
    ),
  ]);

  const splitsByExpense = new Map<string, { chartOfAccountsId: string | null; amountCents: number }[]>();
  for (const s of splitPages.flat()) {
    const list = splitsByExpense.get(s.expense_id) ?? [];
    list.push({ chartOfAccountsId: s.chart_of_accounts_id, amountCents: s.amount_cents });
    splitsByExpense.set(s.expense_id, list);
  }

  const out: SpreadExpense[] = [];
  for (const e of expensePages.flat()) {
    const period = periods.get(e.id);
    if (!period || !e.accounting_date) continue;
    // A card swipe or bank debit is paid the day it posts; a bill or a
    // reimbursement claim is paid on settled_at (fetchSources' cashDateOf).
    const paidDate = e.settled_at ? e.settled_at.slice(0, 10) : e.state === "CLEARED" ? e.accounting_date : null;
    out.push({
      id: e.id,
      accountingDate: e.accounting_date,
      paidDate,
      period,
      lines: splitsByExpense.get(e.id) ?? [{ chartOfAccountsId: e.chart_of_accounts_id, amountCents: e.amount_cents ?? 0 }],
    });
  }
  return out;
}
