"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import FinanceNav from "../FinanceNav";
import PeriodsTable from "./PeriodsTable";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";
import { useTableControls } from "@/app/components/ui/useTableControls";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriodSummary } from "@/lib/payroll/types";
import type { ControlsConfig } from "@/lib/table/types";

const CONTROLS: ControlsConfig<PayPeriodSummary> = {
  filters: [{ param: "status", accessor: (p) => p.status }],
  sort: {
    columns: [
      { key: "period", accessor: (p) => p.start_date },
      { key: "due", accessor: (p) => p.due_date ?? "" },
      { key: "basis", accessor: (p) => p.appBasisCents ?? -1 },
      { key: "gusto", accessor: (p) => p.gustoTotalCents ?? -1 },
    ],
    default: { key: "period", dir: "desc" },
  },
};

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "locked", label: "Locked" },
];

export default function FinancePayrollPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");

  const { data: periods, isLoading } = useQuery<PayPeriodSummary[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  const controls = useTableControls<PayPeriodSummary>(periods ?? [], CONTROLS);

  const createPeriod = useMutation({
    mutationFn: (body: { start_date?: string; end_date?: string }) =>
      fetch("/api/payroll/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) return r.json().then((d) => Promise.reject(new Error(d.error)));
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.periods() });
      setShowForm(false);
      setNewStart("");
      setNewEnd("");
    },
  });

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <FinanceNav mobile />
      <div className="flex items-center justify-between gap-4 mb-4">
        <PageHeader title="Payroll" description="Pay periods, payroll basis, and Gusto reconciliation." />
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="btn-secondary">
            + New Period
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-4 mb-6 p-4 bg-surface border border-line-strong rounded-lg flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-secondary text-xs mb-1">Start date</span>
            <input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} className="inp inp-sm" />
          </label>
          <label className="block">
            <span className="block text-secondary text-xs mb-1">End date</span>
            <input type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} className="inp inp-sm" />
          </label>
          <button
            onClick={() => createPeriod.mutate({ start_date: newStart, end_date: newEnd })}
            disabled={createPeriod.isPending || !newStart || !newEnd}
            className="btn-primary"
          >
            {createPeriod.isPending ? "Creating…" : "Create"}
          </button>
          <button
            onClick={() => { setShowForm(false); setNewStart(""); setNewEnd(""); }}
            className="btn-secondary"
          >
            Cancel
          </button>
          {createPeriod.isError && <Banner className="w-full">{(createPeriod.error as Error).message}</Banner>}
        </div>
      )}

      <FilterBar className="mt-4 mb-3" activeCount={controls.activeCount} onClear={controls.reset}>
        <FilterSelect
          label="Status"
          options={STATUS_OPTIONS}
          value={controls.filters.status ?? []}
          onChange={(v) => controls.setFilter("status", v)}
        />
      </FilterBar>

      {isLoading ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : (
        <PeriodsTable rows={controls.rows} sort={controls.sort} onSort={controls.toggleSort} />
      )}

    </main>
  );
}
