import type { PayrollEntryMerged, Employee } from "@/lib/payroll/types";

interface Props {
  entries: PayrollEntryMerged[];
  employees: Employee[];
  salariedEmployees: Employee[];
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function GustoSummaryPanel({ entries, employees, salariedEmployees }: Props) {
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-zinc-300 mb-3">Gusto Summary</h3>
      <p className="text-xs text-zinc-500 mb-4">
        Copy these values into Gusto when running payroll. Salaried employees require no manual entry.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700">
            <th className="text-left py-2 px-3 text-zinc-500 font-medium">Employee</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Hours</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Paycheck Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Cash Tips</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Bonus</th>
            <th className="text-right py-2 px-3 text-zinc-500 font-medium">Commissions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const emp = empMap.get(entry.employee_id);
            return (
              <tr key={entry.employee_id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">
                  {emp ? `${emp.first_name} ${emp.last_name}` : entry.employee_id}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {entry.effective_hours.toFixed(2)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_paycheck_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_cash_tips_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-300">
                  {formatMoney(entry.effective_bonus_cents)}
                </td>
                <td className="py-2 px-3 text-right text-zinc-400">$0.00</td>
              </tr>
            );
          })}
          {salariedEmployees.map((emp) => (
            <tr key={emp.id} className="border-b border-zinc-800 opacity-50">
              <td className="py-2 px-3 text-zinc-400">
                {emp.first_name} {emp.last_name}{" "}
                <span className="text-zinc-600 text-xs">({emp.job_title})</span>
              </td>
              <td colSpan={5} className="py-2 px-3 text-center text-zinc-600 text-xs">
                Salaried — no entry required
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
