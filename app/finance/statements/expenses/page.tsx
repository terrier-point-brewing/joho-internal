"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import { fmtCents } from "../lib";

// ── Types (mirror the API responses) ──────────────────────────────────────────
interface CoaJoin {
  account_name: string;
  account_number: string | null;
  account_type: string;
}

interface ExpenseRow {
  id: string;
  ramp_transaction_id: string;
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
  ramp_gl_id: string | null;
  ramp_gl_name: string | null;
  ramp_gl_code: string | null;
  chart_of_accounts_id: string | null;
  mapping_source: "unmapped" | "rule" | "manual";
  chart_of_accounts: CoaJoin | null;
}

interface RuleRow {
  id: string;
  ramp_gl_id: string;
  ramp_gl_name: string;
  ramp_gl_code: string | null;
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

interface GlGroup {
  gl_id: string;              // UNTAGGED for expenses with no GL account
  gl_name: string;
  gl_code: string | null;
  rule: RuleRow | null;
  expenses: ExpenseRow[];
  total_cents: number;
  mapped_count: number;
}

export default function ExpensesPage() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const [year, setYear] = useState(currentYear);
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [rules, setRules]       = useState<RuleRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [syncing, setSyncing]   = useState(false);
  const [syncMsg, setSyncMsg]   = useState<string | null>(null);
  const [expandedGl, setExpandedGl] = useState<Set<string>>(new Set());

