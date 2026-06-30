"use client";

import SalesNav from "./SalesNav";
import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import SalesTable, { type SalesRow } from "./SalesTable";

/**
 * Shared shell for the four finance sales tabs (taproom / events / contract-brewing /
 * distribution). They are byte-identical except for their ROWS and the data source, so the
 * full-height scroll layout, year picker, refresh button, error banner, and table card live
 * here once. Presentation only — callers own all data fetching.
 */
export default function SalesPageShell({
  rows,
  months,
  monthly,
  loading,
  error,
  year,
  years,
  onYearChange,
  onRefresh,
}: {
  rows: SalesRow[];
  months: string[];
  monthly: Record<string, Record<string, number>>;
  loading: boolean;
  error: unknown;
  year: number;
  years: number[];
  onYearChange: (year: number) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <div className="flex items-center justify-between">
          <PageHeader title="Finance" description="Admin only" />
          <div className="flex items-center gap-2">
            <select
              value={year}
              onChange={(e) => onYearChange(Number(e.target.value))}
              className="inp-sm w-auto"
            >
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={onRefresh} className="btn-amber">Refresh</button>
          </div>
        </div>
        <SalesNav />
      </div>

      {error != null && (
        <Banner className="mx-4 sm:mx-6 mb-4 mt-4">
          {error instanceof Error ? error.message : "Failed to load"}
        </Banner>
      )}

      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-6 pt-4">
        <div className="bg-surface border border-line rounded-lg overflow-hidden">
          <SalesTable rows={rows} months={months} monthly={monthly} loading={loading} />
        </div>
      </div>
    </div>
  );
}
