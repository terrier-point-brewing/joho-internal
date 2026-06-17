"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceType } from "@/types/finance";
import FinanceNav from "../FinanceNav";
import TransactionsNav from "../transactions/TransactionsNav";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDollars(cents: number) {
  if (cents === 0) return <span className="text-zinc-600">—</span>;
  return <span>${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>;
}

const STATUS_CLS: Record<string, string> = {
  paid:    "bg-green-900/40 text-green-400",
  open:    "bg-amber-900/40 text-amber-400",
  partial: "bg-blue-900/40 text-blue-400",
  voided:  "bg-zinc-800 text-zinc-500",
  unknown: "bg-zinc-800 text-zinc-500",
};


// ── Invoice list with joined data ─────────────────────────────────────────────

interface CoARef { id: string; account_name: string; account_number: string | null; account_type: string }

interface InvoiceLineItemRow {
  id: string;
  sort_order: number | null;
  description: string;
  category: string | null;
  quantity: number | null;
  unit_price_cents: number;
  total_cents: number;
  variation_name: string | null;
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
  delivery_invoice_id: string | null;
  account_mode: "force_bs" | "force_pl" | null;
  chart_of_accounts: CoARef | null;
}

interface InvoiceRow extends Omit<Invoice, "invoice_line_items"> {
  invoice_line_items: InvoiceLineItemRow[];
  invoice_batch_links: { count: number }[];
  contract_brewing_partners: { company_name: string } | null;
  invoice_type: InvoiceType;
  allocation_id: string | null;
}

// ── Invoice line item CoA editor ──────────────────────────────────────────────

import { useRef, useEffect } from "react";

function CoASelect({
  value,
  accounts,
  onChange,
}: {
  value: string | null;
  accounts: CoARef[];
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  function handleSelect(id: string | null) { onChange(id); setOpen(false); setQuery(""); }

  const coaLabel = (a: CoARef) => a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;

  return (
    <div ref={wrapRef} className="relative w-full max-w-[300px]">
      <button type="button" onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="w-full flex items-center justify-between gap-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-left focus:outline-none hover:border-zinc-500 transition-colors">
        <span className={`truncate ${selected ? "text-zinc-200" : "text-zinc-500"}`}>
          {selected ? coaLabel(selected) : "— no mapping —"}
        </span>
        <span className="text-zinc-600 shrink-0">⌄</span>
      </button>
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl flex flex-col max-h-52 min-w-[260px]">
          <div className="p-1.5 border-b border-zinc-800 shrink-0">
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="Search accounts…"
              className="w-full bg-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none" />
          </div>
          <div className="overflow-y-auto">
            <button type="button" onMouseDown={(e) => { e.preventDefault(); handleSelect(null); }}
              className={`w-full text-left px-3 py-2 text-xs border-b border-zinc-800/50 transition-colors ${!value ? "text-amber-400 bg-amber-900/20" : "text-zinc-500 hover:bg-zinc-800"}`}>
              — no mapping —
            </button>
            {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([type, accs]) => (
              <div key={type}>
                <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider bg-zinc-900/80 sticky top-0">{type}</div>
                {accs.sort((a, b) => (a.account_number ?? "").localeCompare(b.account_number ?? "")).map((a) => (
                  <button key={a.id} type="button" onMouseDown={(e) => { e.preventDefault(); handleSelect(a.id); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors border-t border-zinc-800/30 ${a.id === value ? "bg-amber-900/30 text-amber-300" : "text-zinc-300 hover:bg-zinc-800"}`}>
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

// ── Expandable invoice row ────────────────────────────────────────────────────

interface InvoiceSummary { id: string; invoice_number: string | null; external_id: string | null; invoice_date: string | null; customer_name: string | null; status: string }

function InvoiceExpandableRow({
  inv,
  accounts,
  batches,
  allInvoices,
  onSaveLineItem,
  onBatchChanged,
}: {
  inv: InvoiceRow;
  accounts: CoARef[];
  batches: BrewBatch[];
  allInvoices: InvoiceSummary[];
  onSaveLineItem: (id: string, patch: Record<string, string | null>) => Promise<void>;
  onBatchChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const linkCount = (inv.invoice_batch_links as unknown as { count: number }[])[0]?.count ?? 0;
  const lineItems = inv.invoice_line_items ?? [];
  const mappedCount = lineItems.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length;
  const allMapped = lineItems.length > 0 && mappedCount === lineItems.length;
  const missingDelivery = lineItems.some((li) => li.bs_chart_of_accounts_id && !li.delivery_invoice_id);

  return (
    <>
      <tr
        className="border-t border-zinc-800/40 hover:bg-zinc-800/20 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}>
        <td className="px-4 py-2 w-6">
          <span className="text-zinc-600 text-[10px]">{expanded ? "▾" : "▸"}</span>
        </td>
        <td className="px-4 py-2 font-mono text-amber-400">
          {inv.invoice_number ?? inv.external_id}
        </td>
        <td className="px-4 py-2 text-zinc-400">{fmtDate(inv.invoice_date)}</td>
        <td className="px-4 py-2 text-zinc-300">
          {inv.contract_brewing_partners?.company_name ?? inv.customer_name ?? "—"}
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-wrap gap-1">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${inv.source === "square" ? "bg-blue-900/40 text-blue-400" : "bg-violet-900/40 text-violet-400"}`}>
              {inv.source === "square" ? "Square" : "QuickBooks"}
            </span>
            {(inv as InvoiceRow).invoice_type === "allocation_deposit" && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-900/40 text-amber-400">Deposit</span>
            )}
          </div>
        </td>
        <td className="px-4 py-2">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[inv.status] ?? STATUS_CLS.unknown}`}>
            {inv.status}
          </span>
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-col gap-1">
            {lineItems.length === 0
              ? <span className="text-zinc-700">—</span>
              : allMapped
                ? <span className="text-[10px] text-green-500">✓ all mapped</span>
                : mappedCount > 0
                  ? <span className="text-[10px] text-amber-500">{mappedCount}/{lineItems.length} mapped</span>
                  : <span className="text-[10px] text-zinc-600">unmapped</span>}
            {missingDelivery && (
              <span className="text-[10px] text-amber-400">⚠ deposit missing delivery</span>
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-right font-mono text-zinc-200 tabular-nums">
          {fmtDollars(inv.total_cents)}
        </td>
        <td className="px-4 py-2 text-center">
          {linkCount > 0
            ? <span className="text-green-400 font-medium">{linkCount}</span>
            : <span className="text-zinc-600">—</span>}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-zinc-800/20">
          <td colSpan={9} className="p-0">
            <div className="bg-zinc-950 border-b border-zinc-800/60">
              {/* Line item headers */}
              <div className="grid grid-cols-[minmax(0,2fr)_60px_80px_80px_minmax(0,1fr)] gap-3 px-10 py-1.5 bg-zinc-900/40 text-[10px] text-zinc-600 uppercase tracking-wider">
                <span>Description</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit Price</span>
                <span className="text-right">Total</span>
                <span>GL Account</span>
              </div>
              {lineItems.length === 0
                ? <p className="px-10 py-3 text-xs text-zinc-600 italic">No line items</p>
                : lineItems
                    .slice()
                    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                    .map((li) => (
                      <InvoiceLineItemRow
                        key={li.id}
                        item={li}
                        accounts={accounts}
                        allInvoices={allInvoices.filter((i) => i.id !== inv.id)}
                        onSave={onSaveLineItem}
                      />
                    ))}
              <BatchLinkEditor invoiceId={inv.id} batches={batches} onChanged={onBatchChanged} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function InvoiceLineItemRow({
  item,
  accounts,
  allInvoices,
  onSave,
}: {
  item: InvoiceLineItemRow;
  accounts: CoARef[];
  allInvoices: InvoiceSummary[];
  onSave: (id: string, patch: Record<string, string | null>) => Promise<void>;
}) {
  const [coaId,   setCoaId]   = useState<string | null>(item.chart_of_accounts_id);
  const [bsId,    setBsId]    = useState<string | null>(item.bs_chart_of_accounts_id);
  const [plId,    setPlId]    = useState<string | null>(item.pl_chart_of_accounts_id);
  const [delivId, setDelivId] = useState<string | null>(item.delivery_invoice_id);
  const [saving,  setSaving]  = useState(false);
  const isDeposit = !!(bsId || plId);

  async function save(patch: Record<string, string | null>) {
    setSaving(true);
    await onSave(item.id, patch);
    setSaving(false);
  }

  async function handleCoaChange(id: string | null) { setCoaId(id); await save({ chart_of_accounts_id: id }); }
  async function handleBsChange(id: string | null)  { setBsId(id);  await save({ bs_chart_of_accounts_id: id }); }
  async function handlePlChange(id: string | null)  { setPlId(id);  await save({ pl_chart_of_accounts_id: id }); }
  async function handleDelivChange(id: string | null) { setDelivId(id); await save({ delivery_invoice_id: id }); }

  // Determine effective account for display hint
  const deliveryInv = allInvoices.find((i) => i.id === delivId);
  const deliveryPaid = deliveryInv?.status === "paid";

  return (
    <div className="border-t border-zinc-800/30 hover:bg-zinc-900/20 transition-colors">
      {/* Main row */}
      <div className="grid grid-cols-[minmax(0,2fr)_60px_80px_80px_minmax(0,1fr)] gap-3 px-10 py-2 text-xs items-start">
        <div className="min-w-0 pt-0.5">
          <span className="text-zinc-400 truncate block">{item.description}</span>
          {item.variation_name && <span className="text-[10px] text-zinc-600">{item.variation_name}</span>}
          {isDeposit && (
            <span className="inline-block mt-0.5 ml-1 px-1 py-0.5 rounded text-[9px] font-medium bg-violet-900/40 text-violet-400">
              deposit
            </span>
          )}
        </div>
        <span className="text-zinc-600 text-right tabular-nums pt-0.5">{item.quantity ?? 1}×</span>
        <span className="text-zinc-500 text-right tabular-nums font-mono pt-0.5">
          {item.unit_price_cents ? "$" + (item.unit_price_cents / 100).toFixed(2) : "—"}
        </span>
        <span className="text-zinc-300 text-right tabular-nums font-mono pt-0.5">
          ${(item.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </span>
        <div className="flex flex-col gap-1.5">
          {!isDeposit && (
            <div className="flex items-center gap-2">
              <CoASelect value={coaId} accounts={accounts} onChange={handleCoaChange} />
              {saving && <span className="text-[10px] text-zinc-600 animate-pulse shrink-0">…</span>}
            </div>
          )}
          {isDeposit && (
            <div className="flex flex-col gap-1.5">
              {/* BS account */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] font-medium px-1 py-0.5 rounded shrink-0 ${!deliveryPaid ? "bg-violet-900/60 text-violet-300" : "bg-zinc-800 text-zinc-500"}`}>BS</span>
                <CoASelect value={bsId} accounts={accounts} onChange={handleBsChange} />
              </div>
              {/* PL account */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] font-medium px-1 py-0.5 rounded shrink-0 ${deliveryPaid ? "bg-green-900/60 text-green-300" : "bg-zinc-800 text-zinc-500"}`}>P&L</span>
                <CoASelect value={plId} accounts={accounts} onChange={handlePlChange} />
              </div>
              {/* Delivery invoice */}
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-zinc-600 shrink-0">delivery</span>
                <select
                  value={delivId ?? ""}
                  onChange={(e) => handleDelivChange(e.target.value || null)}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 focus:outline-none">
                  <option value="">— no delivery invoice —</option>
                  {allInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number ?? inv.external_id ?? inv.id.slice(0, 8)}
                      {inv.invoice_date ? ` · ${inv.invoice_date.slice(0, 7)}` : ""}
                      {inv.customer_name ? ` · ${inv.customer_name}` : ""}
                      {inv.status === "paid" ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </div>
              {/* Warning */}
              {!delivId && (
                <p className="text-[9px] text-amber-500/80">No delivery invoice linked — showing as Balance Sheet</p>
              )}
              {saving && <span className="text-[10px] text-zinc-600 animate-pulse">…</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Batch types ───────────────────────────────────────────────────────────────

interface BrewBatch {
  id: string;
  batch_number: number | null;
  beer_name: string;
  planned_brew_date: string | null;
}

interface BatchLink {
  id: string;
  note: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number | null; planned_brew_date: string | null } | null;
}

// ── Batch link editor (shown in expanded invoice row) ─────────────────────────

function BatchLinkEditor({
  invoiceId,
  batches,
  onChanged,
}: {
  invoiceId: string;
  batches: BrewBatch[];
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<BatchLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [selectedBatch, setSelectedBatch] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingLinks(true); // eslint-disable-line react-hooks/set-state-in-effect
    fetch(`/api/finance/ledger/invoice-batch-links?invoice_id=${invoiceId}`)
      .then((r) => r.json())
      .then((d) => setLinks(Array.isArray(d) ? d : []))
      .finally(() => setLoadingLinks(false));
  }, [invoiceId]);

  async function handleAdd() {
    if (!selectedBatch) return;
    setAdding(true); setAddError(null);
    const res = await fetch("/api/finance/ledger/invoice-batch-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId, batch_id: selectedBatch }),
    });
    if (!res.ok) {
      const d = await res.json();
      setAddError(d.error ?? "Failed to link");
    } else {
      const link = await res.json() as BatchLink;
      setLinks((prev) => [link, ...prev]);
      setSelectedBatch("");
      onChanged();
    }
    setAdding(false);
  }

  async function handleRemove(linkId: string) {
    await fetch(`/api/finance/ledger/invoice-batch-links/${linkId}`, { method: "DELETE" });
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    onChanged();
  }

  const linkedBatchIds = new Set(links.map((l) => l.brew_batches?.id).filter(Boolean));
  const availableBatches = batches.filter((b) => !linkedBatchIds.has(b.id));

  return (
    <div className="px-10 py-3 border-t border-zinc-800/40 bg-zinc-950/40">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Batch Links</div>
      {loadingLinks ? (
        <p className="text-xs text-zinc-600">Loading…</p>
      ) : (
        <>
          {links.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {links.map((link) => (
                <div key={link.id} className="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs">
                  <span className="text-zinc-300">
                    {link.brew_batches?.batch_number != null ? `#${link.brew_batches.batch_number} · ` : ""}
                    {link.brew_batches?.beer_name ?? "Unknown batch"}
                  </span>
                  <button onClick={() => handleRemove(link.id)}
                    className="text-zinc-600 hover:text-red-400 transition-colors ml-1">×</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <select value={selectedBatch} onChange={(e) => setSelectedBatch(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 min-w-[200px]">
              <option value="">Select a batch…</option>
              {availableBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batch_number != null ? `#${b.batch_number} · ` : ""}{b.beer_name}
                  {b.planned_brew_date ? ` (${b.planned_brew_date.slice(0, 7)})` : ""}
                </option>
              ))}
            </select>
            <button onClick={handleAdd} disabled={!selectedBatch || adding}
              className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-200 text-xs rounded transition-colors">
              {adding ? "Linking…" : "Link"}
            </button>
            {addError && <span className="text-xs text-red-400">{addError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Invoice sync panel ─────────────────────────────────────────────────────────

const INVOICE_LAST_SYNC_KEY = "tpb-invoices-last-sync";

function daysSince(isoStr: string): number {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

function InvoiceSyncPanel({ year, onSynced }: { year: number; onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ synced: number; updated: number; total: number; errors?: string[] } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(INVOICE_LAST_SYNC_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setLastSync(stored);
  }, []);

  async function handleSync() {
    setSyncing(true); setSyncError(null); setResult(null);
    try {
      const res = await fetch(`/api/finance/ledger/sync-square?year=${year}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) { setSyncError(json.error ?? "Sync failed"); return; }
      setResult(json);
      const now = new Date().toISOString();
      localStorage.setItem(INVOICE_LAST_SYNC_KEY, now);
      setLastSync(now);
      onSynced();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Network error");
    } finally { setSyncing(false); }
  }

  const days = lastSync != null ? daysSince(lastSync) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {days != null && (
        <span className={`text-xs ${days >= 7 ? "text-amber-400" : "text-zinc-500"}`}>
          Last sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      <button onClick={handleSync} disabled={syncing}
        className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap">
        {syncing ? "Syncing invoices…" : "Sync from Square"}
      </button>
      {syncError && <span className="text-xs text-red-400">{syncError}</span>}
      {result && (
        <span className="text-xs text-zinc-400">
          {result.synced > 0 && <span className="text-green-400 mr-1">{result.synced} new</span>}
          {result.updated > 0 && <span className="text-zinc-400 mr-1">{result.updated} updated</span>}
          {result.total === 0 && <span className="text-zinc-600">No invoices found</span>}
          {result.errors?.length ? <span className="text-red-400">{result.errors.length} errors</span> : null}
        </span>
      )}
    </div>
  );
}

type SortKey = "invoice_number" | "invoice_date" | "customer_name" | "source" | "total_cents" | "status";

function SortIcon({ k, sortKey, sortAsc }: { k: SortKey; sortKey: SortKey; sortAsc: boolean }) {
  return (
    <span className={`ml-1 ${sortKey === k ? "text-amber-400" : "text-zinc-700"}`}>
      {sortKey === k ? (sortAsc ? "↑" : "↓") : "↕"}
    </span>
  );
}

export default function InvoicesPage() {
  const currentYear = new Date().getFullYear();
  const [year,       setYear]   = useState(currentYear);
  const [source,     setSource] = useState<"all" | "square" | "quickbooks">("all");
  const [status,     setStatus] = useState<"all" | "open" | "paid" | "partial" | "voided" | "unknown">("all");
  const [typeFilter,    setTypeFilter]    = useState<"all" | InvoiceType>("all");
  const [mappingFilter, setMappingFilter] = useState<"all" | "mapped" | "partial" | "unmapped">("all");
  const [sortKey,    setSort]   = useState<SortKey>("invoice_date");
  const [sortAsc,    setSortAsc] = useState(false);
  const [accounts,     setAccounts]     = useState<CoARef[]>([]);
  const [batches,      setBatches]      = useState<BrewBatch[]>([]);
  const [autoMapping,  setAutoMapping]  = useState(false);
  const [autoMapResult, setAutoMapResult] = useState<{ mapped: number } | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    fetch("/api/finance/chart-of-accounts")
      .then((r) => r.json())
      .then((d: CoARef[]) => setAccounts(Array.isArray(d) ? d : []));
    fetch("/api/production/batches")
      .then((r) => r.json())
      .then((d: { id: string; batch_number: number | null; beer_name: string; planned_brew_date: string | null }[]) => {
        if (Array.isArray(d)) {
          setBatches(d.map((b) => ({ id: b.id, batch_number: b.batch_number, beer_name: b.beer_name, planned_brew_date: b.planned_brew_date })));
        }
      });
  }, []);

  async function handleAutoMap() {
    setAutoMapping(true); setAutoMapResult(null);
    const res = await fetch(`/api/finance/ledger/invoices/auto-map?year=${year}`, { method: "POST" });
    const json = await res.json();
    setAutoMapResult(json);
    if (json.mapped > 0) refetch();
    setAutoMapping(false);
  }

  async function handleSaveLineItem(id: string, patch: Record<string, string | null>) {
    await fetch("/api/finance/ledger/invoice-line-items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    refetch();
  }

  const params = new URLSearchParams({ year: String(year) });
  if (source !== "all") params.set("source", source);

  const { data: raw, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoices(year, source),
    queryFn:  () => fetchJson<InvoiceRow[]>(`/api/finance/ledger/invoices?${params}`),
  });

  // Client-side status + type + mapping filter + sort
  const invoices = (raw ?? [])
    .filter((inv) => status === "all" || inv.status === status)
    .filter((inv) => typeFilter === "all" || (inv as InvoiceRow).invoice_type === typeFilter)
    .filter((inv) => {
      if (mappingFilter === "all") return true;
      const items = (inv as InvoiceRow).invoice_line_items ?? [];
      if (items.length === 0) return mappingFilter === "unmapped";
      const mapped = items.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length;
      if (mappingFilter === "mapped")   return mapped === items.length;
      if (mappingFilter === "partial")  return mapped > 0 && mapped < items.length;
      if (mappingFilter === "unmapped") return mapped === 0;
      return true;
    })
    .sort((a, b) => {
      let diff = 0;
      if (sortKey === "invoice_number") diff = (a.invoice_number ?? a.external_id ?? "").localeCompare(b.invoice_number ?? b.external_id ?? "");
      else if (sortKey === "invoice_date") diff = (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "");
      else if (sortKey === "customer_name") diff = (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
      else if (sortKey === "source") diff = a.source.localeCompare(b.source);
      else if (sortKey === "total_cents") diff = a.total_cents - b.total_cents;
      else if (sortKey === "status") diff = a.status.localeCompare(b.status);
      return sortAsc ? diff : -diff;
    });

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSort(key); setSortAsc(false); }
  }

  // Summary stats
  const totalValue    = invoices.reduce((s, i) => s + i.total_cents, 0);
  const openValue     = invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.total_cents, 0);
  const unlinkedCount = invoices.filter((i) => (i.invoice_batch_links as unknown as { count: number }[])[0]?.count === 0).length;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <TransactionsNav />
      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">Invoices</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Square and QuickBooks invoices · map line items to GL accounts</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              <option value="all">All sources</option>
              <option value="square">Square</option>
              <option value="quickbooks">QuickBooks</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="voided">Voided</option>
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              <option value="all">All types</option>
              <option value="standard">Standard</option>
              <option value="allocation_deposit">Deposit invoices</option>
            </select>
            <select value={mappingFilter} onChange={(e) => setMappingFilter(e.target.value as typeof mappingFilter)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
              <option value="all">All GL mappings</option>
              <option value="mapped">Fully mapped</option>
              <option value="partial">Partially mapped</option>
              <option value="unmapped">Unmapped</option>
            </select>
            <InvoiceSyncPanel year={year} onSynced={() => refetch()} />
            <div className="flex items-center gap-2">
              <button onClick={handleAutoMap} disabled={autoMapping}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-xs rounded border border-zinc-700 transition-colors whitespace-nowrap">
                {autoMapping ? "Mapping…" : "Auto-map all"}
              </button>
              {autoMapResult && (
                <span className="text-xs">
                  {autoMapResult.mapped > 0
                    ? <span className="text-green-400">{autoMapResult.mapped} mapped</span>
                    : <span className="text-zinc-600">Nothing to map</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Summary bar */}
      {!isFetching && invoices.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-4 sm:gap-6 px-4 sm:px-6 py-3 border-b border-zinc-800/60 bg-zinc-900/30">
          <div>
            <span className="text-xs text-zinc-500">Invoices </span>
            <span className="text-sm font-semibold text-zinc-200">{invoices.length}</span>
          </div>
          <div>
            <span className="text-xs text-zinc-500">Total value </span>
            <span className="text-sm font-semibold text-zinc-200">${(totalValue / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
          </div>
          {openValue > 0 && (
            <div>
              <span className="text-xs text-zinc-500">Open </span>
              <span className="text-sm font-semibold text-amber-400">${(openValue / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
            </div>
          )}
          {unlinkedCount > 0 && (
            <div>
              <span className="text-xs text-zinc-500">Unlinked to batch </span>
              <span className="text-sm font-semibold text-zinc-400">{unlinkedCount}</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mx-6 mt-4 bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="w-6 px-2" />
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("invoice_number")}>
                  Invoice # <SortIcon k="invoice_number" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("invoice_date")}>
                  Date <SortIcon k="invoice_date" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("customer_name")}>
                  Customer <SortIcon k="customer_name" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("source")}>
                  Source / Type <SortIcon k="source" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("status")}>
                  Status <SortIcon k="status" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">GL / Categories</th>
                <th className="px-4 py-2 text-right text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("total_cents")}>
                  Total <SortIcon k="total_cents" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-center text-zinc-500 font-medium">Batches</th>
              </tr>
            </thead>
            <tbody>
              {isFetching ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-600">Loading…</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-zinc-600">
                  No invoices found.{" "}
                  <Link href="/finance/settings/import" className="text-amber-500 hover:text-amber-400 underline">Import or sync invoices →</Link>
                </td></tr>
              ) : (
                invoices.map((inv) => (
                  <InvoiceExpandableRow
                    key={inv.id}
                    inv={inv}
                    accounts={accounts}
                    batches={batches}
                    allInvoices={(raw ?? []).map((i) => ({ id: i.id, invoice_number: i.invoice_number ?? null, external_id: i.external_id ?? null, invoice_date: i.invoice_date ?? null, customer_name: i.customer_name ?? null, status: i.status }))}
                    onSaveLineItem={handleSaveLineItem}
                    onBatchChanged={() => refetch()}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
