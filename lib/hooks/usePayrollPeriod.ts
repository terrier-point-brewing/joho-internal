"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { PayrollPreview } from "@/lib/payroll/types";
import type { PriorPeriodComparison } from "@/lib/payroll/priorPeriodTotals";

async function fetchPreview(periodId: string): Promise<PayrollPreview> {
  const res = await fetch(`/api/payroll/periods/${periodId}/preview`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = "Failed to load payroll preview";
    try {
      const json = JSON.parse(text) as { error?: string };
      message = json.error ?? message;
    } catch {
      if (res.status === 401) message = "Session expired — please reload the page";
      else if (res.status === 403) message = "Insufficient permissions to view payroll";
      else if (text) message = text;
    }
    throw new Error(message);
  }
  return res.json();
}

export function usePayrollPeriod(periodId: string) {
  return useQuery({
    queryKey: queryKeys.payroll.preview(periodId),
    queryFn: () => fetchPreview(periodId),
    enabled: !!periodId,
    staleTime: 30_000, // re-fetch after 30s since Square data changes
  });
}

/**
 * Prior period's locked-snapshot totals, for the Summary tab's week-over-week
 * comparison. Separate from the preview because it's a cheap DB read — the
 * preview recomputes from Square and is far too expensive to run twice.
 */
export function usePriorPeriodTotals(periodId: string) {
  return useQuery<PriorPeriodComparison>({
    queryKey: queryKeys.payroll.prior(periodId),
    queryFn: async () => {
      const res = await fetch(`/api/payroll/periods/${periodId}/prior`);
      if (!res.ok) throw new Error("Failed to load prior period totals");
      return res.json();
    },
    enabled: !!periodId,
    staleTime: 5 * 60_000, // a locked snapshot doesn't move
  });
}
