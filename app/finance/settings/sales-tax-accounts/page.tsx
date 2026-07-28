"use client";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import SaveHint from "@/app/components/ui/SaveHint";

interface CoaJoin { account_name: string; account_number: string | null }

// Only these two chart-of-accounts types are balance-sheet liabilities.
// Sales tax is money held for NC DOR / Wake County, not revenue -- letting a
// user map it to any other account type (e.g. a REVENUE account) would post
// collected tax straight back into revenue, the exact bug this page exists
// to prevent.
const LIABILITY_ACCOUNT_TYPES = new Set(["Other Current Liabilities", "Long Term Liabilities"]);

interface TaxRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: CoaJoin | null;
}

// Square taxes → the balance-sheet liability account their collections are
// credited to. Sales tax is money held for NC DOR / Wake County, not revenue.
// Rows seed themselves the first time a tax is seen in a synced order.
export default function SalesTaxAccountsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [taxes, setTaxes]       = useState<TaxRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, taxRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/settings/sales-tax-accounts"),
      ]);
      const [coa, tx] = await Promise.all([coaRes.json(), taxRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setTaxes(Array.isArray(tx) ? tx : []);
    } catch {
      setError("Failed to load sales tax accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSet(row: TaxRow, coaId: string | null) {
    setSavingId(row.square_tax_id);
    const res = await fetch("/api/finance/settings/sales-tax-accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_tax_id: row.square_tax_id, chart_of_accounts_id: coaId }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that mapping."); return; }
    const coa = accounts.find((a) => a.id === coaId);
    const join = coa ? { account_name: coa.account_name, account_number: coa.account_number } : null;
    setTaxes((ts) => ts.map((t) => t.square_tax_id === row.square_tax_id
      ? { ...t, chart_of_accounts_id: coaId, chart_of_accounts: join }
      : t));
  }

  const mappedCount = taxes.filter((t) => t.chart_of_accounts_id).length;
  const liabilityAccounts = accounts.filter((a) => LIABILITY_ACCOUNT_TYPES.has(a.account_type));

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {taxes.length > 0
            ? `${mappedCount} of ${taxes.length} Square taxes mapped to a liability account`
            : "Taxes appear here after syncing orders that collected sales tax."}
        </p>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">Upload a chart of accounts first.</p>
            <p className="text-xs text-faint mt-1">Go to Chart of Accounts → Upload CSV.</p>
          </div>
        </div>
      ) : taxes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No Square taxes yet.</p>
            <p className="text-xs text-faint mt-1">Sync orders on the Transactions → Orders tab to import them.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Tax</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Rate</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Liability Account</th>
                </tr>
              </thead>
              <tbody>
                {taxes.map((row) => (
                  <tr key={row.square_tax_id} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-2">
                      <span className="text-body truncate">{row.tax_name ?? row.square_tax_id}</span>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {row.tax_pct != null ? `${row.tax_pct}%` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <AccountSelect
                          value={row.chart_of_accounts_id}
                          onChange={(id) => handleSet(row, id)}
                          accounts={liabilityAccounts}
                          placeholder="— map this tax —"
                          shortLabel
                          className="w-full max-w-[360px]"
                        />
                        <SaveHint saving={savingId === row.square_tax_id} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="py-3 text-2xs text-faint">
            Collected sales tax is credited to the account mapped here instead of being recognized as revenue.
            An unmapped tax contributes nothing to the balance sheet — its collections are simply omitted.
            Only balance-sheet liability accounts are selectable, so a tax can never be mapped back into revenue.
          </p>
        </div>
      )}
    </>
  );
}
