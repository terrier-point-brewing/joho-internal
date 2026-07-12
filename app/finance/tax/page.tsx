"use client";

import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import { useTaxData } from "./hooks/useTaxData";
import TaskList from "./TaskList";

export default function FinanceTaxPage() {
  const { tasks, schedules, parties, isLoading, isError, error } = useTaxData();

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <FinanceNav mobile />
      <PageHeader title="Tax" description="Upcoming and completed tax filing tasks." />

      {isLoading && <p className="text-sm text-faint">Loading…</p>}
      {isError && (
        <Banner tone="danger">{error instanceof Error ? error.message : "Failed to load tax tasks."}</Banner>
      )}
      {!isLoading && !isError && <TaskList tasks={tasks} schedules={schedules} parties={parties} />}
    </main>
  );
}
