"use client";
import ListTable from "@/app/components/ui/ListTable";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import SettingsHeader from "@/app/settings/SettingsHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DepartmentMappingRow {
  departmentName: string;
  chartOfAccountsId: string | null;
}

// Liability account types eligible for the tips pass-through account -- a
// tips liability is neither A/P nor a credit card.
const TIPS_ACCOUNT_TYPES = new Set(["Other Current Liabilities", "Long Term Liabilities"]);

// Gusto payroll journal departments (e.g. "Production", "Front of House") ->
// Chart of Accounts, plus the single payroll-taxes account that receives
// every department's summed employer tax, plus the tips liability account
// paycheck tips post to instead of a wage expense. Consumed by
// lib/payroll/gustoUpload.ts's uploadGustoReport when bucketing an uploaded
// Gusto CSV into GL totals for a pay period.
export default function PayrollDepartmentMappingsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<DepartmentMappingRow[]>([]);
  const [payrollTaxesAccountId, setPayrollTaxesAccountId] = useState<string | null>(null);
  const [tipsAccountId, setTipsAccountId] = useState<string | null>(null);
  const [taproomAccountId, setTaproomAccountId] = useState<string | null>(null);
  const [newDepartmentName, setNewDepartmentName] = useState("");
  const [newDepartmentAccountId, setNewDepartmentAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const tipsAccounts = accounts.filter((a) => TIPS_ACCOUNT_TYPES.has(a.account_type));

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, mapRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/settings/payroll-department-mappings"),
      ]);
      const coa = await coaRes.json();
      const map = await mapRes.json();
      setAccounts(Array.isArray(coa) ? coa : []);
      setRows(
        Array.isArray(map?.mappings)
          ? map.mappings.map((m: { department_name: string; chart_of_accounts_id: string }) => ({
              departmentName: m.department_name,
              chartOfAccountsId: m.chart_of_accounts_id,
            }))
          : [],
      );
      setPayrollTaxesAccountId(map?.payrollTaxesAccountId ?? null);
      setTipsAccountId(map?.tipsAccountId ?? null);
      setTaproomAccountId(map?.taproomAccountId ?? null);
    } catch {
      setError("Failed to load payroll department mappings.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  function handleAddDepartment() {
    const name = newDepartmentName.trim();
    if (!name || !newDepartmentAccountId) return;
    if (rows.some((r) => r.departmentName.toLowerCase() === name.toLowerCase())) {
      setError(`"${name}" is already mapped.`);
      return;
    }
    setRows((rs) => [...rs, { departmentName: name, chartOfAccountsId: newDepartmentAccountId }]);
    setNewDepartmentName("");
    setNewDepartmentAccountId(null);
    setError(null);
  }

  function handleRemoveDepartment(departmentName: string) {
    setRows((rs) => rs.filter((r) => r.departmentName !== departmentName));
  }

  function handleSetAccount(departmentName: string, chartOfAccountsId: string | null) {
    setRows((rs) => rs.map((r) => (r.departmentName === departmentName ? { ...r, chartOfAccountsId } : r)));
  }

  async function handleSave() {
    if (!payrollTaxesAccountId) {
      setError("Select a payroll taxes account before saving.");
      return;
    }
    if (!tipsAccountId) {
      setError("Select a tips liability account before saving.");
      return;
    }
    const incomplete = rows.filter((r) => !r.chartOfAccountsId);
    if (incomplete.length > 0) {
      setError(`Every department needs an account (missing: ${incomplete.map((r) => r.departmentName).join(", ")}).`);
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/finance/settings/payroll-department-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: rows.map((r) => ({ departmentName: r.departmentName, chartOfAccountsId: r.chartOfAccountsId })),
          payrollTaxesAccountId,
          tipsAccountId,
          taproomAccountId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Save failed.");
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6">
        <SettingsHeader
          title="Departments"
          description="Maps each Gusto payroll journal department to a wage GL account, plus the single account that receives all employer payroll taxes. Used when a Gusto report is uploaded on a pay period."
        />
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {saved && !error && <Banner tone="success" className="mx-4 sm:mx-6 my-2">Saved.</Banner>}

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">Upload a chart of accounts first.</p>
            <p className="text-xs text-faint mt-1">Go to Chart of Accounts → Upload CSV.</p>
          </div>
        </div>
      ) : (
        <div className="pane px-4 sm:px-6 py-4 space-y-4">
          <ListTable<(typeof rows)[number]>
            rows={rows}
            rowKey={(row) => row.departmentName}
            zebra={false}
            empty="No departments mapped yet."
            cols={[
              { key: "name", header: "Department", role: "label", className: "!font-normal text-body", cell: (row) => row.departmentName },
              {
                key: "account", header: "Chart of Accounts", foldBlock: true,
                cell: (row) => (
                  <AccountSelect
                    value={row.chartOfAccountsId}
                    onChange={(id) => handleSetAccount(row.departmentName, id)}
                    accounts={accounts}
                    placeholder="— map this department —"
                    shortLabel
                    className="max-sm:w-0 max-sm:min-w-full sm:w-full sm:max-w-[360px]"
                  />
                ),
              },
              {
                key: "remove", role: "action",
                cell: (row) => (
                  <button type="button" className="btn-danger" onClick={() => handleRemoveDepartment(row.departmentName)}>
                    Remove
                  </button>
                ),
              },
            ]}
          />

          <Card>
            <h3 className="text-sm font-semibold text-strong mb-2">Add a department</h3>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                className="inp-sm w-full sm:w-56"
                placeholder="New department name"
                aria-label="New department name"
                value={newDepartmentName}
                onChange={(e) => setNewDepartmentName(e.target.value)}
              />
              <AccountSelect
                value={newDepartmentAccountId}
                onChange={setNewDepartmentAccountId}
                accounts={accounts}
                placeholder="— select an account —"
                shortLabel
                className="w-full sm:max-w-[360px]"
              />
              <button
                type="button"
                className="btn-primary sm:ml-auto"
                disabled={!newDepartmentName.trim() || !newDepartmentAccountId}
                onClick={handleAddDepartment}
              >
                Add
              </button>
            </div>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-strong">Payroll taxes account</h3>
            <p className="text-xs text-muted mt-1 mb-2">All departments&apos; employer taxes, one account.</p>
            <AccountSelect
              value={payrollTaxesAccountId}
              onChange={setPayrollTaxesAccountId}
              accounts={accounts}
              placeholder="— select the payroll taxes account —"
              shortLabel
              className="w-full max-w-[360px]"
            />
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-strong">Tips liability account</h3>
            <p className="text-xs text-muted mt-1 mb-2">Paycheck tips post here, never to wages.</p>
            <AccountSelect
              value={tipsAccountId}
              onChange={setTipsAccountId}
              accounts={tipsAccounts}
              placeholder="— select the tips liability account —"
              shortLabel
              className="w-full max-w-[360px]"
            />
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-strong">Shift-tracked wages account</h3>
            <p className="text-xs text-muted mt-1 mb-2">The wage account checked against Square shifts. Unset skips the check.</p>
            <AccountSelect
              value={taproomAccountId}
              onChange={setTaproomAccountId}
              accounts={accounts}
              placeholder="— none, skip the taproom check —"
              shortLabel
              className="w-full max-w-[360px]"
            />
          </Card>

          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
