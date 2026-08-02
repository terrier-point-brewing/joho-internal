"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { PayrollPeriodView } from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function TaproomPayrollPage() {
  const { periodId } = useParams<{ periodId: string }>();

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={TAPROOM_NAV} mobile />
        <div className="flex items-center justify-between gap-4">
          <PageHeader title="Payroll" description="Bartender hours, tips, and pay by pay period" />
          {periods && (
            <PeriodSelector periods={periods} currentId={periodId} basePath="/taproom/payroll" />
          )}
        </div>
      </StickyHeader>
      {/* Read-only operational view. Overrides + locking live in Finance › Payroll. */}
      <div className="mt-4 pb-4 sm:pb-8">
        <PayrollPeriodView periodId={periodId} editable={false} />
      </div>
    </main>
  );
}
