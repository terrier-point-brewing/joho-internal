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
}

const fmt = fmtCents;
const fmtHrs = (h: number) => `${h.toFixed(2)}h`;

const overrideInputCls =
  "w-20 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-200 text-right mt-0.5";

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
        <span className="text-zinc-500 text-xs">{effectiveVal}</span>
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
        <span className="text-amber-300">{effectiveVal}</span>
        <span className="text-zinc-600 text-xs line-through">{computedVal}</span>
      </div>
    );
  }
  return <span className="text-zinc-300">{effectiveVal}</span>;
}

export function PayrollEntryRow({ entry, employee, periodId, editable, overrideMode }: Props) {
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
        adj_bonus_cents: adjBonus !== "" ? Math.round(parseFloat(adjBonus) * 100) : null,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) });
    setSaving(false);
  }

  const vcProps = { editable, overrideMode };

  return (
    <tr className={`border-b border-zinc-800 ${entry.effective_hours === 0 ? "opacity-40" : ""}`}>
      <td className="py-2 px-3 text-zinc-200 text-sm">
        {name}
        {hasAnyOverride && !overrideMode && (
          <span className="ml-1.5 text-amber-500 text-xs" title="Has manual overrides">✦</span>
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
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
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
        <ValueCell
          {...vcProps}
          effectiveVal={fmt(entry.effective_cash_tips_cents)}
          computedVal={fmt(entry.cash_tips_cents)}
          adjIsSet={entry.adj_cash_tips_cents != null}
          adjState={adjCashTips}
          setAdj={setAdjCashTips}
        />
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
      <td className="py-2 px-3 text-amber-400 text-sm text-right font-medium">
        {fmt(entry.effective_total_compensation_cents)}
      </td>
      <td className="py-2 px-3 text-zinc-400 text-sm text-right">
        {entry.effective_hours > 0
          ? `${fmtUsd(entry.effective_total_compensation_cents / entry.effective_hours / 100)}/hr`
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
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 text-xs"
            />
            <button
              onClick={save}
              disabled={saving}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 px-2 whitespace-nowrap"
            >
              {saving ? "…" : "Save"}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
