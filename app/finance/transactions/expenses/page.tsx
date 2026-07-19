"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import { EXPENSE_STATE_CLS } from "../../lib/categoryColors";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import SaveHint from "@/app/components/ui/SaveHint";
import DateRangeFilter from "../components/DateRangeFilter";
import AcceptUnmappedButton from "../components/AcceptUnmappedButton";
import SyncPanel from "../components/SyncPanel";
import SummaryStatBar from "../components/SummaryStatBar";
import MappingFilter from "../components/MappingFilter";
import MappingStatusPill from "../components/MappingStatusPill";
import AutoMapButton from "../components/AutoMapButton";
import QbSyncBadge, { qbSyncFilterValue, QB_SYNC_FILTER_OPTIONS } from "../components/QbSyncBadge";
import { normalizeQbSyncStatus } from "@/lib/finance/qbSyncStatus";
import { LedgerTable, Th, CategoryBadges } from "../components/LedgerTable";
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";
import InventoryAlertBanner from "./InventoryAlertBanner";
import { selectInventoryAlerts } from "@/lib/finance/inventoryAlerts";
import { PayrollSplitSummary, PayrollSplitPanel, type PayrollState, type PayrollMatchInfo, type GlLine } from "./PayrollSplitCell";
import { defaultYearRange } from "@/lib/finance/dateRange";

// ── Types (mirror the API responses) ──────────────────────────────────────────
interface CoaJoin {
  account_name: string;
  account_number: string | null;
  account_type: string;
}

interface ExpenseRow {
  id: string;
  source: string;
  ramp_object: "card" | "bill" | "bank";
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
  counterparty_key: string | null;
  qb_sync_status: string | null;
  qb_synced_at: string | null;
  qb_remote_id: string | null;
  chart_of_accounts_id: string | null;
  mapping_source: "unmapped" | "rule" | "manual";
  inventory_alert_dismissed: boolean;
  unmapped_accepted: boolean;
  chart_of_accounts: CoaJoin | null;
  // Payroll GL split state (Task 8's enriched GET) -- populated for every
  // row; only rendered when the counterparty's routing is 'payroll_split'.
  payrollMatch: PayrollMatchInfo | null;
  glLines: GlLine[];
}

interface SyncResult {
  imported: number;
  mapped: number;
  unmapped: number;
  new_rules: number;
  auto_matched_rules: number;
}

// ── Search/filter/sort config ────────────────────────────────────────────────

// An expense is "mapped" when it resolves to at least one GL line. glLines
// already unifies the two coding paths: a normal expense synthesizes a single
// line from its own chart_of_accounts_id, while a payroll_split expense (whose
// own chart_of_accounts_id stays null) carries its expense_gl_splits lines. So
// this one signal drives the pill, the filter, and the summary counter for both.
function isExpenseMapped(e: { glLines: GlLine[] }): boolean {
  return (e.glLines?.length ?? 0) > 0;
}

