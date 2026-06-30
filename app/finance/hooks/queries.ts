"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { AccountBalanceMoM, AccountBalance } from "@/app/api/finance/statements/route";

/** Chart-of-accounts reference row (invoice line-item GL mapping). */
export interface CoARef {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
}

export function useChartOfAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.finance.chartOfAccounts(),
    queryFn: () => fetchJson<CoARef[]>("/api/finance/chart-of-accounts"),
  });
}

interface StatementsMoMResponse {
  year: number;
  accounts: AccountBalanceMoM[];
}

/**
 * P&L (view="mom") and Cash-Flow (view="cash") share the month-over-month
 * shape and the same year+view cache key, so switching views or revisiting a
 * year within the 30s window hits cache instead of re-running the heavy
 * pos_line_items + invoice_line_items aggregation.
 */
export function useStatementsQuery(year: number, view: "mom" | "cash") {
  return useQuery({
    queryKey: queryKeys.finance.statements(year, view),
    queryFn: () => fetchJson<StatementsMoMResponse>(`/api/finance/statements?view=${view}&year=${year}`),
  });
}

interface StatementsBalanceResponse {
  year: number;
  accounts: AccountBalance[];
}

/**
 * Balance sheet uses cumulative balances and an extra `month` selector, so its
 * URL params differ from the MoM views. `month` is folded into the cache key to
 * avoid collisions between different as-of dates within the same year.
 */
export function useBalanceSheetQuery(year: number, month: number) {
  const params = new URLSearchParams({ year: String(year), cumulative: "true" });
  if (month > 0) params.set("month", String(month));
  return useQuery({
    queryKey: [...queryKeys.finance.statements(year, "balance"), month] as const,
    queryFn: () => fetchJson<StatementsBalanceResponse>(`/api/finance/statements?${params}`),
  });
}
