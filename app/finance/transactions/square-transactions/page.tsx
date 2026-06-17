"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import TransactionsNav from "../TransactionsNav";

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
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function coaLabel(coa: CoARef | null) {
  if (!coa) return null;
  return coa.account_number ? `${coa.account_number} · ${coa.account_name}` : coa.account_name;
}

// ── Account select dropdown ───────────────────────────────────────────────────

function AccountSelect({
  value,
  onChange,
  accounts,
  prefilled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  accounts: CoARef[];
  prefilled?: boolean;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef           = useRef<HTMLDivElement>(null);
  const inputRef          = useRef<HTMLInputElement>(null);

  const selected = accounts.find((a) => a.id === value) ?? null;

  const filtered = query.trim()
    ? accounts.filter((a) =>
        `${a.account_number ?? ""} ${a.account_name} ${a.account_type}`.toLowerCase().includes(query.toLowerCase())
      )
    : accounts;

  const grouped = filtered.reduce<Record<string, CoARef[]>>((acc, a) => {
    (acc[a.account_type] ??= []).push(a);
    return acc;
  }, {});

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setQuery(""); }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function handleOpen() { setOpen(true); setQuery(""); setTimeout(() => inputRef.current?.focus(), 0); }
  function handleSelect(id: string | null) { onChange(id); setOpen(false); setQuery(""); }

  return (
    <div ref={wrapRef} className="relative w-full">
      <button type="button" onClick={handleOpen}
        className={`w-full flex items-center justify-between gap-1 border rounded px-2 py-1 text-xs text-left focus:outline-none transition-colors ${
          prefilled && !selected
            ? "bg-amber-900/10 border-amber-700/40 hover:border-amber-600"
            : "bg-zinc-800 border-zinc-700 hover:border-zinc-500 focus:border-amber-600"
        }`}>
        <span className={`truncate ${selected ? "text-zinc-200" : "text-zinc-500"}`}>
          {selected ? coaLabel(selected) : (prefilled ? "— prefill available —" : "— no mapping —")}
        </span>
        <span className="text-zinc-600 shrink-0">⌄</span>
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl flex flex-col max-h-56 min-w-[260px]">
          <div className="p-1.5 border-b border-zinc-800 shrink-0">
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="Search accounts…"
              className="w-full bg-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none" />
          </div>
          <div className="overflow-y-auto">
            <button type="button" onMouseDown={(e) => { e.preventDefault(); handleSelect(null); }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-zinc-800/50 transition-colors ${
                !value ? "text-amber-400 bg-amber-900/20" : "text-zinc-500 hover:bg-zinc-800"
              }`}>— no mapping —</button>
            {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([type, accs]) => (
              <div key={type}>
                <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider bg-zinc-900/80 sticky top-0">{type}</div>
                {accs.sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "") || a.account_name.localeCompare(b.account_name))
                  .map((a) => (
                    <button key={a.id} type="button" onMouseDown={(e) => { e.preventDefault(); handleSelect(a.id); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors border-t border-zinc-800/30 ${
                        a.id === value ? "bg-amber-900/30 text-amber-300" : "text-zinc-300 hover:bg-zinc-800"
                      }`}>
                      {a.account_number && <span className="text-zinc-500 font-mono mr-1.5">{a.account_number}</span>}
                      {a.account_name}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
    <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 items-center px-4 py-2 border-t border-zinc-800/40 bg-zinc-950/20 text-xs">
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="truncate text-zinc-400 flex items-center gap-1.5">
          <span className="text-zinc-600">└</span>
          <span className="truncate">{item.name}</span>
        </div>
        {item.variation_name && (
          <span className="pl-4 text-[10px] text-zinc-600 truncate">{item.variation_name}</span>
        )}
      </div>
      <div className="text-zinc-600 text-right tabular-nums">{item.quantity}×</div>
      <div className="text-zinc-500 text-right tabular-nums font-mono">{fmtMoney(item.gross_sales_cents)}</div>
      <div className={`text-right tabular-nums font-mono ${item.discount_cents > 0 ? "text-red-400/70" : "text-zinc-700"}`}>
        {item.discount_cents > 0 ? fmtMoney(-item.discount_cents) : "—"}
      </div>
      <div className="text-zinc-600 text-right tabular-nums font-mono">
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
      <div className="text-[10px] text-zinc-600 truncate">
        {isManualOverride && <span className="text-amber-500/70">override</span>}
        {isPrefilled && effectiveCoa && <span className="text-zinc-600">prefilled</span>}
      </div>
      <div className="w-4 flex items-center justify-center">
        {saving && <span className="text-[10px] text-zinc-600 animate-pulse">…</span>}
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
    <div className="border-b border-zinc-800/60">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 sm:px-6 py-3 text-left hover:bg-zinc-900/40 transition-colors">
        <span className="text-zinc-600 text-xs w-3 shrink-0">{expanded ? "▾" : "▸"}</span>
        <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_100px_90px_70px] gap-3 items-center">
          <div className="min-w-0">
            <span className="text-xs text-zinc-300 font-medium">{fmtDate(txn.transaction_date)}</span>
            <span className="text-[10px] text-zinc-600 ml-2">{fmtTime(txn.transaction_date)}</span>
            {txn.customer_name && (
              <span className="text-[10px] text-zinc-500 ml-2 truncate">{txn.customer_name}</span>
            )}
          </div>
          <span className="text-[10px] text-zinc-600 font-mono truncate">{txn.square_order_id.slice(-8)}</span>
          <span className="text-xs text-zinc-300 tabular-nums font-mono text-right">{fmtMoney(txn.total_cents)}</span>
          <div className="flex justify-end">
            {allMapped
              ? <span className="text-[10px] text-green-500">✓ mapped</span>
              : mappedCount > 0
                ? <span className="text-[10px] text-amber-500">{mappedCount}/{lineItems.length}</span>
                : lineItems.length > 0
                  ? <span className="text-[10px] text-zinc-600">unmapped</span>
                  : null}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="pb-1">
          {/* Transaction breakdown summary */}
          <div className="grid grid-cols-4 gap-px mx-4 mb-2 mt-1 bg-zinc-800 rounded overflow-hidden text-center">
            {[
              { label: "Gross Sales", cents: lineItems.reduce((s, li) => s + li.gross_sales_cents, 0) },
              { label: "Discounts",   cents: -txn.discount_cents },
              { label: "Tax",         cents: txn.tax_cents },
              { label: "Tips",        cents: txn.tip_cents },
            ].map(({ label, cents }) => (
              <div key={label} className="bg-zinc-900 px-2 py-2">
                <div className="text-[10px] text-zinc-600 mb-0.5">{label}</div>
                <div className={`text-xs font-mono tabular-nums font-medium ${cents < 0 ? "text-red-400" : cents > 0 ? "text-zinc-200" : "text-zinc-600"}`}>
                  {cents === 0 ? "—" : fmtMoney(cents)}
                </div>
              </div>
            ))}
          </div>

          {/* Line item column headers */}
          <div className="grid grid-cols-[minmax(0,2fr)_50px_80px_60px_60px_90px_minmax(0,1fr)_18px] gap-2 px-4 py-1.5 bg-zinc-900/30">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider pl-4">Item</span>
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Qty</span>
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Gross</span>
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Disc</span>
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Tax</span>
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider">GL Account</span>
            <span></span>
            <span></span>
          </div>
          {lineItems.length === 0
            ? <p className="px-8 py-3 text-xs text-zinc-600 italic">No line items</p>
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
        <span className={`text-xs ${days >= 7 ? "text-amber-400" : "text-zinc-500"}`}>
          Last sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      <select value={month} onChange={(e) => { setMonth(Number(e.target.value)); setResult(null); }}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
        {MONTH_LABELS.map((lbl, i) => <option key={i + 1} value={i + 1}>{lbl}</option>)}
        <option value={0}>Full year</option>
      </select>
      <button onClick={handleSync} disabled={syncing}
        className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap">
        {syncing ? `Syncing ${monthLabel}…` : `Sync ${monthLabel} from Square`}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
      {result && (
        <span className="text-xs text-zinc-400">
          {result.synced > 0 && <span className="text-green-400 mr-2">{result.synced} orders</span>}
          {result.total === 0 && <span className="text-zinc-600">No orders found</span>}
          {result.errors?.length ? <span className="text-red-400 ml-2">{result.errors.length} errors</span> : null}
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
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <TransactionsNav />

      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">Square Transactions</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              {total > 0
                ? `${total} transactions · ${unmappedTotal > 0 ? `${unmappedTotal} line items unmapped` : "all line items mapped"}`
                : "No transactions synced yet"}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select value={year} onChange={(e) => handleYearChange(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={mappingFilter} onChange={(e) => setMappingFilter(e.target.value as MappingFilter)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
              <option value="all">All mappings</option>
              <option value="mapped">Fully mapped</option>
              <option value="partial">Partially mapped</option>
              <option value="unmapped">Unmapped</option>
            </select>
            <div className="flex items-center gap-2">
              <button onClick={handleAutoMap} disabled={autoMapping}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap">
                {autoMapping ? "Mapping…" : "Auto-map all"}
              </button>
              {autoMapResult && (
                <span className="text-xs text-zinc-400">
                  {autoMapResult.mapped > 0
                    ? <span className="text-green-400">{autoMapResult.mapped} items mapped</span>
                    : <span className="text-zinc-600">Nothing to map</span>}
                </span>
              )}
            </div>
            <SyncPanel year={year} onSynced={() => loadTransactions(year, 1)} />
          </div>
        </div>
      </div>

      {/* Table column headers */}
      {transactions.length > 0 && (
        <div className="shrink-0 bg-zinc-900 border-b border-zinc-800 px-4 sm:px-6 py-2 grid grid-cols-[16px_minmax(0,1fr)_100px_90px_70px] gap-3 items-center">
          <span></span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Date / Customer</span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Order ID</span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Total</span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Mapping</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-zinc-600">Loading…</p>
          </div>
        )}
        {error && <p className="text-xs text-red-400 px-6 py-4">{error}</p>}
        {!loading && !error && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-center px-6">
            <p className="text-sm text-zinc-400">No transactions for {year}.</p>
            <p className="text-xs text-zinc-600">Click &ldquo;Sync from Square&rdquo; to pull POS orders.</p>
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
        <div className="shrink-0 border-t border-zinc-800 px-4 sm:px-6 py-3 flex items-center justify-between">
          <span className="text-xs text-zinc-600">
            Page {page} of {totalPages} · {total} transactions
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs rounded transition-colors">
              ← Prev
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-300 text-xs rounded transition-colors">
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
