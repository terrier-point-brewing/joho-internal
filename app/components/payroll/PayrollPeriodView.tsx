"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePayrollPeriod, usePriorPeriodTotals } from "@/lib/hooks/usePayrollPeriod";
import { fmtCents, fmtUsd } from "@/lib/utils/formatting";
import { PayrollEntryRow } from "./PayrollEntryRow";
import { GustoSummaryPanel } from "./GustoSummaryPanel";
import { GustoUploadPanel } from "./GustoUploadPanel";
import { ShiftTimeline } from "./ShiftTimeline";
import { AdjustmentsPanel } from "./AdjustmentsPanel";
import { queryKeys } from "@/lib/query-keys";
import Badge from "@/app/components/ui/Badge";
import ToggleChip from "@/app/components/ui/ToggleChip";
import { Modal } from "@/app/components/ui/Modal";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities"; // NOT "@/lib/auth" — barrel pulls server-only code

export type PayrollTab = "summary" | "shifts" | "adjustments" | "gusto" | "gustoUpload";

export const PAYROLL_TAB_LABELS: Record<PayrollTab, string> = {
  summary: "Summary",
  shifts: "Shifts",
  adjustments: "Adjustments",
  gusto: "Gusto Summary",
  gustoUpload: "Gusto Upload",
};

/** Default subtabs for a page that doesn't pass its own list, in order. */
export const DEFAULT_PAYROLL_TABS: PayrollTab[] = ["summary", "shifts", "adjustments"];

interface Props {
  periodId: string;
  editable: boolean;
  /** Which subtab is active — owned by the page so it can live in the frozen header's TabBar. */
  activeTab: PayrollTab;
}

