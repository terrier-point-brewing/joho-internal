"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePayrollPeriod } from "@/lib/hooks/usePayrollPeriod";
import { fmtCents, fmtUsd } from "@/lib/utils/formatting";
import { PayrollEntryRow } from "./PayrollEntryRow";
import { GustoSummaryPanel } from "./GustoSummaryPanel";
import { SalariedConfirmationList } from "./SalariedConfirmationList";
import { ShiftTimeline } from "./ShiftTimeline";
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
  const [activeTab, setActiveTab] = useState<"summary" | "shifts">("summary");
  const [overrideMode, setOverrideMode] = useState(false);

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

  const { period, config, entries, employees, salaried_employees, tip_buckets, total_pooled_tips_cents } = preview;
  const empById = new Map(employees.map((e) => [e.id, e]));

  // Summary totals (use effective_* so overrides are reflected)
  const totHours    = entries.reduce((s, e) => s + e.effective_hours, 0);
  const totBase     = entries.reduce((s, e) => s + e.base_pay_cents, 0);
  const totPTips    = entries.reduce((s, e) => s + e.effective_paycheck_tips_cents, 0);
  const totCTips    = entries.reduce((s, e) => s + e.effective_cash_tips_cents, 0);
  const totBonus    = entries.reduce((s, e) => s + e.effective_bonus_cents, 0);
  const totComp     = entries.reduce((s, e) => s + e.effective_total_compensation_cents, 0);
  const totHrlyRate = totHours > 0 ? totComp / totHours / 100 : null;
  const empName = (id: string) => {
    const e = empById.get(id);
    return e ? `${e.first_name} ${e.last_name}` : `${id.slice(0, 8)}…`;
  };

  const isOpen = period.status === "open";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
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
        {editable && isOpen && (
          <div className="flex items-center gap-2">
            {activeTab === "summary" && (
              <button
                onClick={() => setOverrideMode(v => !v)}
                className={`text-sm px-3 py-1.5 rounded transition-colors ${
                  overrideMode
                    ? "bg-amber-800 hover:bg-amber-700 text-white"
                    : "bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
                }`}
              >
                {overrideMode ? "Exit Override" : "Override Mode"}
              </button>
            )}
            <button
              onClick={() => setShowLockConfirm(true)}
              className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
            >
              Lock Period
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-5 border-b border-zinc-800">
        {(["summary", "shifts"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              if (tab !== "summary") setOverrideMode(false);
            }}
            className={`px-4 py-2 text-sm capitalize -mb-px border-b-2 transition-colors ${
              activeTab === tab
                ? "border-amber-500 text-zinc-200"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab}
          </button>
        ))}
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
                    <td className="text-right py-1">{fmtCents(e.effective_paycheck_tips_cents + e.effective_cash_tips_cents)}</td>
                    <td className="text-right py-1">{fmtCents(e.effective_bonus_cents)}</td>
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

      {/* Tab content */}
      {activeTab === "shifts" ? (
        <ShiftTimeline periodId={periodId} />
      ) : (
        <>
          {/* Tip pool summary */}
          {tip_buckets.length > 0 && (
            <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
              <span className="text-zinc-500 font-medium">
                Tip Pool ({config.tip_pool_frequency})
              </span>
              {tip_buckets.length <= 4
                ? tip_buckets.map((b, i) => (
                    <span key={i} className="text-zinc-400">
                      <span className="text-zinc-600">{b.label}:</span>{" "}
                      <span className="font-mono text-amber-400">{fmtCents(b.tipsPooledCents)}</span>
                    </span>
                  ))
                : null}
              {tip_buckets.length > 1 && (
                <span className="text-zinc-400">
                  <span className="text-zinc-600">Total:</span>{" "}
                  <span className="font-mono text-amber-300 font-medium">{fmtCents(total_pooled_tips_cents)}</span>
                </span>
              )}
              {tip_buckets.length === 1 && (
                <span className="font-mono text-amber-300 font-medium">${(total_pooled_tips_cents / 100).toFixed(2)}</span>
              )}
              {tip_buckets.length > 4 && (
                <span className="text-zinc-600">({tip_buckets.length} days — see Shifts tab)</span>
              )}
            </div>
          )}

          {/* Bartender table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-700">
                <th className="text-left py-2 px-3 text-zinc-500 font-medium">Bartender</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Hours</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Base Pay</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Paycheck Tips</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Cash Tips</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Bonus</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">Total</th>
                <th className="text-right py-2 px-3 text-zinc-500 font-medium">$/hr</th>
                {editable && overrideMode && (
                  <th className="py-2 px-3 text-zinc-500 font-medium">Adjustment</th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <PayrollEntryRow
                  key={entry.employee_id}
                  entry={entry}
                  employee={empById.get(entry.employee_id)}
                  periodId={periodId}
                  editable={editable && isOpen}
                  overrideMode={overrideMode}
                />
              ))}
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={editable && overrideMode ? 9 : 8}
                    className="py-6 text-center text-zinc-600 text-sm"
                  >
                    No hourly tip-eligible employees found for this period.
                  </td>
                </tr>
              )}
            </tbody>
            {entries.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-zinc-700">
                  <td className="py-2 px-3 text-zinc-500 text-xs font-medium">Total</td>
                  <td className="text-right py-2 px-3 text-zinc-300 font-mono font-medium">{totHours.toFixed(1)}h</td>
                  <td className="text-right py-2 px-3 text-zinc-300 font-mono font-medium">{fmtCents(totBase)}</td>
                  <td className="text-right py-2 px-3 text-zinc-300 font-mono font-medium">{fmtCents(totPTips)}</td>
                  <td className="text-right py-2 px-3 text-zinc-300 font-mono font-medium">{fmtCents(totCTips)}</td>
                  <td className="text-right py-2 px-3 text-zinc-300 font-mono font-medium">{fmtCents(totBonus)}</td>
                  <td className="text-right py-2 px-3 text-zinc-200 font-mono font-semibold">{fmtCents(totComp)}</td>
                  <td className="text-right py-2 px-3 text-zinc-500 font-mono text-xs">
                    {totHrlyRate != null ? `${fmtUsd(totHrlyRate)}/hr` : "—"}
                  </td>
                  {editable && overrideMode && <td />}
                </tr>
              </tfoot>
            )}
          </table>

          {showSalaried && <SalariedConfirmationList employees={salaried_employees} />}
          {showGustoSummary && (
            <GustoSummaryPanel
              entries={entries}
              employees={employees}
              salariedEmployees={salaried_employees}
            />
          )}
        </>
      )}
    </div>
  );
}
