"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fmtCents } from "@/lib/utils/formatting";
import type { Employee, PayrollEntryMerged } from "@/lib/payroll/types";
import Badge from "@/app/components/ui/Badge";

interface DayOverrideCell {
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}

interface ShiftRow {
  employee_id: string;
  name: string;
  overrides: Record<string, DayOverrideCell>;
  source_hours: Record<string, number>;
  source_tips_cents: Record<string, number> | null;
  source_cash_tips_cents: Record<string, number> | null;
}

interface ShiftData {
  rows: ShiftRow[];
}

/** One changed field. Period-level rows have no `date`. */
interface AdjustmentRow {
  employee: string;
  date: string | null;
  field: string;
  was: string;
  now: string;
  delta: number;
  note: string | null;
}

const fmtHrs = (h: number) => `${h.toFixed(2)}h`;

export function AdjustmentsPanel({
  periodId,
  entries,
  employees,
}: {
  periodId: string;
  entries: PayrollEntryMerged[];
  employees: Employee[];
}) {
  // Reuses the read-only Shifts query — same key, so TanStack serves it from
  // cache when that tab has already loaded. This panel adds no Square traffic.
  const { data, isLoading, error } = useQuery<ShiftData>({
    queryKey: queryKeys.payroll.shifts(periodId, false),
    queryFn: () =>
      fetch(`/api/payroll/periods/${periodId}/shifts`).then(async r => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error((d as { error?: string }).error ?? "Failed to load adjustments");
        }
        return r.json();
      }),
    staleTime: 60_000,
  });

  if (isLoading) return <p className="text-muted text-sm py-6">Loading adjustments…</p>;
  if (error) return <p className="text-danger text-sm py-6">{(error as Error).message}</p>;

  const nameById = new Map(employees.map(e => [e.id, `${e.first_name} ${e.last_name}`]));
  const rows: AdjustmentRow[] = [];

  // ── Period-level overrides (payroll_entries.adj_*) ────────────────────────
  for (const e of entries) {
    const who = nameById.get(e.employee_id) ?? e.employee_id;
    const push = (
      field: string, adj: number | null, computed: number,
      fmt: (n: number) => string,
    ) => {
      if (adj == null) return;
      rows.push({
        employee: who, date: null, field,
        was: fmt(computed), now: fmt(adj), delta: adj - computed,
        note: e.admin_notes,
      });
    };
    push("Hours", e.adj_hours_worked, e.hours_worked, fmtHrs);
    push("Card tips", e.adj_paycheck_tips_cents, e.paycheck_tips_cents, fmtCents);
    push("Cash tips", e.adj_cash_tips_cents, e.cash_tips_cents, fmtCents);
    push("Reported cash tips", e.adj_reported_cash_tips_cents, e.reported_cash_tips_cents, fmtCents);
    push("Bonus", e.adj_bonus_cents, e.bonus_cents, fmtCents);
  }

  // ── Per-day overrides (payroll_shift_overrides) ───────────────────────────
  for (const row of data?.rows ?? []) {
    for (const [date, ov] of Object.entries(row.overrides ?? {})) {
      const push = (
        field: string, adj: number | null, computed: number,
        fmt: (n: number) => string,
      ) => {
        if (adj == null) return;
        rows.push({
          employee: row.name, date, field,
          was: fmt(computed), now: fmt(adj), delta: adj - computed,
          note: ov.note,
        });
      };
      push("Hours", ov.adj_hours, row.source_hours[date] ?? 0, fmtHrs);
      push("Card tips", ov.adj_paycheck_tips_cents, row.source_tips_cents?.[date] ?? 0, fmtCents);
      push("Cash tips", ov.adj_cash_tips_cents, row.source_cash_tips_cents?.[date] ?? 0, fmtCents);
    }
  }

  rows.sort((a, b) =>
    a.employee.localeCompare(b.employee) ||
    (a.date ?? "").localeCompare(b.date ?? "") ||
    a.field.localeCompare(b.field),
  );

  if (rows.length === 0) {
    return (
      <p className="text-faint text-sm py-6">
        No adjustments have been made to this pay period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <p className="text-xs text-muted mb-4">
        Every manual change to this period. <span className="text-secondary">Period</span> rows
        replace an employee&apos;s whole-period total and take precedence over the day rows
        beneath them; <span className="text-secondary">day</span> rows correct a single shift.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="text-left py-2 px-3 text-muted font-medium">Employee</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Scope</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Field</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Was</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Now</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.employee}|${r.date ?? "period"}|${r.field}|${i}`} className="border-b border-line">
              <td className="py-2 px-3 text-strong whitespace-nowrap">{r.employee}</td>
              <td className="py-2 px-3">
                {r.date
                  ? <span className="text-secondary font-mono text-xs">{r.date}</span>
                  : <Badge tone="accent">Period</Badge>}
              </td>
              <td className="py-2 px-3 text-body">{r.field}</td>
              <td className="py-2 px-3 text-right text-faint font-mono line-through">{r.was}</td>
              <td className="py-2 px-3 text-right text-accent font-mono">{r.now}</td>
              <td className="py-2 px-3 text-secondary text-xs">{r.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-disabled text-xs mt-4">
        {rows.length} adjustment{rows.length === 1 ? "" : "s"} across this period
      </p>
    </div>
  );
}
