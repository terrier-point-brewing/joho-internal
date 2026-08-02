"use client";

import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import Banner from "@/app/components/ui/Banner";
import { useTaxData } from "./hooks/useTaxData";
import TaskList from "./TaskList";
import ScheduleList from "./ScheduleList";

export default function FinanceTaxPage() {
  const { tasks, schedules, parties, isLoading, isError, error } = useTaxData();

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <FinanceNav mobile />
        <PageHeader title="Tax" description="Upcoming and completed tax filing tasks." />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8">
        {isLoading && <p className="text-sm text-faint">Loading…</p>}
        {isError && (
          <Banner tone="danger">{error instanceof Error ? error.message : "Failed to load tax tasks."}</Banner>
        )}
        {!isLoading && !isError && (
          <div className="flex flex-col gap-8">
            <ScheduleList schedules={schedules} parties={parties} />
            <TaskList tasks={tasks} schedules={schedules} parties={parties} />
          </div>
        )}
      </div>
    </main>
  );
}
