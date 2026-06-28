"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { PayrollPeriodView } from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function TaproomPayrollPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const { role } = useUserRole();
  const isAdmin = role === "admin";

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        {periods && (
          <PeriodSelector
            periods={periods}
            currentId={periodId}
            basePath="/taproom/payroll"
          />
        )}
      </div>
      <PayrollPeriodView
        periodId={periodId}
        editable={isAdmin}
        showSalaried={false}
        showGustoSummary={false}
      />
    </main>
  );
}
