"use client";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import SaveHint from "@/app/components/ui/SaveHint";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoaJoin { account_name: string; account_number: string | null }

type CounterpartyRouting = "single_account" | "payroll_split";

interface RuleRow {
  id: string;
  counterparty_key: string;
  counterparty_label: string;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  chart_of_accounts: CoaJoin | null;
  routing: CounterpartyRouting;
}

// Counterparty rules (uncoded bank-line senders/payees, e.g. Gusto, Erie) → Chart of
// Accounts. Rows are seeded automatically the first time a bank line from that
// counterparty is synced; this page just assigns each one an account.
export default function CounterpartyAccountsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rules, setRules]       = useState<RuleRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, ruleRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/expense-counterparty-mappings"),
      ]);
      const [coa, rl] = await Promise.all([coaRes.json(), ruleRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRules(Array.isArray(rl) ? rl : []);
    } catch {
      setError("Failed to load counterparty accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSetRule(rule: RuleRow, coaId: string | null) {
    setSavingId(rule.id);
    const res = await fetch("/api/finance/expense-counterparty-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, chart_of_accounts_id: coaId }),
    });
    setSavingId(null);
    if (!res.ok) return;
    const coa = accounts.find((a) => a.id === coaId);
    const join = coa ? { account_name: coa.account_name, account_number: coa.account_number } : null;
    setRules((rs) => rs.map((r) => r.id === rule.id
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: join }
      : r));
  }

  // Routing controls whether this counterparty auto-maps to a single account
  // (default) or is routed to payroll period matching (Finance > Payroll)
  // instead -- see lib/finance/expenses.ts's resolveExpenseMapping.
  async function handleSetRouting(rule: RuleRow, routing: CounterpartyRouting) {
    setSavingId(rule.id);
    const res = await fetch("/api/finance/expense-counterparty-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, routing }),
    });
    setSavingId(null);
    if (!res.ok) return;
    setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, routing } : r)));
  }

  const mappedCount = rules.filter((r) => r.chart_of_accounts_id).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {rules.length > 0
            ? `${mappedCount} of ${rules.length} counterparties mapped to the chart of accounts`
            : "Counterparties appear here after syncing bank-account lines on the Transactions → Bank Ledger tab."}
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
      ) : rules.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No counterparties yet.</p>
            <p className="text-xs text-faint mt-1">Sync Ramp on the Transactions → Bank Ledger tab to import them.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Counterparty</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Routing</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Chart of Accounts</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-body truncate">{rule.counterparty_label}</span>
                        {rule.auto_matched && rule.chart_of_accounts_id && (
                          <span className="text-2xs text-info shrink-0" title="Auto-matched from the counterparty name">auto</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className="inp-sm"
                        value={rule.routing}
                        onChange={(e) => handleSetRouting(rule, e.target.value as CounterpartyRouting)}
                      >
                        <option value="single_account">Single account</option>
                        <option value="payroll_split">Payroll split</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      {rule.routing === "payroll_split" ? (
                        <div className="flex items-center gap-2">
                          <Badge tone="accent">Split by GL account — matched per pay period</Badge>
                          <a href="/settings/payroll/departments" className="text-2xs text-accent hover:underline shrink-0">
                            Manage →
                          </a>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <AccountSelect
                            value={rule.chart_of_accounts_id}
                            onChange={(id) => handleSetRule(rule, id)}
                            accounts={accounts}
                            placeholder="— map this counterparty —"
                            shortLabel
                            className="w-full max-w-[360px]"
                          />
                          <SaveHint saving={savingId === rule.id} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="py-3 text-2xs text-faint">
            Mapping a counterparty here codes every uncoded bank-line expense from it (e.g. Gusto payroll,
            Erie insurance). Rows are seeded automatically the first time that counterparty appears in a sync.
          </p>
        </div>
      )}
    </>
  );
}
