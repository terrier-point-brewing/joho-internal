"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { PayrollNav } from "./PayrollNav";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function FinancePayrollPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");

  const { data: periods, isLoading } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

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
    <main className="px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-base font-semibold text-primary">Payroll</h1>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="btn-ghost btn-sm">
            + New Period
          </button>
        )}
      </div>
      <PayrollNav />

      {showForm && (
        <div className="mb-6 p-4 bg-surface border border-line-strong rounded-lg flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-secondary text-xs mb-1">Start date</span>
            <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)} className="inp inp-sm" />
          </label>
          <label className="block">
            <span className="block text-secondary text-xs mb-1">End date</span>
            <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)} className="inp inp-sm" />
          </label>
          <button
            onClick={() => createPeriod.mutate({ start_date: newStart, end_date: newEnd })}
            disabled={createPeriod.isPending || !newStart || !newEnd}
            className="btn-amber"
          >
            {createPeriod.isPending ? "Creating…" : "Create"}
          </button>
          <button
            onClick={() => { setShowForm(false); setNewStart(""); setNewEnd(""); }}
            className="btn-ghost btn-sm"
          >
            Cancel
          </button>
          {createPeriod.isError && (
            <Banner className="w-full">{(createPeriod.error as Error).message}</Banner>
          )}
        </div>
      )}
      {isLoading ? (
        <p className="text-muted text-sm">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-strong">
              <th className="text-left py-2 px-3 text-muted">Period</th>
              <th className="text-left py-2 px-3 text-muted">Status</th>
            </tr>
          </thead>
          <tbody>
            {(periods ?? []).map((p) => (
              <tr key={p.id} className="border-b border-line hover:bg-surface-mid/30">
                <td className="py-2 px-3">
                  <Link href={`/finance/payroll/${p.id}`} className="text-strong hover:text-accent">
                    {p.start_date} – {p.end_date}
                  </Link>
                </td>
                <td className="py-2 px-3">
                  <Badge tone={p.status === "locked" ? "neutral" : "accent"}>
                    {p.status === "locked" ? "Locked" : "Open"}
                  </Badge>
                </td>
              </tr>
            ))}
            {(periods ?? []).length === 0 && (
              <tr>
                <td colSpan={2} className="py-6 text-center text-faint">
                  No pay periods yet. Click &quot;+ New Period&quot; to create the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
