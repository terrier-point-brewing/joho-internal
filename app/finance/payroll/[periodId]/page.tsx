"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import FinanceNav from "../../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar from "@/app/components/TabBar";
import {
  PayrollPeriodView,
  PAYROLL_TAB_LABELS,
  type PayrollTab,
} from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

const TABS: PayrollTab[] = ["summary", "shifts", "adjustments", "gusto", "gustoUpload"];

export default function FinancePayrollPeriodPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const [activeTab, setActiveTab] = useState<PayrollTab>(TABS[0]);

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
        <TabBar
          tabs={TABS.map((key) => ({ key, label: PAYROLL_TAB_LABELS[key] }))}
          activeKey={activeTab}
          onSelect={setActiveTab}
          className="mb-0"
        />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8">
        <PayrollPeriodView periodId={periodId} editable activeTab={activeTab} />
      </div>
    </main>
  );
}
