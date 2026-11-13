"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar from "@/app/components/TabBar";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import {
  PayrollPeriodView,
  PAYROLL_TAB_LABELS,
  DEFAULT_PAYROLL_TABS,
  type PayrollTab,
} from "@/app/components/payroll/PayrollPeriodView";
import { PeriodSelector } from "@/app/components/payroll/PeriodSelector";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function TaproomPayrollPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const [activeTab, setActiveTab] = useState<PayrollTab>(DEFAULT_PAYROLL_TABS[0]);

  const { data: periods } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={TAPROOM_NAV} mobile />
        {/* Below `md` the period picker sits under the title, not beside it,
            where it squeezed the title to a few words (§7 C). */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-x-4 gap-y-2 max-md:mb-2">
          <PageHeader title="Payroll" description="Bartender hours, tips, and pay by pay period" />
          {periods && (
            <div className="md:shrink-0 md:mt-4">
              <PeriodSelector periods={periods} currentId={periodId} basePath="/taproom/payroll" />
            </div>
          )}
        </div>
        <TabBar
          tabs={DEFAULT_PAYROLL_TABS.map((key) => ({ key, label: PAYROLL_TAB_LABELS[key] }))}
          activeKey={activeTab}
          onSelect={setActiveTab}
          className="mb-0"
        />
      </StickyHeader>
      {/* Read-only operational view. Overrides + locking live in Finance › Payroll. */}
      <div className="mt-4 pb-4 sm:pb-8">
        <PayrollPeriodView periodId={periodId} editable={false} activeTab={activeTab} />
      </div>
    </main>
  );
}
