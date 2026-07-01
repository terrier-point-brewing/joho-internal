import type { PayrollEntryMerged, Employee } from "@/lib/payroll/types";
import { fmtCents } from "@/lib/utils/formatting";

interface Props {
  entries: PayrollEntryMerged[];
  employees: Employee[];
  salariedEmployees: Employee[];
}

export function GustoSummaryPanel({ entries, employees, salariedEmployees }: Props) {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return (
    <div>
      <p className="text-xs text-muted mb-4">
        Copy these values into Gusto when running payroll. Hourly staff are listed with the
        figures to enter; salaried employees are included below as a reminder to run them —
        they require no manual entry.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="text-left py-2 px-3 text-muted font-medium">Employee</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Hours</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Paycheck Tips</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Cash Tips</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Bonus</th>
            <th className="text-right py-2 px-3 text-muted font-medium">Commissions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const emp = empMap.get(entry.employee_id);
            return (
              <tr key={entry.employee_id} className="border-b border-line">
                <td className="py-2 px-3 text-strong">
                  {emp ? `${emp.first_name} ${emp.last_name}` : entry.employee_id}
                </td>
                <td className="py-2 px-3 text-right text-body">
                  {entry.effective_hours.toFixed(2)}
                </td>
                <td className="py-2 px-3 text-right text-body">
                  {fmtCents(entry.effective_paycheck_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-body">
                  {fmtCents(entry.effective_cash_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-body">
                  {fmtCents(entry.effective_bonus_cents)}
                </td>
                <td className="py-2 px-3 text-right text-secondary">$0.00</td>
              </tr>
            );
          })}
          {salariedEmployees.map((emp) => (
            <tr key={emp.id} className="border-b border-line opacity-50">
              <td className="py-2 px-3 text-secondary">
                {emp.first_name} {emp.last_name}{" "}
                <span className="text-faint text-xs">({emp.job_title})</span>
              </td>
              <td colSpan={5} className="py-2 px-3 text-center text-faint text-xs">
                Salaried — no entry required
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
