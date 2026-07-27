"use client";

import { useState } from "react";
import type { Employee, PayrollEntryMerged } from "@/lib/payroll/types";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fmtCents, fmtUsd } from "@/lib/utils/formatting";

interface Props {
  entry: PayrollEntryMerged;
  employee: Employee | undefined;
  periodId: string;
  editable: boolean;
  overrideMode: boolean;
  cashView: "actual" | "reported";
}

const fmt = fmtCents;
const fmtHrs = (h: number) => `${h.toFixed(2)}h`;

const overrideInputCls = "inp-sm w-20 text-right mt-0.5";

interface ValueCellProps {
  effectiveVal: string;
  computedVal: string;
  adjIsSet: boolean;
  adjState: string;
  setAdj: (v: string) => void;
  step?: string;
  editable: boolean;
  overrideMode: boolean;
}

function ValueCell({
  effectiveVal, computedVal, adjIsSet, adjState, setAdj,
  step = "0.01", editable, overrideMode,
}: ValueCellProps) {
  if (editable && overrideMode) {
    return (
      <div className="flex flex-col items-end">
        <span className="text-muted text-xs">{effectiveVal}</span>
        <input
          type="number"
          step={step}
          min="0"
          value={adjState}
          onChange={e => setAdj(e.target.value)}
          placeholder="override"
          className={overrideInputCls}
        />
      </div>
    );
  }
  if (adjIsSet) {
    return (
      <div className="flex flex-col items-end">
        <span className="text-accent-soft">{effectiveVal}</span>
        <span className="text-faint text-xs line-through">{computedVal}</span>
      </div>
    );
  }
  return <span className="text-body">{effectiveVal}</span>;
}

