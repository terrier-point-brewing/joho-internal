"use client";

import { useState } from "react";
import type { Employee, PayrollEntryMerged } from "@/lib/payroll/types";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  entry: PayrollEntryMerged;
  employee: Employee | undefined;
  periodId: string;
  editable: boolean;
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function PayrollEntryRow({ entry, employee, periodId, editable }: Props) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [adjNotes, setAdjNotes] = useState(entry.admin_notes ?? "");
  const [adjBonus, setAdjBonus] = useState<string>(
    entry.adj_bonus_cents != null ? String(entry.adj_bonus_cents / 100) : ""
  );

  const name = employee
    ? `${employee.first_name} ${employee.last_name}`
    : entry.employee_id;

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { admin_notes: adjNotes || null };
    if (adjBonus !== "") body.adj_bonus_cents = Math.round(parseFloat(adjBonus) * 100);
    await fetch(`/api/payroll/periods/${periodId}/entries/${entry.employee_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.payroll.preview(periodId) });
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800">
      <td className="py-2 px-3 text-zinc-200 text-sm">{name}</td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {entry.effective_hours.toFixed(2)}h
      </td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {formatMoney(entry.effective_paycheck_tips_cents)}
      </td>
      <td className="py-2 px-3 text-zinc-300 text-sm text-right">
        {formatMoney(entry.effective_cash_tips_cents)}
      </td>
      <td className="py-2 px-3 text-sm text-right">
        {editable ? (
          <input
            type="number"
            step="0.01"
            min="0"
            value={adjBonus}
            placeholder={formatMoney(entry.bonus_cents)}
            onChange={(e) => setAdjBonus(e.target.value)}
            className="w-24 bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-zinc-200 text-right text-sm"
          />
        ) : (
          <span className="text-zinc-300">{formatMoney(entry.effective_bonus_cents)}</span>
        )}
      </td>
      <td className="py-2 px-3 text-amber-400 text-sm text-right font-medium">
        {formatMoney(entry.effective_total_compensation_cents)}
      </td>
      {editable && (
        <td className="py-2 px-3">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={adjNotes}
              onChange={(e) => setAdjNotes(e.target.value)}
              placeholder="Notes…"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 text-xs"
            />
            <button
              onClick={save}
              disabled={saving}
              className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 px-2"
            >
              {saving ? "…" : "Save"}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
