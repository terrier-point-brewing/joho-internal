"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePayrollPeriod } from "@/lib/hooks/usePayrollPeriod";
import { PayrollEntryRow } from "./PayrollEntryRow";
import { GustoSummaryPanel } from "./GustoSummaryPanel";
import { SalariedConfirmationList } from "./SalariedConfirmationList";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  periodId: string;
  editable: boolean;
  showSalaried: boolean;
  showGustoSummary: boolean;
}

export function PayrollPeriodView({ periodId, editable, showSalaried, showGustoSummary }: Props) {
  const { data: preview, isLoading, error } = usePayrollPeriod(periodId);
  const qc = useQueryClient();
  const [locking, setLocking] = useState(false);
  const [showLockConfirm, setShowLockConfirm] = useState(false);

  async function handleLock() {
    setLocking(true);
    const res = await fetch(`/api/payroll/periods/${periodId}/lock`, { method: "POST" });
    if (!res.ok) {
      const { error: e } = await res.json().catch(() => ({ error: "Unknown error" }));
      alert(`Lock failed: ${e}`);
      setLocking(false);
      return;
    }
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.all() });
    setLocking(false);
    setShowLockConfirm(false);
  }

  if (isLoading) return <p className="text-zinc-500 text-sm p-6">Loading payroll data…</p>;
  if (error) return <p className="text-red-400 text-sm p-6">{(error as Error).message}</p>;
  if (!preview) return null;

  const { period, entries, employees, salaried_employees } = preview;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const empName = (id: string) => {
    const e = empById.get(id);
    return e ? `${e.first_name} ${e.last_name}` : `${id.slice(0, 8)}…`;
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="text-zinc-300 text-sm font-medium">
            {period.start_date} – {period.end_date}
          </span>
          <span className={`ml-3 text-xs px-2 py-0.5 rounded-full ${
            period.status === "locked"
              ? "bg-zinc-700 text-zinc-400"
              : "bg-amber-900/30 text-amber-400"
          }`}>
            {period.status === "locked" ? "Locked" : "Open"}
          </span>
        </div>
        {editable && period.status === "open" && (
          <button
            onClick={() => setShowLockConfirm(true)}
            className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
          >
            Lock Period
          </button>
        )}
      </div>

      {/* Lock confirmation modal */}
      {showLockConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-zinc-100 font-semibold mb-2">Lock this pay period?</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Final values will be snapshotted and the period cannot be edited after locking.
            </p>
            <table className="w-full text-xs text-zinc-300 mb-4">
              <thead>
                <tr className="border-b border-zinc-700">
                  <th className="text-left py-1">Employee</th>
                  <th className="text-right py-1">Hours</th>
                  <th className="text-right py-1">Tips</th>
                  <th className="text-right py-1">Bonus</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.employee_id}>
                    <td className="py-1">{empName(e.employee_id)}</td>
                    <td className="text-right py-1">{e.effective_hours.toFixed(1)}h</td>
                    <td className="text-right py-1">${((e.effective_paycheck_tips_cents + e.effective_cash_tips_cents) / 100).toFixed(2)}</td>
                    <td className="text-right py-1">${(e.effective_bonus_cents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowLockConfirm(false)} className="text-sm text-zinc-400 hover:text-zinc-200">
                Cancel
              </button>
              <button
                onClick={handleLock}
                disabled={locking}
                className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
              >
                {locking ? "Locking…" : "Confirm Lock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bartender table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="text-left py-2 px-3 text-zinc-500 font-medium">Bartender</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Hours</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Paycheck Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Cash Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Bonus</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Total</th>
            {editable && <th className="py-2 px-3 text-zinc-500 font-medium">Adjustment</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <PayrollEntryRow
              key={entry.employee_id}
              entry={entry}
              employee={empById.get(entry.employee_id)}
              periodId={periodId}
              editable={editable && period.status === "open"}
            />
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={editable ? 7 : 6} className="py-6 text-center text-zinc-600 text-sm">
                No hourly tip-eligible employees found for this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showSalaried && <SalariedConfirmationList employees={salaried_employees} />}
      {showGustoSummary && (
        <GustoSummaryPanel
          entries={entries}
          employees={employees}
          salariedEmployees={salaried_employees}
        />
      )}
    </div>
  );
}