export function PayrollEntryRow({ entry, employee, periodId, editable, overrideMode, cashView }: Props) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);

  const [adjHours, setAdjHours] = useState<string>(
    entry.adj_hours_worked != null ? String(entry.adj_hours_worked) : ""
  );
  const [adjPaycheckTips, setAdjPaycheckTips] = useState<string>(
    entry.adj_paycheck_tips_cents != null ? String(entry.adj_paycheck_tips_cents / 100) : ""
  );
  const [adjCashTips, setAdjCashTips] = useState<string>(
    entry.adj_cash_tips_cents != null ? String(entry.adj_cash_tips_cents / 100) : ""
  );
  const [adjReportedCashTips, setAdjReportedCashTips] = useState<string>(
    entry.adj_reported_cash_tips_cents != null ? String(entry.adj_reported_cash_tips_cents / 100) : ""
  );
  const [adjBonus, setAdjBonus] = useState<string>(
    entry.adj_bonus_cents != null ? String(entry.adj_bonus_cents / 100) : ""
  );
  const [adjNotes, setAdjNotes] = useState(entry.admin_notes ?? "");

  const name = employee
    ? `${employee.first_name} ${employee.last_name}`
    : entry.employee_id;

  const hasAnyOverride =
    entry.adj_hours_worked != null ||
    entry.adj_paycheck_tips_cents != null ||
    entry.adj_cash_tips_cents != null ||
    entry.adj_reported_cash_tips_cents != null ||
    entry.adj_bonus_cents != null;

  async function save() {
    setSaving(true);
    await fetch(`/api/payroll/periods/${periodId}/entries/${entry.employee_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        admin_notes: adjNotes || null,
        adj_hours_worked: adjHours !== "" ? parseFloat(adjHours) : null,
        adj_paycheck_tips_cents: adjPaycheckTips !== "" ? Math.round(parseFloat(adjPaycheckTips) * 100) : null,
        adj_cash_tips_cents: adjCashTips !== "" ? Math.round(parseFloat(adjCashTips) * 100) : null,
        adj_reported_cash_tips_cents: adjReportedCashTips !== "" ? Math.round(parseFloat(adjReportedCashTips) * 100) : null,
        adj_bonus_cents: adjBonus !== "" ? Math.round(parseFloat(adjBonus) * 100) : null,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) });
    setSaving(false);
  }

  const vcProps = { editable, overrideMode };

  // Cash column follows the active basis; reported cash is edited only in the Gusto view.
  const rowCash = cashView === "actual"
    ? entry.effective_cash_tips_cents
    : entry.effective_reported_cash_tips_cents;
  const rowTotal = entry.base_pay_cents + entry.effective_paycheck_tips_cents + rowCash + entry.effective_bonus_cents;

  return (
    <tr className={`border-b border-line ${entry.effective_hours === 0 ? "opacity-40" : ""}`}>
      <td className="py-2 px-3 text-strong text-sm">
        {name}
        {hasAnyOverride && !overrideMode && (
          <span className="ml-1.5 text-accent-emphasis text-xs" title="Has manual overrides">✦</span>
        )}
        {hasAnyOverride && entry.has_day_overrides && (
          <span
            className="ml-1.5 text-danger text-xs"
            title="A period-level override masks a day override on the Shifts tab for this employee"
          >
            ⚠
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-sm text-right">
        <ValueCell
          {...vcProps}
          effectiveVal={fmtHrs(entry.effective_hours)}
          computedVal={fmtHrs(entry.hours_worked)}
          adjIsSet={entry.adj_hours_worked != null}
          adjState={adjHours}
          setAdj={setAdjHours}
          step="0.25"
        />
      </td>
      <td className="py-2 px-3 text-body text-sm text-right">
        {fmt(entry.base_pay_cents)}
      </td>
      <td className="py-2 px-3 text-sm text-right">
        <ValueCell
          {...vcProps}
          effectiveVal={fmt(entry.effective_paycheck_tips_cents)}
          computedVal={fmt(entry.paycheck_tips_cents)}
          adjIsSet={entry.adj_paycheck_tips_cents != null}
          adjState={adjPaycheckTips}
          setAdj={setAdjPaycheckTips}
        />
      </td>
      <td className="py-2 px-3 text-sm text-right">
        {cashView === "actual" ? (
          <ValueCell
            {...vcProps}
            effectiveVal={fmt(entry.effective_cash_tips_cents)}
            computedVal={fmt(entry.cash_tips_cents)}
            adjIsSet={entry.adj_cash_tips_cents != null}
            adjState={adjCashTips}
            setAdj={setAdjCashTips}
          />
        ) : (
          <ValueCell
            {...vcProps}
            effectiveVal={fmt(entry.effective_reported_cash_tips_cents)}
            computedVal={fmt(entry.reported_cash_tips_cents)}
            adjIsSet={entry.adj_reported_cash_tips_cents != null}
            adjState={adjReportedCashTips}
            setAdj={setAdjReportedCashTips}
          />
        )}
      </td>
      <td className="py-2 px-3 text-sm text-right">
        <ValueCell
          {...vcProps}
          effectiveVal={fmt(entry.effective_bonus_cents)}
          computedVal={fmt(entry.bonus_cents)}
          adjIsSet={entry.adj_bonus_cents != null}
          adjState={adjBonus}
          setAdj={setAdjBonus}
        />
      </td>
      <td className="py-2 px-3 text-accent text-sm text-right font-medium">
        {fmt(rowTotal)}
      </td>
      <td className="py-2 px-3 text-secondary text-sm text-right">
        {entry.effective_hours > 0
          ? `${fmtUsd(rowTotal / entry.effective_hours / 100)}/hr`
          : "—"}
      </td>
      {editable && overrideMode && (
        <td className="py-2 px-3">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={adjNotes}
              onChange={e => setAdjNotes(e.target.value)}
              placeholder="Notes…"
              className="inp-sm flex-1"
            />
            <button
              onClick={save}
              disabled={saving}
              className="text-xs text-secondary hover:text-strong disabled:opacity-40 px-2 whitespace-nowrap"
            >
              {saving ? "…" : "Save"}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
