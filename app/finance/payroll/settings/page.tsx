"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PayrollNav } from "../PayrollNav";
import { queryKeys } from "@/lib/query-keys";
import type { Employee, PayrollConfig } from "@/lib/payroll/types";

function formatDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export default function PayrollSettingsPage() {
  const qc = useQueryClient();

  const { data: config } = useQuery<PayrollConfig>({
    queryKey: queryKeys.payroll.config(),
    queryFn: () => fetch("/api/payroll/config").then((r) => r.json()),
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: queryKeys.payroll.employees(),
    queryFn: () => fetch("/api/payroll/employees").then((r) => r.json()),
  });

  const [baseRate, setBaseRate] = useState("");
  const [guaranteedRate, setGuaranteedRate] = useState("");
  const [cashTipsRate, setCashTipsRate] = useState("");

  useEffect(() => {
    if (config) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setBaseRate(formatDollars(config.base_rate_cents));
      setGuaranteedRate(formatDollars(config.guaranteed_rate_cents));
      setCashTipsRate(String(config.cash_tips_rate));
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          effective_from: new Date().toISOString().slice(0, 10),
          base_rate_cents: Math.round(parseFloat(baseRate) * 100),
          guaranteed_rate_cents: Math.round(parseFloat(guaranteedRate) * 100),
          cash_tips_rate: parseFloat(cashTipsRate),
          first_pay_period_start_date: config?.first_pay_period_start_date ?? new Date().toISOString().slice(0, 10),
        }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.config() }),
  });

  const toggleEmployee = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetch(`/api/payroll/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() }),
  });

  return (
    <main className="px-4 sm:px-6 py-8 max-w-3xl">
      <h1 className="text-zinc-100 font-semibold text-lg mb-4">Payroll</h1>
      <PayrollNav />

      {/* Rate Configuration */}
      <section className="mb-10">
        <h2 className="text-zinc-300 font-medium text-sm mb-4">Rate Configuration</h2>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <label className="block">
            <span className="text-zinc-500 text-xs">Base Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={baseRate}
              onChange={(e) => setBaseRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-zinc-500 text-xs">Guaranteed Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={guaranteedRate}
              onChange={(e) => setGuaranteedRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-zinc-500 text-xs">Cash Tips Rate (e.g. 0.01)</span>
            <input
              type="number" step="0.001" min="0" max="1"
              value={cashTipsRate}
              onChange={(e) => setCashTipsRate(e.target.value)}
              className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm"
            />
          </label>
        </div>
        <button
          onClick={() => saveConfig.mutate()}
          disabled={saveConfig.isPending}
          className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
        >
          {saveConfig.isPending ? "Saving…" : "Save New Config Version"}
        </button>
      </section>

      {/* Calculation Reference */}
      <section className="mb-10">
        <h2 className="text-zinc-300 font-medium text-sm mb-3">Calculation Reference</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-400 space-y-2 font-mono">
          <p><span className="text-zinc-200">hour_share</span> = employee_hours / total_tipped_hours</p>
          <p><span className="text-zinc-200">paycheck_tips</span> = hour_share × total_pooled_tips <span className="text-zinc-600">(from Square)</span></p>
          <p><span className="text-zinc-200">cash_tips</span> = hour_share × <span className="text-amber-400">{cashTipsRate || "0.01"}</span> × total_cash_take</p>
          <p><span className="text-zinc-200">base_pay</span> = hours × <span className="text-amber-400">${baseRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">guaranteed_min</span> = hours × <span className="text-amber-400">${guaranteedRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">bonus</span> = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)</p>
        </div>
        <p className="text-xs text-zinc-600 mt-2">
          Tip distribution model: <span className="text-zinc-400">Proportional Hours</span> — tips are split pro-rata by hours worked, matching Square&apos;s native pooling behaviour.
        </p>
      </section>

      {/* Employee Management */}
      <section>
        <h2 className="text-zinc-300 font-medium text-sm mb-3">Employees</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-zinc-500">Title</th>
              <th className="text-left py-2 px-3 text-zinc-500">Type</th>
              <th className="text-left py-2 px-3 text-zinc-500">Tips</th>
              <th className="text-left py-2 px-3 text-zinc-500">Square ID</th>
              <th className="py-2 px-3 text-zinc-500">Active</th>
            </tr>
          </thead>
          <tbody>
            {(employees ?? []).map((emp) => (
              <tr key={emp.id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">{emp.first_name} {emp.last_name}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.job_title}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.employment_type.replace(/_/g, " ")}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.receives_tips ? "Yes" : "No"}</td>
                <td className="py-2 px-3 text-zinc-600 text-xs font-mono">
                  {emp.square_team_member_id?.slice(0, 12) ?? "—"}
                </td>
                <td className="py-2 px-3 text-center">
                  <button
                    onClick={() => toggleEmployee.mutate({ id: emp.id, active: !emp.active })}
                    className={`text-xs px-2 py-0.5 rounded ${
                      emp.active
                        ? "bg-green-900/30 text-green-400 hover:bg-red-900/30 hover:text-red-400"
                        : "bg-zinc-800 text-zinc-500 hover:bg-green-900/30 hover:text-green-400"
                    }`}
                  >
                    {emp.active ? "Active" : "Inactive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
