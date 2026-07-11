"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import { ORDER_STATUS_CLS } from "../../lib/categoryColors";
import AccountSelect from "../../AccountSelect";
import SyncPanel from "../components/SyncPanel";
import MappingFilter from "../components/MappingFilter";
import MappingStatusPill from "../components/MappingStatusPill";
import AutoMapButton from "../components/AutoMapButton";
import YearSelect from "../components/YearSelect";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, Th, CategoryBadges } from "../components/LedgerTable";
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterBar from "@/app/components/ui/FilterBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoARef {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
}

interface LineItem {
  id: string;
  square_line_item_uid: string | null;
  square_variation_id: string | null;
  name: string;
  variation_name: string | null;
  quantity: number;
  base_price_cents: number;
  gross_sales_cents: number;
  discount_cents: number;
  net_sales_cents: number;
  tax_cents: number;
  chart_of_accounts_id: string | null;
  notes: string | null;
  chart_of_accounts: CoARef | null;
  effective_chart_of_accounts_id: string | null;
  effective_chart_of_accounts: CoARef | null;
  prefilled_from_mapping: boolean;
}

interface Transaction {
  id: string;
  square_order_id: string;
  transaction_date: string;
  customer_name: string | null;
  total_cents: number;
  tax_cents: number;
  tip_cents: number;
  discount_cents: number;
  status: string;
  notes: string | null;
  pos_line_items: LineItem[];
}

// ── Search/filter/sort config ────────────────────────────────────────────────

function orderMapped(txn: Transaction): [number, number] {
  const items = txn.pos_line_items ?? [];
  return [items.filter((li) => li.effective_chart_of_accounts_id).length, items.length];
}

