"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import { EXPENSE_STATE_CLS } from "../../lib/categoryColors";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
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
import { matchesGlFilter, narrowToGl } from "@/lib/finance/glLineMatch";
import GlAccountFilter from "../components/GlAccountFilter";
import { PayrollSplitSummary, PayrollSplitPanel, type PayrollState, type PayrollMatchInfo, type GlLine } from "./PayrollSplitCell";
import { ManualSplitPanel } from "./ManualSplitPanel";
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
  excluded_at: string | null;
  excluded_reason: string | null;
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

// Excluded rows stay in this ledger (only the statements drop them), so the
// operator needs a way to pull them up for review or restore.
const EXCLUDED_FILTER_OPTIONS = [
  { value: "active",   label: "Not excluded" },
  { value: "excluded", label: "Excluded only" },
];

const EXPENSE_CONTROLS: ControlsConfig<ExpenseRow> = {
  search: [{ param: "q", accessor: (e) => e.merchant_name ?? "" }],
  filters: [
    { param: "mapping", matches: (e, sel) => matchesMappingFilter(sel[0] as MappingFilterValue, isExpenseMapped(e) ? 1 : 0, 1, e.unmapped_accepted) },
    { param: "qbsync", accessor: (e) => qbSyncFilterValue(e.qb_sync_status) },
    { param: "excluded", accessor: (e) => (e.excluded_at ? "excluded" : "active") },
    // An expense can carry several GL accounts once it is split, so this matches
    // on any of its resolved lines rather than the row's own chart_of_accounts_id.
    { param: "gl", matches: (e, sel) => matchesGlFilter(e.glLines.map((l) => l.chartOfAccountsId), sel) },
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
  onExclude,
  onRestore,
  onSplitUpdated,
  glFilter,
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
  /** Resolve to null on success, or the message to show the operator on failure. */
  onExclude: (id: string, reason: string) => Promise<string | null>;
  onRestore: (id: string) => Promise<string | null>;
  /** Selected GL account ids; empty means no GL filter and no narrowing. */
  glFilter: string[];
  onSplitUpdated: (id: string, next: { glLines: GlLine[]; mapping_source: string }) => void;
}) {
  // Cents attributable to the selected GL account(s). Short-circuits to the row's
  // own total when no filter is active — an unmapped expense has NO glLines at
  // all (resolveExpenseGlLines returns [] without a chart_of_accounts_id), so
  // summing lines unconditionally would render those rows as $0.00.
  const glMatchedCents = glFilter.length === 0
    ? e.amount_cents
    : narrowToGl(e.glLines, (l) => l.chartOfAccountsId, glFilter).reduce((sum, l) => sum + l.amountCents, 0);

  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingSplit, setEditingSplit] = useState(false);
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [excludeReason, setExcludeReason] = useState("");
  const [excludeError, setExcludeError] = useState<string | null>(null);
  const hasManualSplit = e.glLines.some((l) => l.splitSource === "manual");
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
          <div className="flex items-center gap-1.5">
            {isPayrollSplit ? (
              <PayrollSplitSummary payrollMatch={e.payrollMatch} glLines={e.glLines} />
            ) : (
              <CategoryBadges items={glName ? [glName] : []} />
            )}
            {e.excluded_at && (
              <span title={e.excluded_reason ?? undefined}>
                <Badge tone="danger">Excluded</Badge>
              </span>
            )}
          </div>
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
          {formatCurrencyCents(glMatchedCents)}
          {/* Under a GL filter the row is narrowed to its matching lines, so the
              amount shown is a subtotal. Carry the real row total alongside it —
              a bare subtotal reads as the expense's full value. */}
          {glMatchedCents !== e.amount_cents && (
            <div className="text-2xs text-faint font-normal">of {formatCurrencyCents(e.amount_cents)}</div>
          )}
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
              ) : editingSplit || hasManualSplit ? (
                <ManualSplitPanel
                  expenseId={e.id}
                  parentAmountCents={e.amount_cents}
                  glLines={e.glLines}
                  accounts={accounts}
                  onUpdated={(next) => { onSplitUpdated(e.id, next); setEditingSplit(false); }}
                  onCancel={() => setEditingSplit(false)}
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

              <div className="flex items-center gap-2">
                {!isPayrollSplit && !hasManualSplit && !e.excluded_at && (
                  <button type="button" className="btn-secondary btn-xxs" onClick={() => setEditingSplit(true)}>
                    Split across accounts
                  </button>
                )}
                {e.excluded_at ? (
                  <button type="button" className="btn-secondary btn-xxs"
                    onClick={async () => setExcludeError(await onRestore(e.id))}>
                    Restore
                  </button>
                ) : (
                  !hasManualSplit && (
                    <button type="button" className="btn-danger btn-xxs" onClick={() => setConfirmExclude(true)}>
                      Exclude as duplicate
                    </button>
                  )
                )}
              </div>

              {/* Exclude/restore can 409 (payroll-matched, or already split). Failing
                  silently here would leave the operator believing a duplicate was
                  removed from the statements when it was not. */}
              {excludeError && <div className="text-2xs text-danger">{excludeError}</div>}

              {confirmExclude && (
                <ConfirmDialog
                  title="Exclude as duplicate"
                  confirmLabel="Exclude"
                  tone="danger"
                  /* ConfirmDialog disables its confirm button on `busy`; reuse it so a
                     blank reason reads as "not yet allowed" instead of a dead click. */
                  busy={!excludeReason.trim()}
                  message={
                    <div className="flex flex-col gap-2">
                      <p>This removes the transaction from the P&amp;L, cash flow, and balance sheet. It stays visible here and can be restored.</p>
                      <input
                        className="inp-sm w-full"
                        value={excludeReason}
                        onChange={(ev) => setExcludeReason(ev.target.value)}
                        placeholder="Reason (required)"
                        aria-label="Exclusion reason"
                      />
                    </div>
                  }
                  onConfirm={async () => {
                    if (!excludeReason.trim()) return;
                    const err = await onExclude(e.id, excludeReason.trim());
                    // Close either way and report failure in the drawer, so the
                    // message sits next to the row it concerns rather than behind
                    // a still-open modal.
                    setExcludeError(err);
                    setConfirmExclude(false);
                    setExcludeReason("");
                  }}
                  onCancel={() => { setConfirmExclude(false); setExcludeReason(""); }}
                />
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

  // Exclude / restore a duplicate. Reason is required by the API; the dialog
  // collects it. Unlike the other row mutations here, these return the failure
  // message instead of swallowing it: the API 409s when the expense is
  // payroll-matched or already manually split, and a silent no-op would leave
  // the operator believing a duplicate had been taken off the statements.
  async function handleExclude(id: string, reason: string): Promise<string | null> {
    const res = await fetch(`/api/finance/expenses/${id}/exclude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return ((await res.json()) as { error?: string }).error ?? "Could not exclude this transaction";
    const updated = (await res.json()) as { excluded_at: string | null; excluded_reason: string | null };
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, ...updated } : e)));
    return null;
  }

  async function handleRestore(id: string): Promise<string | null> {
    const res = await fetch(`/api/finance/expenses/${id}/exclude`, { method: "DELETE" });
    if (!res.ok) return ((await res.json()) as { error?: string }).error ?? "Could not restore this transaction";
    setExpenses((es) => es.map((e) => (e.id === id ? { ...e, excluded_at: null, excluded_reason: null } : e)));
    return null;
  }

  // Patch one expense's split state in place after a manual-split mutation.
  function handleSplitUpdated(id: string, next: { glLines: GlLine[]; mapping_source: string }) {
    setExpenses((es) => es.map((e) => (e.id === id
      ? { ...e, glLines: next.glLines, mapping_source: next.mapping_source as ExpenseRow["mapping_source"] }
      : e)));
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

  const { rows: visibleExpenses, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(expenses, EXPENSE_CONTROLS);

  // A GL filter narrows each row to the lines coded to that account, so the
  // stat bar has to follow the same narrowing — a header total covering every
  // expense while the rows below show one account's slice invites exactly the
  // misreading the per-row "of …" context exists to prevent. Without a GL
  // filter these stay over the full set, unchanged.
  const glFilter     = filters.gl ?? [];
  const statRows     = glFilter.length > 0 ? visibleExpenses : expenses;
  const totalCount   = statRows.length;
  const mappedCount  = statRows.filter((e) => isExpenseMapped(e) || e.unmapped_accepted).length;
  const totalSpend   = glFilter.length > 0
    ? statRows.reduce((s, e) => s + narrowToGl(e.glLines, (l) => l.chartOfAccountsId, glFilter).reduce((t, l) => t + l.amountCents, 0), 0)
    : statRows.reduce((s, e) => s + e.amount_cents, 0);
  const inQbCount    = statRows.filter((e) => normalizeQbSyncStatus(e.qb_sync_status) === "synced").length;

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
          <FilterSelect label="Excluded" options={EXCLUDED_FILTER_OPTIONS} value={filters.excluded ?? []}
            onChange={(v) => setFilter("excluded", v)} />
          <GlAccountFilter accounts={accounts} value={filters.gl?.[0] ?? null}
            onChange={(id) => setFilter("gl", id ? [id] : [])} />
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
                onExclude={handleExclude}
                onRestore={handleRestore}
                onSplitUpdated={handleSplitUpdated}
                glFilter={filters.gl ?? []}
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
