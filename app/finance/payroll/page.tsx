"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { PayrollNav } from "./PayrollNav";
import { queryKeys } from "@/lib/query-keys";
import type { PayPeriod } from "@/lib/payroll/types";

export default function FinancePayrollPage() {
  const qc = useQueryClient();
  const { data: periods, isLoading } = useQuery<PayPeriod[]>({
    queryKey: queryKeys.payroll.periods(),
    queryFn: () => fetch("/api/payroll/periods").then((r) => r.json()),
  });

  const createPeriod = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/periods", { method: "POST" }).then((r) => {
        if (!r.ok) return r.json().then((d) => Promise.reject(d.error));
        return r.json();
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.periods() }),
  });

  return (
    <main className="px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-zinc-100 font-semibold text-lg">Payroll</h1>
        <button
          onClick={() => createPeriod.mutate()}
          disabled={createPeriod.isPending}
          className="text-sm px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
        >
          {createPeriod.isPending ? "Creating…" : "+ New Period"}
        </button>
      </div>
      <PayrollNav />
      {createPeriod.isError && (
        <p className="text-red-400 text-sm mb-4">{String(createPeriod.error)}</p>
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
