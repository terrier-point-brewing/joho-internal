"use client";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import YearSelect from "../components/YearSelect";
import SyncPanel from "../components/SyncPanel";
import { fmtCents } from "../../statements/lib";

// ── Types (mirror the API responses) ──────────────────────────────────────────
interface CoaJoin {
  account_name: string;
  account_number: string | null;
  account_type: string;
}

interface ExpenseRow {
  id: string;
  source: string;
  source_transaction_id: string;
  amount_cents: number;
  currency_code: string;
  memo: string | null;
  merchant_name: string | null;
  merchant_category: string | null;
  sk_category_name: string | null;
  state: string | null;
  card_holder_name: string | null;
  department_name: string | null;
  transaction_time: string | null;
  accounting_date: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  external_account_code: string | null;
  chart_of_accounts_id: string | null;
  mapping_source: "unmapped" | "rule" | "manual";
  chart_of_accounts: CoaJoin | null;
}

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

interface SyncResult {
  imported: number;
  mapped: number;
  unmapped: number;
  new_rules: number;
  auto_matched_rules: number;
}

const UNTAGGED = "__untagged__";
const groupKey = (source: string, accountId: string | null) => `${source}::${accountId ?? UNTAGGED}`;

interface AccountGroup {
  key: string;
  source: string;
  account_id: string | null;    // null = expenses with no external account
  account_name: string;
  account_code: string | null;
  rule: RuleRow | null;
  expenses: ExpenseRow[];
  total_cents: number;
  mapped_count: number;
}

