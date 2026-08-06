"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import Banner from "@/app/components/ui/Banner";
import { useTaxData } from "./hooks/useTaxData";
import TaskList from "./TaskList";
import ScheduleList from "./ScheduleList";

type TaxSubtab = "schedules" | "open" | "closed";

const TABS: TabDef<TaxSubtab>[] = [
  { key: "schedules", label: "Schedules" },
  { key: "open", label: "Open Tasks" },
  { key: "closed", label: "Closed Tasks" },
];

function isTaxSubtab(value: string | null): value is TaxSubtab {
  return TABS.some((t) => t.key === value);
}

/**
 * `?tab=` picks the landing subtab. A worksheet's Back link uses it to return
 * to Open Tasks — where the filer came from — rather than dropping them on
 * Schedules. It's only the initial value: clicking a tab afterwards is local
 * state and doesn't rewrite the URL.
 */
export default function FinanceTaxPage() {
  return (
    <Suspense fallback={null}>
      <FinanceTaxPageInner />
    </Suspense>
  );
}

function FinanceTaxPageInner() {
  const { tasks, schedules, parties, isLoading, isError, error } = useTaxData();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<TaxSubtab>(isTaxSubtab(requestedTab) ? requestedTab : "schedules");

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <FinanceNav mobile />
        <PageHeader title="Tax" description="Upcoming and completed tax filing tasks." />
        <TabBar tabs={TABS} activeKey={tab} onSelect={setTab} className="mb-0" />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        {isLoading && <p className="text-sm text-faint">Loading…</p>}
        {isError && (
          <Banner tone="danger">{error instanceof Error ? error.message : "Failed to load tax tasks."}</Banner>
        )}
        {!isLoading && !isError && (
          <>
            {tab === "schedules" && <ScheduleList schedules={schedules} parties={parties} />}
            {tab === "open" && <TaskList tasks={tasks} schedules={schedules} parties={parties} status="open" />}
            {tab === "closed" && <TaskList tasks={tasks} schedules={schedules} parties={parties} status="closed" />}
          </>
        )}
      </div>
    </main>
  );
}