const EXPENSE_CONTROLS: ControlsConfig<ExpenseRow> = {
  search: [{ param: "q", accessor: (e) => e.merchant_name ?? "" }],
  filters: [
    { param: "mapping", matches: (e, sel) => matchesMappingFilter(sel[0] as MappingFilterValue, isExpenseMapped(e) ? 1 : 0, 1, e.unmapped_accepted) },
    { param: "qbsync", accessor: (e) => qbSyncFilterValue(e.qb_sync_status) },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (e) => e.accounting_date ?? "" },
      { key: "merchant", accessor: (e) => e.merchant_name ?? "" },
      { key: "state", accessor: (e) => e.state ?? "" },
      { key: "amount", accessor: (e) => e.amount_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Ramp's qb_synced_at is a full ISO timestamp (unlike accounting_date). Show date + time.
function fmtDateTime(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── Expandable expense row ─────────────────────────────────────────────────────

function ExpenseRowView({
  e,
  accounts,
  onSetExpense,
  onToggleAccept,
  isPayrollSplit,
  onPayrollUpdated,
}: {
  e: ExpenseRow;
  accounts: CoARef[];
  onSetExpense: (id: string, coaId: string | null) => Promise<void>;
  onToggleAccept: (id: string, accepted: boolean) => Promise<void>;
  // Combines ramp_object === "bank" with the expense's counterparty
  // routing === "payroll_split" (resolveExpenseMapping's payroll_split skip):
  // such rows code via their pay-period split, not the single-account select.
  isPayrollSplit: boolean;
  onPayrollUpdated: (next: PayrollState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const mapped = isExpenseMapped(e) ? 1 : 0;
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
        <td className="px-4 py-2 w-6"><span className="text-faint text-2xs">{expanded ? "▾" : "▸"}</span></td>
        <td className="px-4 py-2 text-secondary whitespace-nowrap">{fmtDate(e.accounting_date)}</td>
        <td className="px-4 py-2 text-body">
          <div className="flex items-center gap-1.5">
            <span className="truncate max-w-[240px]">{e.merchant_name ?? "—"}</span>
            {e.ramp_object !== "card" && (
              <span className="shrink-0 px-1 py-0.5 rounded text-2xs font-medium bg-surface-mid text-muted uppercase tracking-wide">
                {e.ramp_object === "bill" ? "Bill" : "Bank"}
              </span>
            )}
          </div>
          {(e.memo || e.card_holder_name) && (
            <div className="text-2xs text-faint truncate max-w-[240px]">
              {[e.memo, e.card_holder_name].filter(Boolean).join(" · ")}
            </div>
          )}
        </td>
        <td className="px-4 py-2">
          {isPayrollSplit ? (
            <PayrollSplitSummary payrollMatch={e.payrollMatch} glLines={e.glLines} />
          ) : (
            <CategoryBadges items={glName ? [glName] : []} />
          )}
        </td>
        <td className="px-4 py-2">
          {state && (
            <span className={`px-1.5 py-0.5 rounded text-2xs font-medium ${EXPENSE_STATE_CLS[state] ?? "bg-surface-mid text-muted"}`}>
              {state}
            </span>
          )}
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-col gap-1">
            <MappingStatusPill mapped={mapped} total={1} accepted={e.unmapped_accepted} />
            {mappingState(mapped, 1, e.unmapped_accepted) !== "mapped" && (
              <AcceptUnmappedButton
                accepted={e.unmapped_accepted}
                onToggle={() => onToggleAccept(e.id, !e.unmapped_accepted)}
              />
            )}
          </div>
        </td>
        <td className="px-4 py-2">
          <QbSyncBadge status={e.qb_sync_status} rampObject={e.ramp_object} />
        </td>
        <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">
          {formatCurrencyCents(e.amount_cents)}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-line/20">
          <td colSpan={8} className="p-0">
            <div className="bg-canvas border-b border-line/60 px-10 py-3 flex flex-col gap-3">
              {/* Details */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
                {[
                  ["Source account", e.external_account_name ?? "—"],
                  ["Merchant category", e.merchant_category ?? e.sk_category_name ?? "—"],
                  ["Department", e.department_name ?? "—"],
                  ["Memo", e.memo ?? "—"],
                  ["Synced to QB", e.qb_synced_at ? fmtDateTime(e.qb_synced_at) : "—"],
                  ["QB ref", e.qb_remote_id ?? "—"],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <div className="text-2xs text-faint uppercase tracking-wider">{label}</div>
                    <div className="text-body truncate" title={value}>{value}</div>
                  </div>
                ))}
              </div>

              {/* GL account mapping — payroll_split expenses code via their pay-period
                  split (the panel below), so they don't get the single-account select. */}
              {isPayrollSplit ? (
                <PayrollSplitPanel
                  expenseId={e.id}
                  payrollMatch={e.payrollMatch}
                  glLines={e.glLines}
                  accounts={accounts}
                  onUpdated={onPayrollUpdated}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-faint uppercase tracking-wider shrink-0">GL account</span>
                  <AccountSelect
                    value={e.chart_of_accounts_id}
                    onChange={handleChange}
                    accounts={accounts}
                    placeholder={e.mapping_source === "unmapped" ? "— unmapped —" : "— follow account rule —"}
                    shortLabel
                    className="w-full max-w-[360px]"
                  />
                  {e.mapping_source === "manual" && (
                    <span className="text-2xs text-info shrink-0" title="Manually pinned — sync and auto-map leave it alone">pin</span>
                  )}
                  {e.mapping_source === "rule" && (
                    <span className="text-2xs text-faint shrink-0" title="Coded from the source-account rule (Settings → Expense Accounts)">rule</span>
                  )}
                  <SaveHint saving={saving} />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const [{ from, to }, setRange] = useState(() => defaultYearRange());
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  // counterparty_key -> routing, so the table can gate PayrollSplitCell
  // without a per-row join (Task 6's routing lives on
  // expense_counterparty_mappings, not on expenses itself).
  const [routingByCounterpartyKey, setRoutingByCounterpartyKey] = useState<Map<string, "single_account" | "payroll_split">>(new Map());
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const loadAll = useCallback(async (from: string, to: string) => {
    setLoading(true); setError(null);
    try {
      const [coaRes, expRes, cpRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/expenses?from=${from}&to=${to}`),
        fetch("/api/finance/expense-counterparty-mappings"),
      ]);
      const [coa, exp, cp] = await Promise.all([coaRes.json(), expRes.json(), cpRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setExpenses(Array.isArray(exp) ? exp : []);
      setRoutingByCounterpartyKey(
        new Map(
          Array.isArray(cp)
            ? cp.map((r: { counterparty_key: string; routing: "single_account" | "payroll_split" }) => [r.counterparty_key, r.routing])
            : [],
        ),
      );
    } catch {
      setError("Failed to load expenses.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(from, to); }, [loadAll, from, to]);

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

  // Dismiss the production-inventory alert for one expense (optimistic local update).
  async function handleDismissInventoryAlert(id: string) {
    const res = await fetch("/api/finance/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, inventory_alert_dismissed: true }),
    });
    if (!res.ok) return;
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, inventory_alert_dismissed: true } : e)));
  }

  // Patch one expense's payroll state in place from a payroll-match mutation's
  // response, so pressing "Match payroll period" (or recompute/unmatch) updates
  // just that row instead of reloading the whole ledger. Note: matching an
  // expense to a period with an existing Gusto report reweights every matched
  // expense in that period; only the acted-on row refreshes here, so any sibling
  // rows in the same period reconcile on the next natural load (date change /
  // re-sync / refresh). The common flow (awaiting-upload, no splits yet) has no
  // siblings to reweight, so this is exact.
  function handlePayrollUpdated(id: string, next: PayrollState) {
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, payrollMatch: next.payrollMatch, glLines: next.glLines } : e)));
  }

  // Manually accept an unmapped expense as not needing a real GL mapping (optimistic local update).
  async function handleToggleAccept(id: string, accepted: boolean) {
    const res = await fetch("/api/finance/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, unmapped_accepted: accepted }),
    });
    if (!res.ok) return;
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, unmapped_accepted: accepted } : e)));
  }

  async function handleAutoMap(): Promise<{ mapped: number }> {
    const res = await fetch(`/api/finance/expenses/auto-map?from=${from}&to=${to}`, { method: "POST" });
    const json = await res.json();
    if (json.mapped > 0) loadAll(from, to);
    return json;
  }

  // Bulk-match every unmatched payroll_split bank expense in range to its pay
  // period and regenerate its GL splits (server-side; see auto-map-payroll route).
  async function handleAutoMapPayroll(): Promise<{ matched: number; periodsRecomputed: number }> {
    const res = await fetch(`/api/finance/expenses/auto-map-payroll?from=${from}&to=${to}`, { method: "POST" });
    const json = await res.json();
    if (json.matched > 0) loadAll(from, to);
    return json;
  }

  const totalCount   = expenses.length;
  const mappedCount  = expenses.filter((e) => isExpenseMapped(e) || e.unmapped_accepted).length;
  const totalSpend   = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const inQbCount    = expenses.filter((e) => normalizeQbSyncStatus(e.qb_sync_status) === "synced").length;

  const { rows: visibleExpenses, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(expenses, EXPENSE_CONTROLS);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search merchant…" />
          <DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />
          <MappingFilter value={(filters.mapping?.[0] as MappingFilterValue) ?? "all"}
            onChange={(v) => setFilter("mapping", v === "all" ? [] : [v])} />
          <FilterSelect label="QB Sync" options={QB_SYNC_FILTER_OPTIONS} value={filters.qbsync ?? []}
            onChange={(v) => setFilter("qbsync", v)} />
          <AutoMapButton key={`${from}_${to}`} onRun={handleAutoMap} />
          <AutoMapButton
            key={`payroll_${from}_${to}`}
            onRun={handleAutoMapPayroll}
            label="Auto-map payroll"
            busyLabel="Matching…"
            renderResult={(r) => r.matched > 0
              ? <span className="text-success">{r.matched} matched</span>
              : <span className="text-faint">Nothing to match</span>}
          />
          <SyncPanel<SyncResult>
            year={new Date(to).getFullYear()}
            cronJob="ramp-expenses-sync"
            label="Ramp"
            buildEndpoint={() => `/api/finance/expenses/sync?from=${from}&to=${to}`}
            onSynced={() => loadAll(from, to)}
            renderResult={(r) => (
              <span title={`${r.imported} imported · ${r.mapped} mapped · ${r.new_rules} new accounts (${r.auto_matched_rules} auto-matched)`}>
                <span className="text-success mr-1">{r.imported} imported</span>
                <span className="text-secondary mr-1">{r.mapped} mapped</span>
                {r.new_rules > 0 && <span className="text-secondary">{r.new_rules} new accounts</span>}
              </span>
            )}
          />
        </FilterBar>
      </div>

      {totalCount > 0 && (
        <SummaryStatBar
          stats={[
            { label: "Expenses", value: totalCount },
            { label: "Mapped", value: `${mappedCount} / ${totalCount}`, tone: mappedCount < totalCount ? "accent" : "secondary" },
            { label: "In QuickBooks", value: `${inQbCount} / ${totalCount}` },
            { label: "Total spend", value: formatCurrencyCents(totalSpend) },
          ]}
        />
      )}

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      <InventoryAlertBanner
        expenses={selectInventoryAlerts(expenses)}
        onDismiss={handleDismissInventoryAlert}
      />

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
            <p className="text-sm text-secondary">No expenses for {from} – {to}.</p>
            <p className="text-xs text-faint mt-1">Click &ldquo;Sync Ramp&rdquo; to import transactions and bills.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <LedgerTable
            head={
              <>
                <Th className="w-6" />
                <SortableTh sortKey="date" label="Date" sort={sort} onSort={toggleSort} />
                <SortableTh sortKey="merchant" label="Merchant" sort={sort} onSort={toggleSort} />
                <Th label="GL Account" />
                <SortableTh sortKey="state" label="Status" sort={sort} onSort={toggleSort} />
                <Th label="Mapping" />
                <Th label="QB Sync" />
                <SortableTh sortKey="amount" label="Amount" sort={sort} onSort={toggleSort} align="right" />
              </>
            }>
            {visibleExpenses.map((e) => (
              <ExpenseRowView
                key={e.id}
                e={e}
                accounts={accounts}
                onSetExpense={handleSetExpense}
                onToggleAccept={handleToggleAccept}
                isPayrollSplit={e.ramp_object === "bank" && routingByCounterpartyKey.get(e.counterparty_key ?? "") === "payroll_split"}
                onPayrollUpdated={(next) => handlePayrollUpdated(e.id, next)}
              />
            ))}
          </LedgerTable>
          <p className="py-3 text-2xs text-faint">
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
