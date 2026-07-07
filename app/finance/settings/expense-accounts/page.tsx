"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoaJoin { account_name: string; account_number: string | null; account_type: string }

interface RuleRow {
  id: string;
  source: string;
  external_account_id: string;
  external_account_name: string;
  external_account_code: string | null;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  chart_of_accounts: CoaJoin | null;
}

// Expense source accounts (e.g. Ramp GL accounts) → Chart of Accounts. Setting a
// rule here codes every expense on that account (except manually-pinned ones),
// and the Expenses tab's "Auto-map all" re-applies these rules on demand.
export default function ExpenseAccountsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rules, setRules]       = useState<RuleRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, ruleRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/expense-mappings"),
      ]);
      const [coa, rl] = await Promise.all([coaRes.json(), ruleRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRules(Array.isArray(rl) ? rl : []);
    } catch {
      setError("Failed to load expense accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSetRule(rule: RuleRow, coaId: string | null) {
    const res = await fetch("/api/finance/expense-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: rule.source, external_account_id: rule.external_account_id, chart_of_accounts_id: coaId }),
    });
    if (!res.ok) return;
    const coa = accounts.find((a) => a.id === coaId);
    const join = coa ? { account_name: coa.account_name, account_number: coa.account_number, account_type: coa.account_type } : null;
    setRules((rs) => rs.map((r) => r.id === rule.id
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: join }
      : r));
  }

  const mappedCount = rules.filter((r) => r.chart_of_accounts_id).length;

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader
          title="Expense Accounts"
          description={rules.length > 0
            ? `${mappedCount} of ${rules.length} source accounts mapped to the chart of accounts`
            : "Source accounts appear here after importing expenses on the Transactions → Expenses tab."}
        />
      </div>
      <SettingsNav />

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
      ) : rules.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No expense source accounts yet.</p>
            <p className="text-xs text-faint mt-1">Sync Ramp on the Transactions → Expenses tab to import them.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Source account</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Chart of Accounts</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-body truncate">{rule.external_account_name}</span>
                        {rule.external_account_code && (
                          <span className="text-[10px] text-faint font-mono shrink-0">{rule.external_account_code}</span>
                        )}
                        {rule.auto_matched && rule.chart_of_accounts_id && (
                          <span className="text-[10px] text-info shrink-0" title="Auto-matched from the source account name">auto</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <AccountSelect
                        value={rule.chart_of_accounts_id}
                        onChange={(id) => handleSetRule(rule, id)}
                        accounts={accounts}
                        placeholder="— map this account —"
                        shortLabel
                        className="w-full max-w-[360px]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="py-3 text-[10px] text-faint">
            Mapping a source account here codes every expense on it (except manually-pinned rows).
            Use <span className="text-body">Auto-map all</span> on the Expenses tab to re-apply these rules to unmapped expenses.
          </p>
        </div>
      )}
    </div>
  );
}
