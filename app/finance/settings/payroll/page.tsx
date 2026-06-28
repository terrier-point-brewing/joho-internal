"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { queryKeys } from "@/lib/query-keys";
import type { Employee, PayrollConfig } from "@/lib/payroll/types";

type PayPeriodFrequency = "weekly" | "biweekly";
type JobTitle = "Bartender" | "Brewer" | "Taproom Manager";
type EmploymentType = "hourly" | "salary_no_overtime" | "salary_overtime_eligible";

function toDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export default function PayrollSettingsPage() {
  const qc = useQueryClient();

  const { data: config } = useQuery<PayrollConfig>({
    queryKey: queryKeys.payroll.config(),
    queryFn: () => fetch("/api/payroll/config").then(r => r.json()),
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: queryKeys.payroll.employees(),
    queryFn: () => fetch("/api/payroll/employees").then(r => r.json()),
  });

  // ── Pay Schedule state ────────────────────────────────────────────────────
  const [frequency, setFrequency] = useState<PayPeriodFrequency>("biweekly");
  const [firstStart, setFirstStart] = useState("");

  // ── Rate Configuration state ──────────────────────────────────────────────
  const [baseRate, setBaseRate] = useState("");
  const [guaranteedRate, setGuaranteedRate] = useState("");
  const [cashTipsRate, setCashTipsRate] = useState("");

  // ── Add-employee form state ───────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newTitle, setNewTitle] = useState<JobTitle>("Bartender");
  const [newEmpType, setNewEmpType] = useState<EmploymentType>("hourly");
  const [newTips, setNewTips] = useState(true);
  const [newSquareId, setNewSquareId] = useState("");
  const [newGustoId, setNewGustoId] = useState("");

  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setFrequency((config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency);
    setFirstStart(config.first_pay_period_start_date ?? "");
    setBaseRate(toDollars(config.base_rate_cents));
    setGuaranteedRate(toDollars(config.guaranteed_rate_cents));
    setCashTipsRate(String(config.cash_tips_rate));
  }, [config]);

  const buildConfigBody = (overrides?: Partial<{
    pay_period_frequency: PayPeriodFrequency;
    first_pay_period_start_date: string;
    base_rate_cents: number;
    guaranteed_rate_cents: number;
    cash_tips_rate: number;
  }>) => ({
    effective_from: new Date().toISOString().slice(0, 10),
    pay_period_frequency: overrides?.pay_period_frequency ?? frequency,
    first_pay_period_start_date: overrides?.first_pay_period_start_date ?? firstStart,
    base_rate_cents: overrides?.base_rate_cents ?? Math.round(parseFloat(baseRate) * 100),
    guaranteed_rate_cents: overrides?.guaranteed_rate_cents ?? Math.round(parseFloat(guaranteedRate) * 100),
    cash_tips_rate: overrides?.cash_tips_rate ?? parseFloat(cashTipsRate),
  });

  const saveSchedule = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildConfigBody({ pay_period_frequency: frequency, first_pay_period_start_date: firstStart })),
      }).then(r => r.json()),
    onSuccess: (data: { periodsCreated?: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.config() });
      qc.invalidateQueries({ queryKey: queryKeys.payroll.periods() });
      setScheduleMsg(`Saved. ${data.periodsCreated ?? 0} period(s) created.`);
      setTimeout(() => setScheduleMsg(null), 4000);
    },
  });

  const saveRates = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildConfigBody(), seed_periods: false }),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.config() }),
  });

  const addEmployee = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: newFirst,
          last_name: newLast,
          email: newEmail,
          phone_number: newPhone || null,
          job_title: newTitle,
          employment_type: newEmpType,
          receives_tips: newTips,
          square_team_member_id: newSquareId || null,
          gusto_employee_id: newGustoId || null,
        }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() });
      setShowAddForm(false);
      setNewFirst(""); setNewLast(""); setNewEmail(""); setNewPhone("");
      setNewTitle("Bartender"); setNewEmpType("hourly"); setNewTips(true);
      setNewSquareId(""); setNewGustoId("");
    },
  });

  const toggleEmployee = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetch(`/api/payroll/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() }),
  });

  const syncSquare = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/employees/sync-square", { method: "POST" }).then(r => r.json()),
    onSuccess: (data: { created: number; updated: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() });
      setSyncMsg(`${data.created} created, ${data.updated} updated.`);
      setTimeout(() => setSyncMsg(null), 4000);
    },
  });

  const inputCls = "mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm";
  const labelCls = "block text-zinc-500 text-xs";

  return (
    <main className="px-4 sm:px-6 py-8 max-w-3xl">
      <h2 className="text-zinc-100 font-semibold text-base mb-8">Payroll</h2>

      {/* ── Pay Schedule ─────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h3 className="text-zinc-300 font-medium text-sm mb-4">Pay Schedule</h3>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <label className="block">
            <span className={labelCls}>Pay Frequency</span>
            <select
              value={frequency}
              onChange={e => setFrequency(e.target.value as PayPeriodFrequency)}
              className={inputCls}
            >
              <option value="weekly">Weekly (7 days)</option>
              <option value="biweekly">Biweekly (14 days)</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>First Pay Period Start Date</span>
            <input
              type="date"
              value={firstStart}
              onChange={e => setFirstStart(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => saveSchedule.mutate()}
            disabled={saveSchedule.isPending}
            className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
          >
            {saveSchedule.isPending ? "Saving…" : "Save & Generate Periods"}
          </button>
          {scheduleMsg && <span className="text-xs text-green-400">{scheduleMsg}</span>}
        </div>
      </section>

      {/* ── Rate Configuration ────────────────────────────────────────────── */}
      <section className="mb-10">
        <h3 className="text-zinc-300 font-medium text-sm mb-4">Rate Configuration</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <label className="block">
            <span className={labelCls}>Base Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={baseRate}
              onChange={e => setBaseRate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Guaranteed Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={guaranteedRate}
              onChange={e => setGuaranteedRate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Cash Tips Rate (e.g. 0.01)</span>
            <input
              type="number" step="0.001" min="0" max="1"
              value={cashTipsRate}
              onChange={e => setCashTipsRate(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <button
          onClick={() => saveRates.mutate()}
          disabled={saveRates.isPending}
          className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
        >
          {saveRates.isPending ? "Saving…" : "Save Rates"}
        </button>

        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-400 space-y-2 font-mono">
          <p><span className="text-zinc-200">hour_share</span> = employee_hours / total_tipped_hours</p>
          <p><span className="text-zinc-200">paycheck_tips</span> = hour_share × total_pooled_tips <span className="text-zinc-600">(from Square)</span></p>
          <p><span className="text-zinc-200">cash_tips</span> = hour_share × <span className="text-amber-400">{cashTipsRate || "0.01"}</span> × total_cash_take</p>
          <p><span className="text-zinc-200">base_pay</span> = hours × <span className="text-amber-400">${baseRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">guaranteed_min</span> = hours × <span className="text-amber-400">${guaranteedRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">bonus</span> = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)</p>
        </div>
        <p className="text-xs text-zinc-600 mt-2">
          Tip model: <span className="text-zinc-400">Proportional Hours</span>
        </p>
      </section>

      {/* ── Employees ────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-zinc-300 font-medium text-sm">Employees</h3>
          <div className="flex items-center gap-2">
            {syncMsg && <span className="text-xs text-green-400">{syncMsg}</span>}
            <button
              onClick={() => syncSquare.mutate()}
              disabled={syncSquare.isPending}
              className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded disabled:opacity-40"
            >
              {syncSquare.isPending ? "Syncing…" : "Sync from Square"}
            </button>
            <button
              onClick={() => setShowAddForm(v => !v)}
              className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
            >
              {showAddForm ? "Cancel" : "+ Add Employee"}
            </button>
          </div>
        </div>

        {/* Add employee inline form */}
        {showAddForm && (
          <div className="mb-4 p-4 bg-zinc-900 border border-zinc-700 rounded-lg">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className={labelCls}>First Name *</span>
                <input value={newFirst} onChange={e => setNewFirst(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Last Name *</span>
                <input value={newLast} onChange={e => setNewLast(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Email *</span>
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Phone</span>
                <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Job Title *</span>
                <select value={newTitle} onChange={e => setNewTitle(e.target.value as JobTitle)} className={inputCls}>
                  <option>Bartender</option>
                  <option>Brewer</option>
                  <option>Taproom Manager</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Employment Type *</span>
                <select value={newEmpType} onChange={e => setNewEmpType(e.target.value as EmploymentType)} className={inputCls}>
                  <option value="hourly">Hourly</option>
                  <option value="salary_no_overtime">Salary (no OT)</option>
                  <option value="salary_overtime_eligible">Salary (OT eligible)</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Square Team Member ID</span>
                <input value={newSquareId} onChange={e => setNewSquareId(e.target.value)} className={inputCls} placeholder="optional" />
              </label>
              <label className="block">
                <span className={labelCls}>Gusto Employee ID</span>
                <input value={newGustoId} onChange={e => setNewGustoId(e.target.value)} className={inputCls} placeholder="optional" />
              </label>
            </div>
            <label className="flex items-center gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={newTips}
                onChange={e => setNewTips(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-zinc-400 text-sm">Receives tips</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => addEmployee.mutate()}
                disabled={addEmployee.isPending || !newFirst || !newLast || !newEmail}
                className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
              >
                {addEmployee.isPending ? "Adding…" : "Add Employee"}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="text-sm px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
              >
                Cancel
              </button>
            </div>
            {addEmployee.isError && (
              <p className="text-red-400 text-xs mt-2">{String(addEmployee.error)}</p>
            )}
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-zinc-500">Title</th>
              <th className="text-left py-2 px-3 text-zinc-500">Type</th>
              <th className="text-left py-2 px-3 text-zinc-500">Tips</th>
              <th className="text-left py-2 px-3 text-zinc-500">Square ID</th>
              <th className="py-2 px-3 text-zinc-500">Active</th>
            </tr>
          </thead>
          <tbody>
            {(employees ?? []).map(emp => (
              <tr key={emp.id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">{emp.first_name} {emp.last_name}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.job_title}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.employment_type.replace(/_/g, " ")}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.receives_tips ? "Yes" : "No"}</td>
                <td className="py-2 px-3 text-zinc-600 text-xs font-mono">
                  {emp.square_team_member_id?.slice(0, 12) ?? "—"}
                </td>
                <td className="py-2 px-3 text-center">
                  <button
                    onClick={() => toggleEmployee.mutate({ id: emp.id, active: !emp.active })}
                    className={`text-xs px-2 py-0.5 rounded ${
                      emp.active
                        ? "bg-green-900/30 text-green-400 hover:bg-red-900/30 hover:text-red-400"
                        : "bg-zinc-800 text-zinc-500 hover:bg-green-900/30 hover:text-green-400"
                    }`}
                  >
                    {emp.active ? "Active" : "Inactive"}
                  </button>
                </td>
              </tr>
            ))}
            {(employees ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-zinc-600">
                  No employees yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
