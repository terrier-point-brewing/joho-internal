"use client";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

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
        <StickyHeader>
          <PageHeader
            title="Departments"
            description="Maps each Gusto payroll journal department to a wage GL account, plus the single account that receives all employer payroll taxes. Used when a Gusto report is uploaded on a pay period."
          />
        </StickyHeader>
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
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 space-y-4">
          <Card padding="">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Department</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Chart of Accounts</th>
                  <th className="px-4 py-2 text-left text-muted font-medium w-16"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.departmentName} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-2 text-body">{row.departmentName}</td>
                    <td className="px-4 py-2">
                      <AccountSelect
                        value={row.chartOfAccountsId}
                        onChange={(id) => handleSetAccount(row.departmentName, id)}
                        accounts={accounts}
                        placeholder="— map this department —"
                        shortLabel
                        className="w-full max-w-[360px]"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" className="btn-danger btn-xxs" onClick={() => handleRemoveDepartment(row.departmentName)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line/40">
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      className="inp-sm w-full"
                      placeholder="New department name"
                      value={newDepartmentName}
                      onChange={(e) => setNewDepartmentName(e.target.value)}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <AccountSelect
                      value={newDepartmentAccountId}
                      onChange={setNewDepartmentAccountId}
                      accounts={accounts}
                      placeholder="— select an account —"
                      shortLabel
                      className="w-full max-w-[360px]"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="btn-primary btn-xxs"
                      disabled={!newDepartmentName.trim() || !newDepartmentAccountId}
                      onClick={handleAddDepartment}
                    >
                      Add
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold text-strong">Payroll taxes account</h3>
            <p className="text-xs text-muted mt-1 mb-2">
              Every department&apos;s employer taxes (Social Security, Medicare, FUTA, NC Unemployment) are summed into this one account.
            </p>
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
            <p className="text-xs text-muted mt-1 mb-2">
              Paycheck tips from Gusto uploads post here instead of to wage accounts. Tips never appear on the P&amp;L.
            </p>
            <AccountSelect
              value={tipsAccountId}
              onChange={setTipsAccountId}
              accounts={tipsAccounts}
              placeholder="— select the tips liability account —"
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
