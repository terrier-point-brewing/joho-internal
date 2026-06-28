"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PayrollNav } from "../PayrollNav";
import { PayrollPeriodView } from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function FinancePayrollPeriodPage() {
  const { periodId } = useParams<{ periodId: string }>();

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        {periods && (
          <PeriodSelector
            periods={periods}
            currentId={periodId}
            basePath="/finance/payroll"
          />
        )}
      </div>
      <PayrollNav />
      <PayrollPeriodView
        periodId={periodId}
        editable={true}
        showSalaried={true}
        showGustoSummary={true}
      />
    </main>
  );
}