const ORDER_CONTROLS: ControlsConfig<Transaction> = {
  search: [{ param: "q", accessor: (t) => [t.square_order_id, t.customer_name] }],
  filters: [
    {
      param: "mapping",
      matches: (t, sel) => {
        const [m, n] = orderMapped(t);
        return matchesMappingFilter(sel[0] as MappingFilterValue, m, n);
      },
    },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (t) => t.transaction_date },
      { key: "order", accessor: (t) => t.square_order_id },
      { key: "customer", accessor: (t) => t.customer_name ?? "" },
      { key: "status", accessor: (t) => t.status ?? "" },
      { key: "total", accessor: (t) => t.total_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(cents: number) {
  return formatCurrencyCents(cents);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Distinct GL-account names an order's line items resolve to (its "categories"). */
function orderCategories(lineItems: LineItem[]): string[] {
  return [...new Set(lineItems.map((li) => li.effective_chart_of_accounts?.account_name).filter((n): n is string => !!n))];
}

// ── Line item row (editable) ──────────────────────────────────────────────────

function LineItemRow({
  item,
  accounts,
  onSave,
}: {
  item: LineItem;
  accounts: CoARef[];
  onSave: (id: string, patch: { chart_of_accounts_id: string | null; notes?: string }) => Promise<void>;
}) {
  const [effectiveCoaId, setEffectiveCoaId] = useState<string | null>(item.effective_chart_of_accounts_id);
  const [saving, setSaving] = useState(false);

  const effectiveCoa = accounts.find((a) => a.id === effectiveCoaId) ?? null;
  const isManualOverride = !!item.chart_of_accounts_id;
  const isPrefilled = item.prefilled_from_mapping && !isManualOverride;

  async function handleChange(id: string | null) {
    setEffectiveCoaId(id);
    setSaving(true);
    await onSave(item.id, { chart_of_accounts_id: id });
    setSaving(false);
  }

  return (
    <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 items-center px-4 py-2 border-t border-line/40 hover:bg-surface/20 text-xs">
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="truncate text-secondary flex items-center gap-1.5">
          <span className="text-faint">└</span>
          <span className="truncate">{item.name}</span>
        </div>
        {item.variation_name && (
          <span className="pl-4 text-[10px] text-faint truncate">{item.variation_name}</span>
        )}
      </div>
      <div className="text-faint text-right tabular-nums">{item.quantity}×</div>
      <div className="text-muted text-right tabular-nums font-mono">{fmtMoney(item.gross_sales_cents)}</div>
      <div className={`text-right tabular-nums font-mono ${item.discount_cents > 0 ? "text-danger/70" : "text-disabled"}`}>
        {item.discount_cents > 0 ? fmtMoney(-item.discount_cents) : "—"}
      </div>
      <div className="text-faint text-right tabular-nums font-mono">
        {item.tax_cents > 0 ? fmtMoney(item.tax_cents) : "—"}
      </div>
      <div>
        <AccountSelect
          value={effectiveCoaId}
          onChange={handleChange}
          accounts={accounts}
          prefilled={isPrefilled}
        />
      </div>
      <div className="text-[10px] text-faint truncate">
        {isManualOverride && <span className="text-accent-emphasis/70">override</span>}
        {isPrefilled && effectiveCoa && <span className="text-faint">prefilled</span>}
      </div>
      <div className="w-4 flex items-center justify-center">
        {saving && <span className="text-[10px] text-faint animate-pulse">…</span>}
      </div>
    </div>
  );
}

// ── Order row (expandable) ────────────────────────────────────────────────────

function OrderRow({
  txn,
  accounts,
  onSaveLineItem,
}: {
  txn: Transaction;
  accounts: CoARef[];
  onSaveLineItem: (id: string, patch: { chart_of_accounts_id: string | null }) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineItems = txn.pos_line_items ?? [];
  const mappedCount = lineItems.filter((li) => li.effective_chart_of_accounts_id).length;
  const status = txn.status?.toLowerCase() ?? "";

  return (
    <>
      <tr className="border-t border-line/40 hover:bg-surface-mid/20 cursor-pointer" onClick={() => setExpanded((e) => !e)}>
        <td className="px-4 py-2 w-6"><span className="text-faint text-[10px]">{expanded ? "▾" : "▸"}</span></td>
        <td className="px-4 py-2 text-secondary whitespace-nowrap">
          {fmtDate(txn.transaction_date)}
          <span className="text-[10px] text-faint ml-1.5">{fmtTime(txn.transaction_date)}</span>
        </td>
        <td className="px-4 py-2 font-mono text-accent">{txn.square_order_id.slice(-8)}</td>
        <td className="px-4 py-2 text-body">{txn.customer_name ?? "—"}</td>
        <td className="px-4 py-2"><CategoryBadges items={orderCategories(lineItems)} /></td>
        <td className="px-4 py-2">
          {status && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ORDER_STATUS_CLS[status] ?? "bg-surface-mid text-muted"}`}>
              {status}
            </span>
          )}
        </td>
        <td className="px-4 py-2"><MappingStatusPill mapped={mappedCount} total={lineItems.length} /></td>
        <td className="px-4 py-2 text-right font-mono text-strong tabular-nums">{fmtMoney(txn.total_cents)}</td>
      </tr>

      {expanded && (
        <tr className="border-t border-line/20">
          <td colSpan={8} className="p-0">
            <div className="bg-canvas border-b border-line/60 pb-1">
              {/* Order breakdown summary */}
              <div className="grid grid-cols-4 gap-px mx-4 my-2 bg-surface-mid rounded overflow-hidden text-center">
                {[
                  { label: "Gross Sales", cents: lineItems.reduce((s, li) => s + li.gross_sales_cents, 0) },
                  { label: "Discounts",   cents: -txn.discount_cents },
                  { label: "Tax",         cents: txn.tax_cents },
                  { label: "Tips",        cents: txn.tip_cents },
                ].map(({ label, cents }) => (
                  <div key={label} className="bg-surface px-2 py-2">
                    <div className="text-[10px] text-faint mb-0.5">{label}</div>
                    <div className={`text-xs font-mono tabular-nums font-medium ${cents < 0 ? "text-danger" : cents > 0 ? "text-strong" : "text-faint"}`}>
                      {cents === 0 ? "—" : fmtMoney(cents)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Line item column headers */}
              <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 px-4 py-1.5 bg-surface/40">
                <span className="text-[10px] text-faint uppercase tracking-wider pl-4">Item</span>
                <span className="text-[10px] text-faint uppercase tracking-wider text-right">Qty</span>
                <span className="text-[10px] text-faint uppercase tracking-wider text-right">Gross</span>
                <span className="text-[10px] text-faint uppercase tracking-wider text-right">Disc</span>
                <span className="text-[10px] text-faint uppercase tracking-wider text-right">Tax</span>
                <span className="text-[10px] text-faint uppercase tracking-wider">GL Account</span>
                <span></span>
                <span></span>
              </div>
              {lineItems.length === 0
                ? <p className="px-8 py-3 text-xs text-faint italic">No line items</p>
                : lineItems.map((li) => (
                    <LineItemRow key={li.id} item={li} accounts={accounts} onSave={onSaveLineItem} />
                  ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Sync result shape ─────────────────────────────────────────────────────────

interface SyncResult { synced: number; updated: number; total: number; errors?: string[] }

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SquareTransactionsPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear]               = useState(currentYear);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [accounts, setAccounts]       = useState<CoARef[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const pageSize = 50;

  const loadTransactions = useCallback(async (yr: number, pg: number) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`/api/finance/transactions?year=${yr}&page=${pg}&pageSize=${pageSize}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Load failed"); return; }
      setTransactions(json.transactions ?? []);
      setTotal(json.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setLoading(false); }
  }, []);

  // Load CoA for dropdowns
  useEffect(() => {
    async function loadAccounts() {
      const r = await fetch("/api/finance/chart-of-accounts");
      const d = await r.json();
      setAccounts(Array.isArray(d) ? d : []);
    }
    loadAccounts();
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadTransactions(year, page); }, [year, page, loadTransactions]);

  function handleYearChange(y: number) { setYear(y); setPage(1); }

  async function handleAutoMap(): Promise<{ mapped: number }> {
    const res = await fetch(`/api/finance/transactions/auto-map?year=${year}`, { method: "POST" });
    const json = await res.json();
    if (json.mapped > 0) loadTransactions(year, page);
    return json;
  }

  async function handleSaveLineItem(id: string, patch: { chart_of_accounts_id: string | null }) {
    await fetch("/api/finance/transactions/line-items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    // Optimistically update local state
    setTransactions((txns) =>
      txns.map((t) => ({
        ...t,
        pos_line_items: t.pos_line_items.map((li) => {
          if (li.id !== id) return li;
          const newCoa = accounts.find((a) => a.id === patch.chart_of_accounts_id) ?? null;
          return {
            ...li,
            chart_of_accounts_id:           patch.chart_of_accounts_id,
            chart_of_accounts:              newCoa,
            effective_chart_of_accounts_id: patch.chart_of_accounts_id ?? li.effective_chart_of_accounts_id,
            effective_chart_of_accounts:    newCoa ?? li.effective_chart_of_accounts,
            prefilled_from_mapping:         false,
          };
        }),
      }))
    );
  }

  const totalPages = Math.ceil(total / pageSize);
  const unmappedTotal = transactions.flatMap((t) => t.pos_line_items)
    .filter((li) => !li.effective_chart_of_accounts_id).length;

  const { rows: visibleTransactions, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(transactions, ORDER_CONTROLS);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center gap-3 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search orders…" />
          <YearSelect year={year} onChange={handleYearChange} />
          <MappingFilter value={(filters.mapping?.[0] as MappingFilterValue) ?? "all"}
            onChange={(v) => setFilter("mapping", v === "all" ? [] : [v])} />
        </FilterBar>
        <AutoMapButton key={year} onRun={handleAutoMap} />
        <SyncPanel<SyncResult>
          year={year}
          storageKey="tpb-pos-last-sync"
          label="from Square"
          showMonthPicker
          buildEndpoint={({ year, month }) => `/api/finance/transactions/sync?year=${year}&month=${month}`}
          onSynced={() => loadTransactions(year, 1)}
          renderResult={(r) => (
            <>
              {r.synced > 0 && <span className="text-success mr-2">{r.synced} orders</span>}
              {r.total === 0 && <span className="text-faint">No orders found</span>}
              {r.errors?.length ? <span className="text-danger ml-2">{r.errors.length} errors</span> : null}
            </>
          )}
        />
      </div>

      {total > 0 && (
        <SummaryStatBar
          stats={[
            { label: "Orders", value: total },
            ...(unmappedTotal > 0
              ? [{ label: "Unmapped line items", value: unmappedTotal, tone: "accent" as const }]
              : [{ label: "Line items", value: "all mapped", tone: "secondary" as const }]),
          ]}
        />
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        {loading && <p className="text-xs text-faint px-2 py-8 text-center">Loading…</p>}
        {error && <p className="text-xs text-danger px-2 py-4">{error}</p>}
        {!loading && !error && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-center">
            <p className="text-sm text-secondary">No orders for {year}.</p>
            <p className="text-xs text-faint">Click &ldquo;Sync from Square&rdquo; to pull POS orders.</p>
          </div>
        )}
        {!loading && transactions.length > 0 && (
          <LedgerTable
            head={
              <>
                <Th className="w-6" />
                <SortableTh sortKey="date" label="Date" sort={sort} onSort={toggleSort} />
                <SortableTh sortKey="order" label="Order #" sort={sort} onSort={toggleSort} />
                <SortableTh sortKey="customer" label="Customer" sort={sort} onSort={toggleSort} />
                <Th label="Categories" />
                <SortableTh sortKey="status" label="Status" sort={sort} onSort={toggleSort} />
                <Th label="Mapping" />
                <SortableTh sortKey="total" label="Total" sort={sort} onSort={toggleSort} align="right" />
              </>
            }>
            {visibleTransactions.map((txn) => (
              <OrderRow key={txn.id} txn={txn} accounts={accounts} onSaveLineItem={handleSaveLineItem} />
            ))}
          </LedgerTable>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="shrink-0 border-t border-line px-4 sm:px-6 py-3 flex items-center justify-between">
          <span className="text-xs text-faint">
            Page {page} of {totalPages} · {total} orders
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="btn-secondary">
              ← Prev
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="btn-secondary">
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
