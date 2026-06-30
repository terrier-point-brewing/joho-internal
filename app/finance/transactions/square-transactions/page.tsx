"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import FinanceNav from "../../FinanceNav";
import TransactionsNav from "../TransactionsNav";
import AccountSelect from "../../AccountSelect";
import PageHeader from "@/app/components/PageHeader";

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
    <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 items-center px-4 py-2 border-t border-line/40 bg-canvas/20 text-xs">
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

// ── Transaction row (collapsible) ─────────────────────────────────────────────

function TransactionRow({
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
  const allMapped = lineItems.length > 0 && mappedCount === lineItems.length;

  return (
    <div className="border-b border-line/60">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 sm:px-6 py-3 text-left hover:bg-surface/40 transition-colors">
        <span className="text-faint text-xs w-3 shrink-0">{expanded ? "▾" : "▸"}</span>
        <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_100px_90px_70px] gap-3 items-center">
          <div className="min-w-0">
            <span className="text-xs text-body font-medium">{fmtDate(txn.transaction_date)}</span>
            <span className="text-[10px] text-faint ml-2">{fmtTime(txn.transaction_date)}</span>
            {txn.customer_name && (
              <span className="text-[10px] text-muted ml-2 truncate">{txn.customer_name}</span>
            )}
          </div>
          <span className="text-[10px] text-faint font-mono truncate">{txn.square_order_id.slice(-8)}</span>
          <span className="text-xs text-body tabular-nums font-mono text-right">{fmtMoney(txn.total_cents)}</span>
          <div className="flex justify-end">
            {allMapped
              ? <span className="text-[10px] text-success">✓ mapped</span>
              : mappedCount > 0
                ? <span className="text-[10px] text-accent-emphasis">{mappedCount}/{lineItems.length}</span>
                : lineItems.length > 0
                  ? <span className="text-[10px] text-faint">unmapped</span>
                  : null}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="pb-1">
          {/* Transaction breakdown summary */}
          <div className="grid grid-cols-4 gap-px mx-4 mb-2 mt-1 bg-surface-mid rounded overflow-hidden text-center">
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
          <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 px-4 py-1.5 bg-surface/30">
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
      )}
    </div>
  );
}

// ── Sync panel ────────────────────────────────────────────────────────────────

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const LAST_SYNC_KEY = "tpb-pos-last-sync";

