"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { PayrollPreview } from "@/lib/payroll/types";

async function fetchPreview(periodId: string): Promise<PayrollPreview> {
  const res = await fetch(`/api/payroll/periods/${periodId}/preview`);
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error ?? "Failed to load payroll preview");
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
