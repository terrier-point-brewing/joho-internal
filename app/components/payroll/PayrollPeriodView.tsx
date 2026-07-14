"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePayrollPeriod } from "@/lib/hooks/usePayrollPeriod";
import { fmtCents, fmtUsd } from "@/lib/utils/formatting";
import { PayrollEntryRow } from "./PayrollEntryRow";
import { GustoSummaryPanel } from "./GustoSummaryPanel";
import { ShiftTimeline } from "./ShiftTimeline";
import { queryKeys } from "@/lib/query-keys";
import TabBar from "@/app/components/TabBar";
import Badge from "@/app/components/ui/Badge";
import { Modal } from "@/app/components/ui/Modal";

export type PayrollTab = "summary" | "shifts" | "gusto";

const TAB_LABELS: Record<PayrollTab, string> = {
  summary: "Summary",
  shifts: "Shifts",
  gusto: "Gusto Summary",
};

interface Props {
  periodId: string;
  editable: boolean;
  /** Which subtabs to expose, in order. First entry is the default. */
  tabs?: PayrollTab[];
}

export function PayrollPeriodView({ periodId, editable, tabs = ["summary", "shifts"] }: Props) {
  const { data: preview, isLoading, error } = usePayrollPeriod(periodId);
  const qc = useQueryClient();
  const [locking, setLocking] = useState(false);
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<PayrollTab>(tabs[0]);
  const [overrideMode, setOverrideMode] = useState(false);
  const [cashView, setCashView] = useState<"actual" | "reported">("actual");

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

  if (isLoading) return <p className="text-muted text-sm p-6">Loading payroll data…</p>;
  if (error) return <p className="text-danger text-sm p-6">{(error as Error).message}</p>;
  if (!preview) return null;

  const { period, config, entries: rawEntries, employees, salaried_employees, tip_buckets, total_pooled_tips_cents } = preview;
  const empById = new Map(employees.map((e) => [e.id, e]));
  const entries = [...rawEntries].sort((a, b) => {
    const aName = empById.get(a.employee_id)?.first_name ?? "";
    const bName = empById.get(b.employee_id)?.first_name ?? "";
    return aName.localeCompare(bName);
  });

  // Summary totals (use effective_* so overrides are reflected)
  const totHours    = entries.reduce((s, e) => s + e.effective_hours, 0);
  const totBase     = entries.reduce((s, e) => s + e.base_pay_cents, 0);
  const totPTips    = entries.reduce((s, e) => s + e.effective_paycheck_tips_cents, 0);
  const totCTips    = entries.reduce((s, e) => s + e.effective_cash_tips_cents, 0);
  const totRCTips   = entries.reduce((s, e) => s + e.effective_reported_cash_tips_cents, 0);
  const totBonus    = entries.reduce((s, e) => s + e.effective_bonus_cents, 0);
  // Toggle-driven basis: actuals drive the bonus/true comp; reported (÷ratio) is the Gusto figure.
  const viewCTips   = cashView === "actual" ? totCTips : totRCTips;
  const viewComp    = totBase + totPTips + viewCTips + totBonus;
  const viewHrlyRate = totHours > 0 ? viewComp / totHours / 100 : null;
  const empName = (id: string) => {
    const e = empById.get(id);
    return e ? `${e.first_name} ${e.last_name}` : `${id.slice(0, 8)}…`;
  };

  const isOpen = period.status === "open";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-body text-sm font-medium">
            {period.start_date} – {period.end_date}
          </span>
          <Badge tone={period.status === "locked" ? "neutral" : "accent"}>
            {period.status === "locked" ? "Locked" : "Open"}
          </Badge>
        </div>
        {editable && isOpen && (
          <div className="flex items-center gap-2">
            {activeTab === "summary" && (
              <button
                onClick={() => setOverrideMode(v => !v)}
                className={overrideMode ? "btn-primary" : "btn-secondary"}
              >
                {overrideMode ? "Exit Override" : "Override Mode"}
              </button>
            )}
            <button onClick={() => setShowLockConfirm(true)} className="btn-primary">
              Lock Period
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <TabBar
        tabs={tabs.map((key) => ({ key, label: TAB_LABELS[key] }))}
        activeKey={activeTab}
        onSelect={(tab) => {
          setActiveTab(tab);
          if (tab !== "summary") setOverrideMode(false);
        }}
      />

      {/* Lock confirmation modal */}
      {showLockConfirm && (
        <Modal title="Lock this pay period?" onClose={() => setShowLockConfirm(false)}>
          <p className="text-secondary text-sm mb-4">
            Final values will be snapshotted and the period cannot be edited after locking.
          </p>
          <table className="w-full text-xs text-body mb-4">
            <thead>
              <tr className="border-b border-line-strong">
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
          <div className="flex gap-2 justify-end pt-2 border-t border-line">
            <button onClick={() => setShowLockConfirm(false)} className="btn-secondary">
              Cancel
            </button>
            <button onClick={handleLock} disabled={locking} className="btn-primary">
              {locking ? "Locking…" : "Confirm Lock"}
            </button>
          </div>
        </Modal>
      )}

      {/* Tab content */}
      {activeTab === "shifts" ? (
        <ShiftTimeline periodId={periodId} />
      ) : activeTab === "gusto" ? (
        <GustoSummaryPanel
          entries={entries}
          employees={employees}
          salariedEmployees={salaried_employees}
        />
      ) : (
        <>
          {/* Cash-tips basis toggle: actual (drives bonus) vs Gusto-reported (÷ ratio) */}
          <div className="mb-4 flex items-center gap-2">
            <span className="text-muted text-xs font-medium">Cash tips basis:</span>
            <button
              onClick={() => setCashView("actual")}
              className={cashView === "actual" ? "btn-primary btn-xxs" : "btn-secondary btn-xxs"}
            >
              Actuals
            </button>
            <button
              onClick={() => setCashView("reported")}
              className={cashView === "reported" ? "btn-primary btn-xxs" : "btn-secondary btn-xxs"}
            >
              Gusto-reported
            </button>
            <span className="text-faint text-xs">
              {cashView === "actual"
                ? "Actual declared cash (drives bonus)"
                : "Reported to Gusto at the configured ratio (bonus unchanged)"}
            </span>
          </div>

          {/* Tip pool summary */}
          {tip_buckets.length > 0 && (
            <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
              <span className="text-muted font-medium">
                Tip Pool ({config.tip_pool_frequency})
              </span>
              {tip_buckets.length <= 4
                ? tip_buckets.map((b, i) => (
                    <span key={i} className="text-secondary">
                      <span className="text-faint">{b.label}:</span>{" "}
                      <span className="font-mono text-accent">{fmtCents(b.tipsPooledCents)}</span>
                    </span>
                  ))
                : null}
              {tip_buckets.length > 1 && (
                <span className="text-secondary">
                  <span className="text-faint">Total:</span>{" "}
                  <span className="font-mono text-accent-soft font-medium">{fmtCents(total_pooled_tips_cents)}</span>
                </span>
              )}
              {tip_buckets.length === 1 && (
                <span className="font-mono text-accent-soft font-medium">{fmtCents(total_pooled_tips_cents)}</span>
              )}
              {tip_buckets.length > 4 && (
                <span className="text-faint">({tip_buckets.length} days — see Shifts tab)</span>
              )}
            </div>
          )}

          {/* Bartender table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="text-left py-2 px-3 text-muted font-medium">Bartender</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Hours</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Base Pay</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Paycheck Tips</th>
                <th className="text-right py-2 px-3 text-muted font-medium">
                  {cashView === "reported" ? "Cash Tips (reported)" : "Cash Tips"}
                </th>
                <th className="text-right py-2 px-3 text-muted font-medium">Bonus</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Total</th>
                <th className="text-right py-2 px-3 text-muted font-medium">$/hr</th>
                {editable && overrideMode && (
                  <th className="py-2 px-3 text-muted font-medium">Adjustment</th>
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
                  cashView={cashView}
                />
              ))}
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={editable && overrideMode ? 9 : 8}
                    className="py-6 text-center text-faint text-sm"
                  >
                    No hourly tip-eligible employees found for this period.
                  </td>
                </tr>
              )}
            </tbody>
            {entries.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line-strong">
                  <td className="py-2 px-3 text-muted text-xs font-medium">Total</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{totHours.toFixed(1)}h</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totBase)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totPTips)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(viewCTips)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totBonus)}</td>
                  <td className="text-right py-2 px-3 text-strong font-mono font-semibold">{fmtCents(viewComp)}</td>
                  <td className="text-right py-2 px-3 text-muted font-mono text-xs">
                    {viewHrlyRate != null ? `${fmtUsd(viewHrlyRate)}/hr` : "—"}
                  </td>
                  {editable && overrideMode && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </div>
  );
}