export function PayrollPeriodView({ periodId, editable, activeTab }: Props) {
  const { data: preview, isLoading, error } = usePayrollPeriod(periodId);
  const { data: prior } = usePriorPeriodTotals(periodId);
  const qc = useQueryClient();
  const [locking, setLocking] = useState(false);
  const [showLockConfirm, setShowLockConfirm] = useState(false);
  const [overrideMode, setOverrideMode] = useState(false);
  const [cashView, setCashView] = useState<"actual" | "reported">("actual");
  const { can } = usePermissions();
  const canDayOverride = can(CAP.payrollDayOverride);

  // Mirrors the old TabBar onSelect side-effect: leaving Summary/Shifts drops
  // an in-progress override so it can't be left silently armed on another
  // tab. Adjusted during render (React's documented pattern for resetting
  // state when a prop changes) rather than in an effect, which would fire a
  // second, avoidable render.
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (activeTab !== prevActiveTab) {
    setPrevActiveTab(activeTab);
    if (activeTab !== "summary" && activeTab !== "shifts") setOverrideMode(false);
  }

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
    const aName = empById.get(a.employee_id)?.last_name ?? "";
    const bName = empById.get(b.employee_id)?.last_name ?? "";
    return aName.localeCompare(bName);
  });

  // Summary totals (use effective_* so overrides are reflected)
  const totHours    = entries.reduce((s, e) => s + e.effective_hours, 0);
  const totBase     = entries.reduce((s, e) => s + e.effective_base_pay_cents, 0);
  const totPTips    = entries.reduce((s, e) => s + e.effective_paycheck_tips_cents, 0);
  const totCTips    = entries.reduce((s, e) => s + e.effective_cash_tips_cents, 0);
  const totRCTips   = entries.reduce((s, e) => s + e.effective_reported_cash_tips_cents, 0);
  const totBonus    = entries.reduce((s, e) => s + e.effective_bonus_cents, 0);
  // Toggle-driven basis: actuals drive the bonus/true comp; reported (÷ratio) is the Gusto figure.
  const viewCTips   = cashView === "actual" ? totCTips : totRCTips;
  const viewComp    = totBase + totPTips + viewCTips + totBonus;
  // Basis for the taproom check. totBase is now safe to reuse: effective_base_pay_cents
  // is round(effective_hours × base_rate), the same figure periodSummary.computePeriodBasis
  // derives from the locked snapshot.
  const taproomBasisCents = totBase + totPTips + totBonus;
  const viewHrlyRate = totHours > 0 ? viewComp / totHours / 100 : null;

  // Week-over-week: the prior period's LOCKED snapshot vs. this period's
  // effective totals. Cash tips compare like-for-like with the active basis
  // toggle, so the Total row is the same definition on both lines.
  const priorTotals = prior?.totals ?? null;
  const priorCTips = priorTotals
    ? (cashView === "actual" ? priorTotals.cashTipsCents : priorTotals.reportedCashTipsCents)
    : 0;
  const priorComp = priorTotals
    ? priorTotals.basePayCents + priorTotals.paycheckTipsCents + priorCTips + priorTotals.bonusCents
    : 0;
  const priorHrlyRate = priorTotals && priorTotals.hours > 0 ? priorComp / priorTotals.hours / 100 : null;
  const pct = (now: number, before: number) => (before === 0 ? null : ((now - before) / Math.abs(before)) * 100);
  const compPct = priorTotals ? pct(viewComp, priorComp) : null;
  // 15% on total comp is the "look at this" threshold — big enough to clear
  // normal shift-count noise, small enough to catch a missed or doubled shift.
  const bigSwing = compPct != null && Math.abs(compPct) >= 15;
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
        {isOpen && (
          <div className="flex items-center gap-2">
            {((activeTab === "summary" && editable) || (activeTab === "shifts" && canDayOverride)) && (
              <button
                onClick={() => setOverrideMode(v => !v)}
                className={overrideMode ? "btn-primary" : "btn-secondary"}
              >
                {overrideMode ? "Exit Override" : "Override Mode"}
              </button>
            )}
            {editable && (
              <button onClick={() => setShowLockConfirm(true)} className="btn-primary">
                Lock Period
              </button>
            )}
          </div>
        )}
      </div>


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
        <ShiftTimeline periodId={periodId} overrideMode={overrideMode && canDayOverride} />
      ) : activeTab === "adjustments" ? (
        <AdjustmentsPanel periodId={periodId} entries={entries} employees={employees} />
      ) : activeTab === "gusto" ? (
        <GustoSummaryPanel
          entries={entries}
          employees={employees}
          salariedEmployees={salaried_employees}
        />
      ) : activeTab === "gustoUpload" ? (
        // Wages only — cash tips never move company money, so they're excluded
        // from both sides of the taproom check (see GustoUploadPanel).
        <GustoUploadPanel periodId={periodId} appTaproomWagesCents={taproomBasisCents} />
      ) : (
        <>
          {/* Cash-tips basis toggle: actual (drives bonus) vs Gusto-reported (÷ ratio) */}
          <div className="mb-4 flex items-center gap-2">
            <span className="text-muted text-xs font-medium">Cash tips basis:</span>
            <ToggleChip active={cashView === "actual"} onClick={() => setCashView("actual")}>
              Actuals
            </ToggleChip>
            <ToggleChip active={cashView === "reported"} onClick={() => setCashView("reported")}>
              Gusto-reported
            </ToggleChip>
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

          {/* Week-over-week context line: says why there's no comparison row,
              or flags a swing worth a second look. */}
          {prior && !priorTotals && (
            <p className="text-faint text-xs mb-3">
              {prior.basis === "none"
                ? "No prior pay period to compare against."
                : `Prior period (${prior.priorPeriod?.start_date} – ${prior.priorPeriod?.end_date}) isn't locked yet — no snapshot to compare against.`}
            </p>
          )}
          {bigSwing && compPct != null && (
            <div className="mb-3 rounded border border-accent-border bg-accent-muted/30 px-3 py-2 text-xs text-secondary">
              Total comp is {compPct > 0 ? "up" : "down"} {Math.abs(compPct).toFixed(1)}% vs. the prior period.
            </div>
          )}
          {/* Bartender table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="text-left py-2 px-3 text-muted font-medium">Bartender</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Hours</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Base Pay</th>
                <th className="text-right py-2 px-3 text-muted font-medium">Bonus</th>
                <th className="text-right py-2 px-3 text-muted font-medium">
                  {cashView === "reported" ? "Cash Tips (reported)" : "Cash Tips"}
                </th>
                <th className="text-right py-2 px-3 text-muted font-medium">Paycheck Tips</th>
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
                <tr className="border-t-2 border-line-strong bg-surface-mid/40">
                  <td className="py-2 px-3 text-strong text-xs font-semibold uppercase tracking-wide">This period</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{totHours.toFixed(1)}h</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totBase)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totBonus)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(viewCTips)}</td>
                  <td className="text-right py-2 px-3 text-body font-mono font-medium">{fmtCents(totPTips)}</td>
                  <td className="text-right py-2 px-3 text-strong font-mono font-semibold">{fmtCents(viewComp)}</td>
                  <td className="text-right py-2 px-3 text-muted font-mono text-xs">
                    {viewHrlyRate != null ? `${fmtUsd(viewHrlyRate)}/hr` : "—"}
                  </td>
                  {editable && overrideMode && <td />}
                </tr>
                {/* Week-over-week comparison — prior period's locked snapshot */}
                {priorTotals && prior?.priorPeriod && (
                  <>
                    {/* Comparison block — visually separated from the period's own totals */}
                    <tr className="border-t-2 border-line-strong">
                      <td
                        colSpan={editable && overrideMode ? 9 : 8}
                        className="pt-3 pb-1 px-3 text-faint text-[11px] font-medium uppercase tracking-wide"
                      >
                        Comparison — prior period ({prior.priorPeriod.start_date} – {prior.priorPeriod.end_date}, locked)
                      </td>
                    </tr>
                    <tr className="text-xs text-faint">
                      <td className="py-1.5 px-3 pl-6">Prior period</td>
                      <td className="text-right py-1.5 px-3 font-mono">{priorTotals.hours.toFixed(1)}h</td>
                      <td className="text-right py-1.5 px-3 font-mono">{fmtCents(priorTotals.basePayCents)}</td>
                      <td className="text-right py-1.5 px-3 font-mono">{fmtCents(priorTotals.bonusCents)}</td>
                      <td className="text-right py-1.5 px-3 font-mono">{fmtCents(priorCTips)}</td>
                      <td className="text-right py-1.5 px-3 font-mono">{fmtCents(priorTotals.paycheckTipsCents)}</td>
                      <td className="text-right py-1.5 px-3 font-mono">{fmtCents(priorComp)}</td>
                      <td className="text-right py-1.5 px-3 font-mono">
                        {priorHrlyRate != null ? `${fmtUsd(priorHrlyRate)}/hr` : "—"}
                      </td>
                      {editable && overrideMode && <td />}
                    </tr>
                    <tr className="text-xs">
                      <td className="py-1.5 px-3 pl-6 text-faint">Change vs. prior</td>
                      <td className="text-right py-1.5 px-3 font-mono text-secondary">
                        {totHours - priorTotals.hours === 0
                          ? "—"
                          : `${totHours > priorTotals.hours ? "+" : "-"}${Math.abs(totHours - priorTotals.hours).toFixed(1)}h`}
                      </td>
                      <DeltaCents diff={totBase - priorTotals.basePayCents} />
                      <DeltaCents diff={totBonus - priorTotals.bonusCents} />
                      <DeltaCents diff={viewCTips - priorCTips} />
                      <DeltaCents diff={totPTips - priorTotals.paycheckTipsCents} />
                      <td className={`text-right py-1.5 px-3 font-mono font-medium ${bigSwing ? "text-accent" : "text-body"}`}>
                        {viewComp - priorComp === 0
                          ? "—"
                          : `${viewComp > priorComp ? "+" : "-"}${fmtCents(Math.abs(viewComp - priorComp))}`}
                        {compPct != null && (
                          <span className="text-faint"> ({compPct > 0 ? "+" : "-"}{Math.abs(compPct).toFixed(1)}%)</span>
                        )}
                      </td>
                      <td className="text-right py-1.5 px-3 font-mono text-faint">
                        {viewHrlyRate != null && priorHrlyRate != null
                          ? `${viewHrlyRate > priorHrlyRate ? "+" : "-"}${fmtUsd(Math.abs(viewHrlyRate - priorHrlyRate))}/hr`
                          : "—"}
                      </td>
                      {editable && overrideMode && <td />}
                    </tr>
                  </>
                )}
              </tfoot>
            )}
          </table>
        </>
      )}
    </div>
  );
}

/** Signed money delta, monospaced and column-aligned with the totals row. */
function DeltaCents({ diff, colSpanClass = "" }: { diff: number; colSpanClass?: string }) {
  const zero = diff === 0;
  return (
    <td className={`text-right py-1.5 px-3 font-mono text-xs ${zero ? "text-faint" : "text-secondary"} ${colSpanClass}`}>
      {zero ? "—" : `${diff > 0 ? "+" : "-"}${fmtCents(Math.abs(diff))}`}
    </td>
  );
}
