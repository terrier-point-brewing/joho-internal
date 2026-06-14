"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceType } from "@/types/finance";
import FinanceNav from "../FinanceNav";

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

const CATEGORY_COLORS: Record<string, string> = {
  materials_packaging: "bg-blue-500",
  packaging_fees:      "bg-violet-500",
  other_services:      "bg-cyan-500",
  pass_through_taxes:  "bg-orange-500",
  distribution_keg:    "bg-emerald-500",
  distribution_can:    "bg-teal-500",
  other:               "bg-zinc-500",
};

// Mini stacked bar representing the invoice's category mix by dollar value
function CategoryBar({ items }: { items: { category: string | null; total_cents: number }[] }) {
  const total = items.reduce((s, li) => s + Math.abs(li.total_cents), 0);
  if (total === 0) return <span className="text-zinc-700 text-[10px]">—</span>;

  // Group by category
  const grouped: Record<string, number> = {};
  for (const li of items) {
    const k = li.category ?? "other";
    grouped[k] = (grouped[k] ?? 0) + Math.abs(li.total_cents);
  }

  return (
    <div className="flex h-2 w-24 rounded overflow-hidden gap-px" title={
      Object.entries(grouped).map(([k, v]) => `${k}: $${(v / 100).toFixed(0)}`).join("\n")
    }>
      {Object.entries(grouped).map(([cat, cents]) => (
        <div
          key={cat}
          className={`${CATEGORY_COLORS[cat] ?? "bg-zinc-500"} h-full`}
          style={{ width: `${(cents / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

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

function InvoiceExpandableRow({
  inv,
  accounts,
  onSaveLineItem,
}: {
  inv: InvoiceRow;
  accounts: CoARef[];
  onSaveLineItem: (id: string, coaId: string | null) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const linkCount = (inv.invoice_batch_links as unknown as { count: number }[])[0]?.count ?? 0;
  const lineItems = inv.invoice_line_items ?? [];
  const mappedCount = lineItems.filter((li) => li.chart_of_accounts_id).length;
  const allMapped = lineItems.length > 0 && mappedCount === lineItems.length;

  return (
    <>
      <tr
        className="border-t border-zinc-800/40 hover:bg-zinc-800/20 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}>
        <td className="px-4 py-2 w-6">
          <span className="text-zinc-600 text-[10px]">{expanded ? "▾" : "▸"}</span>
        </td>
        <td className="px-4 py-2">
          <Link href={`/finance/invoices/${inv.id}`} className="font-mono text-amber-400 hover:text-amber-300"
            onClick={(e) => e.stopPropagation()}>
            {inv.invoice_number ?? inv.external_id}
          </Link>
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
          {allMapped
            ? <span className="text-[10px] text-green-500">✓ all mapped</span>
            : mappedCount > 0
              ? <span className="text-[10px] text-amber-500">{mappedCount}/{lineItems.length}</span>
              : lineItems.length > 0
                ? <CategoryBar items={lineItems} />
                : <span className="text-zinc-700">—</span>}
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
                        onSave={onSaveLineItem}
                      />
                    ))}
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
  onSave,
}: {
  item: InvoiceLineItemRow;
  accounts: CoARef[];
  onSave: (id: string, coaId: string | null) => Promise<void>;
}) {
  const [coaId, setCoaId] = useState<string | null>(item.chart_of_accounts_id);
  const [saving, setSaving] = useState(false);

  async function handleChange(id: string | null) {
    setCoaId(id);
    setSaving(true);
    await onSave(item.id, id);
    setSaving(false);
  }

  return (
    <div className="grid grid-cols-[minmax(0,2fr)_60px_80px_80px_minmax(0,1fr)] gap-3 px-10 py-2 border-t border-zinc-800/30 text-xs items-center hover:bg-zinc-900/20">
      <div className="min-w-0">
        <span className="text-zinc-400 truncate block">{item.description}</span>
        {item.variation_name && <span className="text-[10px] text-zinc-600">{item.variation_name}</span>}
        {item.category && (
          <span className={`inline-block mt-0.5 px-1 py-0.5 rounded text-[9px] font-medium ${CATEGORY_CLS[item.category] ?? "bg-zinc-800 text-zinc-500"}`}>
            {item.category.replace(/_/g, " ")}
          </span>
        )}
      </div>
      <span className="text-zinc-600 text-right tabular-nums">{item.quantity ?? 1}×</span>
      <span className="text-zinc-500 text-right tabular-nums font-mono">
        {item.unit_price_cents ? "$" + (item.unit_price_cents / 100).toFixed(2) : "—"}
      </span>
      <span className="text-zinc-300 text-right tabular-nums font-mono">
        ${(item.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}
      </span>
      <div className="flex items-center gap-2">
        <CoASelect value={coaId} accounts={accounts} onChange={handleChange} />
        {saving && <span className="text-[10px] text-zinc-600 animate-pulse shrink-0">…</span>}
      </div>
    </div>
  );
}

const CATEGORY_CLS: Record<string, string> = {
  materials_packaging: "bg-blue-900/40 text-blue-300",
  packaging_fees:      "bg-violet-900/40 text-violet-300",
  other_services:      "bg-cyan-900/40 text-cyan-300",
  pass_through_taxes:  "bg-orange-900/40 text-orange-300",
  distribution_keg:    "bg-emerald-900/40 text-emerald-300",
  distribution_can:    "bg-teal-900/40 text-teal-300",
  other:               "bg-zinc-800 text-zinc-500",
};

type SortKey = "invoice_date" | "customer_name" | "total_cents" | "status";

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
  const [typeFilter, setTypeFilter] = useState<"all" | InvoiceType>("all");
  const [sortKey,    setSort]   = useState<SortKey>("invoice_date");
  const [sortAsc,    setSortAsc] = useState(false);
  const [accounts,   setAccounts] = useState<CoARef[]>([]);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    fetch("/api/finance/chart-of-accounts")
      .then((r) => r.json())
      .then((d: CoARef[]) => setAccounts(Array.isArray(d) ? d : []));
  }, []);

  async function handleSaveLineItem(id: string, coaId: string | null) {
    await fetch("/api/finance/ledger/invoice-line-items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, chart_of_accounts_id: coaId }),
    });
  }

  const params = new URLSearchParams({ year: String(year) });
  if (source !== "all") params.set("source", source);

  const { data: raw, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoices(year, source),
    queryFn:  () => fetchJson<InvoiceRow[]>(`/api/finance/ledger/invoices?${params}`),
  });

  // Client-side status + type filter + sort
  const invoices = (raw ?? [])
    .filter((inv) => status === "all" || inv.status === status)
    .filter((inv) => typeFilter === "all" || (inv as InvoiceRow).invoice_type === typeFilter)
    .sort((a, b) => {
      let diff = 0;
      if (sortKey === "invoice_date") diff = (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "");
      else if (sortKey === "customer_name") diff = (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
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
      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-4 border-b border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">Finance</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Admin only</p>
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
            <button onClick={() => refetch()}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors">
              Refresh
            </button>
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
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">Invoice #</th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("invoice_date")}>
                  Date <SortIcon k="invoice_date" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("customer_name")}>
                  Customer <SortIcon k="customer_name" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">Source / Type</th>
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
                    onSaveLineItem={handleSaveLineItem}
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
