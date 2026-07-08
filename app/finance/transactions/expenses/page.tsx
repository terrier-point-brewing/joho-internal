"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import { EXPENSE_STATE_CLS } from "../../lib/categoryColors";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import YearSelect from "../components/YearSelect";
import SyncPanel from "../components/SyncPanel";
import SummaryStatBar from "../components/SummaryStatBar";
import MappingFilter from "../components/MappingFilter";
import MappingStatusPill from "../components/MappingStatusPill";
import AutoMapButton from "../components/AutoMapButton";
import { LedgerTable, SortableTh, Th, CategoryBadges, useTableSort } from "../components/LedgerTable";

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

interface SyncResult {
  imported: number;
  mapped: number;
  unmapped: number;
  new_rules: number;
  auto_matched_rules: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Expandable expense row ─────────────────────────────────────────────────────

function ExpenseRowView({
  e,
  accounts,
  onSetExpense,
}: {
  e: ExpenseRow;
  accounts: CoARef[];
  onSetExpense: (id: string, coaId: string | null) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const mapped = e.chart_of_accounts_id ? 1 : 0;
  const state = e.state?.toLowerCase() ?? "";
  const glName = e.chart_of_accounts?.account_name ?? null;

  async function handleChange(coaId: string | null) {
    setSaving(true);
    await onSetExpense(e.id, coaId);
    setSaving(false);
  }

  return (
    <>
      <tr className="border-t border-line/40 hover:bg-surface-mid/20 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <td className="px-4 py-2 w-6"><span className="text-faint text-[10px]">{expanded ? "▾" : "▸"}</span></td>
        <td className="px-4 py-2 text-secondary whitespace-nowrap">{fmtDate(e.accounting_date)}</td>
        <td className="px-4 py-2 text-body">
          <div className="truncate max-w-[240px]">{e.merchant_name ?? "—"}</div>
          {(e.memo || e.card_holder_name) && (
            <div className="text-[10px] text-faint truncate max-w-[240px]">
              {[e.memo, e.card_holder_name].filter(Boolean).join(" · ")}
            </div>
          )}
        </td>
        <td className="px-4 py-2"><CategoryBadges items={glName ? [glName] : []} /></td>
        <td className="px-4 py-2">
          {state && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${EXPENSE_STATE_CLS[state] ?? "bg-surface-mid text-muted"}`}>
              {state}
            </span>
          )}
        </td>
        <td className="px-4 py-2"><MappingStatusPill mapped={mapped} total={1} /></td>
        <td className={`px-4 py-2 text-right font-mono tabular-nums ${e.amount_cents < 0 ? "text-success" : "text-strong"}`}>
          {formatCurrencyCents(e.amount_cents)}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-line/20">
          <td colSpan={7} className="p-0">
            <div className="bg-canvas border-b border-line/60 px-10 py-3 flex flex-col gap-3">
              {/* Details */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5 text-[11px]">
                {[
                  ["Source account", e.external_account_name ?? "—"],
                  ["Merchant category", e.merchant_category ?? e.sk_category_name ?? "—"],
                  ["Department", e.department_name ?? "—"],
                  ["Memo", e.memo ?? "—"],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <div className="text-[10px] text-faint uppercase tracking-wider">{label}</div>
                    <div className="text-body truncate" title={value}>{value}</div>
                  </div>
                ))}
              </div>

              {/* GL account mapping */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-faint uppercase tracking-wider shrink-0">GL account</span>
                <AccountSelect
                  value={e.chart_of_accounts_id}
                  onChange={handleChange}
                  accounts={accounts}
                  placeholder={e.mapping_source === "unmapped" ? "— unmapped —" : "— follow account rule —"}
                  shortLabel
                  className="w-full max-w-[360px]"
                />
                {e.mapping_source === "manual" && (
                  <span className="text-[9px] text-info shrink-0" title="Manually pinned — sync and auto-map leave it alone">pin</span>
                )}
                {e.mapping_source === "rule" && (
                  <span className="text-[9px] text-faint shrink-0" title="Coded from the source-account rule (Settings → Expense Accounts)">rule</span>
                )}
                {saving && <span className="text-[10px] text-faint animate-pulse shrink-0">…</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type SortKey = "date" | "merchant" | "state" | "amount";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const currentYear = new Date().getFullYear();

  const [year, setYear] = useState(currentYear);
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [mappingFilter, setMappingFilter] = useState<MappingFilterValue>("all");
  const sort = useTableSort<SortKey>("date");

  const loadAll = useCallback(async (y: number) => {
    setLoading(true); setError(null);
    try {
      const from = `${y}-01-01`;
      const to   = `${y}-12-31`;
      const [coaRes, expRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/expenses?from=${from}&to=${to}`),
      ]);
      const [coa, exp] = await Promise.all([coaRes.json(), expRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setExpenses(Array.isArray(exp) ? exp : []);
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

  async function handleAutoMap(): Promise<{ mapped: number }> {
    const res = await fetch(`/api/finance/expenses/auto-map?from=${year}-01-01&to=${year}-12-31`, { method: "POST" });
    const json = await res.json();
    if (json.mapped > 0) loadAll(year);
    return json;
  }

  const totalCount   = expenses.length;
  const mappedCount  = expenses.filter((e) => e.chart_of_accounts_id).length;
  const totalSpend   = expenses.reduce((s, e) => s + e.amount_cents, 0);

  const visibleExpenses = expenses
    .filter((e) => matchesMappingFilter(mappingFilter, e.chart_of_accounts_id ? 1 : 0, 1))
    .slice()
    .sort((a, b) => {
      let diff = 0;
      if (sort.key === "date")          diff = (a.accounting_date ?? "").localeCompare(b.accounting_date ?? "");
      else if (sort.key === "merchant") diff = (a.merchant_name ?? "").localeCompare(b.merchant_name ?? "");
      else if (sort.key === "state")    diff = (a.state ?? "").localeCompare(b.state ?? "");
      else if (sort.key === "amount")   diff = a.amount_cents - b.amount_cents;
      return sort.asc ? diff : -diff;
    });

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center gap-3 flex-wrap">
        <YearSelect year={year} onChange={setYear} />
        <MappingFilter value={mappingFilter} onChange={setMappingFilter} />
        <AutoMapButton key={year} onRun={handleAutoMap} />
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

      {totalCount > 0 && (
        <SummaryStatBar
          stats={[
            { label: "Expenses", value: totalCount },
            { label: "Mapped", value: `${mappedCount} / ${totalCount}`, tone: mappedCount < totalCount ? "accent" : "secondary" },
            { label: "Total spend", value: formatCurrencyCents(totalSpend) },
          ]}
        />
      )}

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
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <LedgerTable
            head={
              <>
                <Th className="w-6" />
                <SortableTh label="Date" sortKey="date" sort={sort} />
                <SortableTh label="Merchant" sortKey="merchant" sort={sort} />
                <Th label="GL Account" />
                <SortableTh label="Status" sortKey="state" sort={sort} />
                <Th label="Mapping" />
                <SortableTh label="Amount" sortKey="amount" sort={sort} align="right" />
              </>
            }>
            {visibleExpenses.map((e) => (
              <ExpenseRowView key={e.id} e={e} accounts={accounts} onSetExpense={handleSetExpense} />
            ))}
          </LedgerTable>
          <p className="py-3 text-[10px] text-faint">
            Expenses auto-map to the chart of accounts by their source account (rules live in
            Settings → Expense Accounts). Override an individual expense in its row — pinned rows show
            <span className="text-info"> pin</span> and are left untouched by sync and auto-map.
            Mapped totals feed the P&amp;L, Balance Sheet, and Cash Flow statements.
          </p>
        </div>
      )}
    </>
  );
}