function daysSince(isoStr: string): number {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

function SyncPanel({ year, onSynced }: { year: number; onSynced: () => void }) {
  const currentMonth = new Date().getMonth() + 1;
  const [month, setMonth]   = useState(currentMonth);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult]   = useState<{ synced: number; updated: number; total: number; dateRange?: { startDate: string; endDate: string }; errors?: string[] } | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(LAST_SYNC_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setLastSync(stored);
  }, []);

  async function handleSync() {
    setSyncing(true); setError(null); setResult(null);
    try {
      const res  = await fetch(`/api/finance/transactions/sync?year=${year}&month=${month}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Sync failed"); return; }
      setResult(json);
      const now = new Date().toISOString();
      localStorage.setItem(LAST_SYNC_KEY, now);
      setLastSync(now);
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally { setSyncing(false); }
  }

  const monthLabel = month === 0 ? "full year" : MONTH_LABELS[month - 1];
  const days = lastSync != null ? daysSince(lastSync) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {days != null && (
        <span className={`text-xs ${days >= 7 ? "text-accent" : "text-muted"}`}>
          Last sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setResult(null); }}
        className="inp inp-sm w-auto">
        {MONTH_LABELS.map((lbl, i) => <option key={i + 1} value={i + 1}>{lbl}</option>)}
        <option value={0}>Full year</option>
      </select>
      <button onClick={handleSync} disabled={syncing} className="btn-sm whitespace-nowrap">
        {syncing ? `Syncing ${monthLabel}…` : `Sync ${monthLabel} from Square`}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
      {result && (
        <span className="text-xs text-secondary">
          {result.synced > 0 && <span className="text-success mr-2">{result.synced} orders</span>}
          {result.total === 0 && <span className="text-faint">No orders found</span>}
          {result.errors?.length ? <span className="text-danger ml-2">{result.errors.length} errors</span> : null}
        </span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type MappingFilter = "all" | "mapped" | "partial" | "unmapped";

export default function SquareTransactionsPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear]               = useState(currentYear);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal]             = useState(0);
  const [page, setPage]               = useState(1);
  const [accounts, setAccounts]       = useState<CoARef[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [mappingFilter, setMappingFilter] = useState<MappingFilter>("all");
  const [autoMapping, setAutoMapping] = useState(false);
  const [autoMapResult, setAutoMapResult] = useState<{ mapped: number } | null>(null);
  const pageSize = 50;
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

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

  function handleYearChange(y: number) { setYear(y); setPage(1); setAutoMapResult(null); }

  async function handleAutoMap() {
    setAutoMapping(true); setAutoMapResult(null);
    const res = await fetch(`/api/finance/transactions/auto-map?year=${year}`, { method: "POST" });
    const json = await res.json();
    setAutoMapResult(json);
    if (json.mapped > 0) loadTransactions(year, page);
    setAutoMapping(false);
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

  const filteredTransactions = mappingFilter === "all" ? transactions : transactions.filter((txn) => {
    const items = txn.pos_line_items ?? [];
    if (items.length === 0) return mappingFilter === "unmapped";
    const mapped = items.filter((li) => li.effective_chart_of_accounts_id).length;
    if (mappingFilter === "mapped")   return mapped === items.length;
    if (mappingFilter === "partial")  return mapped > 0 && mapped < items.length;
    if (mappingFilter === "unmapped") return mapped === 0;
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader title="Transactions" />
      </div>
      <TransactionsNav />
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-muted">
          {total > 0
            ? `${total} transactions · ${unmappedTotal > 0 ? `${unmappedTotal} line items unmapped` : "all line items mapped"}`
            : "No transactions synced yet"}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <select value={year} onChange={(e) => handleYearChange(Number(e.target.value))}
            className="inp w-auto">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={mappingFilter} onChange={(e) => setMappingFilter(e.target.value as MappingFilter)}
            className="inp w-auto">
            <option value="all">All mappings</option>
            <option value="mapped">Fully mapped</option>
            <option value="partial">Partially mapped</option>
            <option value="unmapped">Unmapped</option>
          </select>
          <div className="flex items-center gap-2">
            <button onClick={handleAutoMap} disabled={autoMapping}
              className="btn-sm whitespace-nowrap">
              {autoMapping ? "Mapping…" : "Auto-map all"}
            </button>
            {autoMapResult && (
              <span className="text-xs text-secondary">
                {autoMapResult.mapped > 0
                  ? <span className="text-success">{autoMapResult.mapped} items mapped</span>
                  : <span className="text-faint">Nothing to map</span>}
              </span>
            )}
          </div>
          <SyncPanel year={year} onSynced={() => loadTransactions(year, 1)} />
        </div>
      </div>

      {/* Table column headers */}
      {transactions.length > 0 && (
        <div className="shrink-0 bg-surface border-b border-line px-4 sm:px-6 py-2 grid grid-cols-[16px_minmax(0,1fr)_100px_90px_70px] gap-3 items-center">
          <span></span>
          <span className="text-[10px] text-faint uppercase tracking-wider">Date / Customer</span>
          <span className="text-[10px] text-faint uppercase tracking-wider">Order ID</span>
          <span className="text-[10px] text-faint uppercase tracking-wider text-right">Total</span>
          <span className="text-[10px] text-faint uppercase tracking-wider text-right">Mapping</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-faint">Loading…</p>
          </div>
        )}
        {error && <p className="text-xs text-danger px-6 py-4">{error}</p>}
        {!loading && !error && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-center px-6">
            <p className="text-sm text-secondary">No transactions for {year}.</p>
            <p className="text-xs text-faint">Click &ldquo;Sync from Square&rdquo; to pull POS orders.</p>
          </div>
        )}
        {!loading && filteredTransactions.map((txn) => (
          <TransactionRow
            key={txn.id}
            txn={txn}
            accounts={accounts}
            onSaveLineItem={handleSaveLineItem}
          />
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="shrink-0 border-t border-line px-4 sm:px-6 py-3 flex items-center justify-between">
          <span className="text-xs text-faint">
            Page {page} of {totalPages} · {total} transactions
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="btn-ghost btn-sm">
              ← Prev
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="btn-ghost btn-sm">
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