export default function ExpensesPage() {
  const currentYear = new Date().getFullYear();

  const [year, setYear] = useState(currentYear);
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [rules, setRules]       = useState<RuleRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const loadAll = useCallback(async (y: number) => {
    setLoading(true); setError(null);
    try {
      const from = `${y}-01-01`;
      const to   = `${y}-12-31`;
      const [coaRes, expRes, ruleRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/expenses?from=${from}&to=${to}`),
        fetch("/api/finance/expense-mappings"),
      ]);
      const [coa, exp, rl] = await Promise.all([coaRes.json(), expRes.json(), ruleRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setExpenses(Array.isArray(exp) ? exp : []);
      setRules(Array.isArray(rl) ? rl : []);
    } catch {
      setError("Failed to load expenses.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(year); }, [loadAll, year]);

  const acctById = (id: string | null): CoaJoin | null => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? { account_name: a.account_name, account_number: a.account_number, account_type: a.account_type } : null;
  };

  // Set (or clear) the reusable account rule; cascade to non-manual expenses locally.
  async function handleSetRule(source: string, accountId: string, coaId: string | null) {
    const res = await fetch("/api/finance/expense-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, external_account_id: accountId, chart_of_accounts_id: coaId }),
    });
    if (!res.ok) return;
    const coa = acctById(coaId);
    setRules((rs) => rs.map((r) => r.source === source && r.external_account_id === accountId
      ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: coa }
      : r));
    setExpenses((es) => es.map((e) => {
      if (e.source !== source || e.external_account_id !== accountId || e.mapping_source === "manual") return e;
      return { ...e, chart_of_accounts_id: coaId, mapping_source: coaId ? "rule" : "unmapped", chart_of_accounts: coa };
    }));
  }

  // Pin (or clear) a single expense's account override.
  async function handleSetExpense(id: string, coaId: string | null) {
    const res = await fetch("/api/finance/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, chart_of_accounts_id: coaId }),
    });
    if (!res.ok) return;
    const updated = await res.json() as { chart_of_accounts_id: string | null; mapping_source: ExpenseRow["mapping_source"] };
    setExpenses((es) => es.map((e) => e.id === id
      ? { ...e, chart_of_accounts_id: updated.chart_of_accounts_id, mapping_source: updated.mapping_source, chart_of_accounts: acctById(updated.chart_of_accounts_id) }
      : e));
  }

  // ── Group expenses by (source, external account) ────────────────────────────
  const ruleByKey = new Map(rules.map((r) => [groupKey(r.source, r.external_account_id), r]));
  const groupMap = new Map<string, AccountGroup>();
  for (const e of expenses) {
    const key = groupKey(e.source, e.external_account_id);
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        source: e.source,
        account_id: e.external_account_id,
        account_name: e.external_account_name ?? (e.external_account_id ? "Unknown" : "Untagged (no account)"),
        account_code: e.external_account_code,
        rule: e.external_account_id ? (ruleByKey.get(key) ?? null) : null,
        expenses: [],
        total_cents: 0,
        mapped_count: 0,
      });
    }
    const g = groupMap.get(key)!;
    g.expenses.push(e);
    g.total_cents += e.amount_cents;
    if (e.chart_of_accounts_id) g.mapped_count += 1;
  }
  const groups = [...groupMap.values()].sort((a, b) => b.total_cents - a.total_cents);

  const totalCount   = expenses.length;
  const mappedCount  = expenses.filter((e) => e.chart_of_accounts_id).length;
  const totalSpend   = expenses.reduce((s, e) => s + e.amount_cents, 0);

  function toggleGroup(key: string) {
    setExpandedGroups((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-muted">
          {totalCount > 0
            ? `${mappedCount} of ${totalCount} expenses mapped · ${fmtCents(totalSpend)} total spend`
            : "Sync to import expenses and map them to the chart of accounts."}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <YearSelect year={year} onChange={setYear} />
          <SyncPanel<SyncResult>
            year={year}
            storageKey="tpb-expenses-last-sync"
            label="Ramp"
            buildEndpoint={({ year }) => `/api/finance/expenses/sync?from=${year}-01-01&to=${year}-12-31`}
            onSynced={() => loadAll(year)}
            renderResult={(r) => (
              <span title={`${r.imported} imported · ${r.mapped} mapped · ${r.new_rules} new accounts (${r.auto_matched_rules} auto-matched)`}>
                <span className="text-success mr-1">{r.imported} imported</span>
                <span className="text-secondary mr-1">{r.mapped} mapped</span>
                {r.new_rules > 0 && <span className="text-secondary">{r.new_rules} new accounts</span>}
              </span>
            )}
          />
        </div>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">Upload a chart of accounts first.</p>
            <p className="text-xs text-faint mt-1">Go to Settings → Chart of Accounts.</p>
          </div>
        </div>
      ) : expenses.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No expenses for {year}.</p>
            <p className="text-xs text-faint mt-1">Click &ldquo;Sync Ramp&rdquo; to import transactions.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto pb-8">
          {/* Column header */}
          <div className="flex items-center gap-3 px-4 sm:px-6 py-1.5 bg-surface/60 border-y border-line/60 sticky top-0 z-10">
            <span className="text-[10px] text-faint uppercase tracking-wider flex-1">Source account → Chart of Accounts</span>
            <span className="text-[10px] text-faint uppercase tracking-wider w-24 text-right">Spend</span>
            <span className="text-[10px] text-faint uppercase tracking-wider w-16 text-right">Count</span>
          </div>

          <div className="divide-y divide-line/40">
            {groups.map((g) => {
              const isOpen = expandedGroups.has(g.key);
              const allMapped = g.mapped_count === g.expenses.length;
              return (
                <div key={g.key}>
                  {/* Account group row */}
                  <div className="px-4 sm:px-6 py-2.5 bg-surface/30">
                    <div className="flex items-center gap-3 min-w-0">
                      <button onClick={() => toggleGroup(g.key)} className="flex items-center gap-2 shrink-0 min-w-0 max-w-[42%] text-left">
                        <span className="text-muted text-xs w-3 shrink-0">{isOpen ? "▾" : "▸"}</span>
                        <span className="text-sm font-medium text-strong truncate">{g.account_name}</span>
                        {g.account_code && <span className="text-[10px] text-faint font-mono shrink-0">{g.account_code}</span>}
                        {allMapped
                          ? <span className="text-[10px] text-success shrink-0">✓</span>
                          : <span className="text-[10px] text-accent-emphasis shrink-0">{g.mapped_count}/{g.expenses.length}</span>}
                        {g.rule?.auto_matched && g.rule?.chart_of_accounts_id && (
                          <span className="text-[10px] text-info shrink-0" title="Auto-matched from the source account">auto</span>
                        )}
                      </button>

                      {/* Rule selector — maps every expense on this account */}
                      <div className="flex-1 min-w-0 flex items-center">
                        {g.account_id === null ? (
                          <span className="text-[10px] text-faint italic">No source account — map expenses individually below</span>
                        ) : (
                          <AccountSelect
                            value={g.rule?.chart_of_accounts_id ?? null}
                            onChange={(id) => handleSetRule(g.source, g.account_id!, id)}
                            accounts={accounts}
                            placeholder="— map this account —"
                            shortLabel
                            className="w-full max-w-[360px]"
                          />
                        )}
                      </div>

                      <span className="text-xs text-body tabular-nums w-24 text-right shrink-0">{fmtCents(g.total_cents)}</span>
                      <span className="text-[10px] text-faint tabular-nums w-16 text-right shrink-0">{g.expenses.length}</span>
                    </div>
                  </div>

                  {/* Individual expenses */}
                  {isOpen && (
                    <>
                      <div className="flex items-center gap-3 pl-10 pr-4 sm:pr-6 py-1 bg-canvas/60 border-t border-line/30">
                        <span className="text-[10px] text-faint uppercase tracking-wider w-20 shrink-0">Date</span>
                        <span className="text-[10px] text-faint uppercase tracking-wider flex-1">Merchant · Memo</span>
                        <span className="text-[10px] text-faint uppercase tracking-wider w-[280px]">Override account</span>
                        <span className="text-[10px] text-faint uppercase tracking-wider w-24 text-right">Amount</span>
                      </div>
                      {g.expenses.map((e) => (
                        <div key={e.id} className="flex items-center gap-3 pl-10 pr-4 sm:pr-6 py-2 border-t border-line/20 hover:bg-surface/20">
                          <span className="text-[11px] text-muted tabular-nums w-20 shrink-0">{e.accounting_date ?? "—"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-body truncate">
                              {e.merchant_name ?? "—"}
                              {e.state && e.state !== "CLEARED" && (
                                <span className="ml-1.5 text-[10px] text-accent-border">{e.state.toLowerCase()}</span>
                              )}
                            </div>
                            <div className="text-[10px] text-faint truncate">
                              {[e.memo, e.card_holder_name, e.department_name].filter(Boolean).join(" · ") || "—"}
                            </div>
                          </div>
                          <div className="w-[280px] shrink-0 flex items-center gap-1.5">
                            <AccountSelect
                              value={e.chart_of_accounts_id}
                              onChange={(id) => handleSetExpense(e.id, id)}
                              accounts={accounts}
                              placeholder={e.mapping_source === "unmapped" ? "— unmapped —" : "— follow account rule —"}
                              shortLabel
                              className="w-full"
                            />
                            {e.mapping_source === "manual" && (
                              <span className="text-[9px] text-info shrink-0" title="Manually pinned — sync won't change it">pin</span>
                            )}
                          </div>
                          <span className={`text-xs tabular-nums w-24 text-right shrink-0 ${e.amount_cents < 0 ? "text-success" : "text-body"}`}>
                            {fmtCents(e.amount_cents)}
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <p className="px-4 sm:px-6 py-3 text-[10px] text-faint">
            Expenses are coded to the chart of accounts by their source account (e.g. the Ramp GL account).
            Set an account&rsquo;s mapping once and every expense on it follows — override individual expenses
            inline (they show <span className="text-info">pin</span> and are left untouched by re-syncs).
            Mapped totals are aggregated into the P&amp;L, Balance Sheet, and Cash Flow statements.
          </p>
        </div>
      )}
    </>
  );
}