  const loadAll = useCallback(async (y: number) => {
    setLoading(true); setError(null);
    try {
      const from = `${y}-01-01`;
      const to   = `${y}-12-31`;
      const [coaRes, expRes, ruleRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/ramp/expenses?from=${from}&to=${to}`),
        fetch("/api/finance/ramp/expense-mappings"),
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

  async function handleSync() {
    setSyncing(true); setSyncMsg(null); setError(null);
    try {
      const from = `${year}-01-01`;
      const to   = `${year}-12-31`;
      const res = await fetch(`/api/finance/ramp/expenses/sync?from=${from}&to=${to}`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Sync failed");
        return;
      }
      const r: SyncResult = await res.json();
      setSyncMsg(`${r.imported} imported · ${r.mapped} mapped · ${r.new_rules} new GL accounts (${r.auto_matched_rules} auto-matched)`);
      await loadAll(year);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const acctById = (id: string | null): CoaJoin | null => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? { account_name: a.account_name, account_number: a.account_number, account_type: a.account_type } : null;
  };

  // Set (or clear) the reusable GL→CoA rule; cascade to non-manual expenses locally.
  async function handleSetRule(glId: string, coaId: string | null) {
    const res = await fetch("/api/finance/ramp/expense-mappings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ramp_gl_id: glId, chart_of_accounts_id: coaId }),
    });
    if (!res.ok) return;
    const coa = acctById(coaId);
    setRules((rs) => rs.map((r) => r.ramp_gl_id === glId ? { ...r, chart_of_accounts_id: coaId, auto_matched: false, chart_of_accounts: coa } : r));
    setExpenses((es) => es.map((e) => {
      if (e.ramp_gl_id !== glId || e.mapping_source === "manual") return e;
      return { ...e, chart_of_accounts_id: coaId, mapping_source: coaId ? "rule" : "unmapped", chart_of_accounts: coa };
    }));
  }

  // Pin (or clear) a single expense's account override.
  async function handleSetExpense(txnId: string, coaId: string | null) {
    const res = await fetch("/api/finance/ramp/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ramp_transaction_id: txnId, chart_of_accounts_id: coaId }),
    });
    if (!res.ok) return;
    const updated = await res.json() as { chart_of_accounts_id: string | null; mapping_source: ExpenseRow["mapping_source"] };
    setExpenses((es) => es.map((e) => e.ramp_transaction_id === txnId
      ? { ...e, chart_of_accounts_id: updated.chart_of_accounts_id, mapping_source: updated.mapping_source, chart_of_accounts: acctById(updated.chart_of_accounts_id) }
      : e));
  }

  // ── Group expenses by GL account ────────────────────────────────────────────
  const ruleByGl = new Map(rules.map((r) => [r.ramp_gl_id, r]));
  const groupMap = new Map<string, GlGroup>();
  for (const e of expenses) {
    const key = e.ramp_gl_id ?? UNTAGGED;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        gl_id: key,
        gl_name: e.ramp_gl_name ?? (key === UNTAGGED ? "Untagged (no GL account)" : "Unknown"),
        gl_code: e.ramp_gl_code,
        rule: key === UNTAGGED ? null : (ruleByGl.get(key) ?? null),
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

  function toggleGl(key: string) {
    setExpandedGl((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      <div className="shrink-0 px-4 sm:px-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Expenses"
          description={totalCount > 0
            ? `${mappedCount} of ${totalCount} expenses mapped · ${fmtCents(totalSpend)} total spend`
            : "Sync to import Ramp expenses and map them to the chart of accounts."}
        />
        <div className="flex items-center gap-2 shrink-0 mt-4">
          {syncMsg && <span className="text-xs text-success max-w-[420px] truncate" title={syncMsg}>{syncMsg}</span>}
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="inp-sm w-auto"
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={handleSync} disabled={syncing} className="btn-ghost btn-sm">
            {syncing ? "Syncing…" : "Sync Ramp"}
          </button>
        </div>
      </div>
      <div className="px-4 sm:px-6 shrink-0">
        <StatementsNav />
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
            <span className="text-[10px] text-faint uppercase tracking-wider flex-1">GL account (Ramp) → Chart of Accounts</span>
            <span className="text-[10px] text-faint uppercase tracking-wider w-24 text-right">Spend</span>
            <span className="text-[10px] text-faint uppercase tracking-wider w-16 text-right">Count</span>
          </div>

          <div className="divide-y divide-line/40">
            {groups.map((g) => {
              const isOpen = expandedGl.has(g.gl_id);
              const allMapped = g.mapped_count === g.expenses.length;
              return (
                <div key={g.gl_id}>
                  {/* GL group row */}
                  <div className="px-4 sm:px-6 py-2.5 bg-surface/30">
                    <div className="flex items-center gap-3 min-w-0">
                      <button onClick={() => toggleGl(g.gl_id)} className="flex items-center gap-2 shrink-0 min-w-0 max-w-[42%] text-left">
                        <span className="text-muted text-xs w-3 shrink-0">{isOpen ? "▾" : "▸"}</span>
                        <span className="text-sm font-medium text-strong truncate">{g.gl_name}</span>
                        {g.gl_code && <span className="text-[10px] text-faint font-mono shrink-0">{g.gl_code}</span>}
                        {allMapped
                          ? <span className="text-[10px] text-success shrink-0">✓</span>
                          : <span className="text-[10px] text-accent-emphasis shrink-0">{g.mapped_count}/{g.expenses.length}</span>}
                        {g.rule?.auto_matched && g.rule?.chart_of_accounts_id && (
                          <span className="text-[10px] text-info shrink-0" title="Auto-matched from Ramp GL account">auto</span>
                        )}
                      </button>

                      {/* Rule selector — maps every expense on this GL account */}
                      <div className="flex-1 min-w-0 flex items-center">
                        {g.gl_id === UNTAGGED ? (
                          <span className="text-[10px] text-faint italic">No GL account — map expenses individually below</span>
                        ) : (
                          <AccountSelect
                            value={g.rule?.chart_of_accounts_id ?? null}
                            onChange={(id) => handleSetRule(g.gl_id, id)}
                            accounts={accounts}
                            placeholder="— map this GL account —"
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
                              onChange={(id) => handleSetExpense(e.ramp_transaction_id, id)}
                              accounts={accounts}
                              placeholder={e.mapping_source === "unmapped" ? "— unmapped —" : "— follow GL rule —"}
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
            Expenses are coded to the chart of accounts by their Ramp GL account. Set a GL account&rsquo;s
            mapping once and every expense on it follows — override individual expenses inline (they show
            <span className="text-info"> pin</span> and are left untouched by re-syncs). Mapped totals are
            aggregated into the P&amp;L, Balance Sheet, and Cash Flow statements.
          </p>
        </div>
      )}
    </div>
  );
}
