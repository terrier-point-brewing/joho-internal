"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { PayrollNav } from "./PayrollNav";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

const inputCls = "bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-sm";

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
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-sm px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors"
          >
            + New Period
          </button>
        )}
      </div>
      <PayrollNav />

      {showForm && (
        <div className="mb-6 p-4 bg-zinc-900 border border-zinc-700 rounded-lg flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-zinc-500 text-xs mb-1">Start date</span>
            <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="block text-zinc-500 text-xs mb-1">End date</span>
            <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)} className={inputCls} />
          </label>
          <button
            onClick={() => createPeriod.mutate({ start_date: newStart, end_date: newEnd })}
            disabled={createPeriod.isPending || !newStart || !newEnd}
            className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
          >
            {createPeriod.isPending ? "Creating…" : "Create"}
          </button>
          <button
            onClick={() => { setShowForm(false); setNewStart(""); setNewEnd(""); }}
            className="text-sm px-3 py-1.5 text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
          {createPeriod.isError && (
            <p className="w-full text-red-400 text-xs">{(createPeriod.error as Error).message}</p>
          )}
        </div>
      )}
      {isLoading ? (
        <p className="text-zinc-500 text-sm">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Period</th>
              <th className="text-left py-2 px-3 text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {(periods ?? []).map((p) => (
              <tr key={p.id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                <td className="py-2 px-3">
                  <Link href={`/finance/payroll/${p.id}`} className="text-zinc-200 hover:text-amber-400">
                    {p.start_date} – {p.end_date}
                  </Link>
                </td>
                <td className="py-2 px-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    p.status === "locked"
                      ? "bg-zinc-700 text-zinc-400"
                      : "bg-amber-900/30 text-amber-400"
                  }`}>
                    {p.status === "locked" ? "Locked" : "Open"}
                  </span>
                </td>
              </tr>
            ))}
            {(periods ?? []).length === 0 && (
              <tr>
                <td colSpan={2} className="py-6 text-center text-zinc-600">
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
