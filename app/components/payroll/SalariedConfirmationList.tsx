import type { Employee } from "@/lib/payroll/types";

export function SalariedConfirmationList({ employees }: { employees: Employee[] }) {
  if (employees.length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-strong mb-2">Salaried Employees</h3>
      <ul className="space-y-1">
        {employees.map((emp) => (
          <li key={emp.id} className="flex items-center gap-3 text-sm text-secondary">
            <span className="w-4 h-4 rounded border border-line-subtle flex-shrink-0" />
            <span>{emp.first_name} {emp.last_name}</span>
            <span className="text-faint">{emp.job_title} · {emp.employment_type.replace(/_/g, " ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
