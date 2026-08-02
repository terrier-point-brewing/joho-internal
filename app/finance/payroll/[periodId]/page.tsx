"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
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
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <FinanceNav mobile />
        <div className="flex items-center justify-between gap-4">
          <PageHeader title="Payroll" description="Hours, tips, and Gusto reporting by pay period" />
          {periods && (
            <PeriodSelector periods={periods} currentId={periodId} basePath="/finance/payroll" />
          )}
        </div>
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8">
        <PayrollPeriodView
          periodId={periodId}
          editable
          tabs={["summary", "shifts", "adjustments", "gusto", "gustoUpload"]}
        />
      </div>
    </main>
  );
}
