"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice } from "@/types/finance";
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

interface InvoiceRow extends Omit<Invoice, "invoice_line_items"> {
  invoice_line_items: { category: string | null; total_cents: number }[];
  invoice_batch_links: { count: number }[];
  contract_brewing_partners: { company_name: string } | null;
}

type SortKey = "invoice_date" | "customer_name" | "total_cents" | "status";

export default function InvoicesPage() {
  const currentYear = new Date().getFullYear();
  const [year,       setYear]   = useState(currentYear);
  const [source,     setSource] = useState<"all" | "square" | "quickbooks">("all");
  const [status,     setStatus] = useState<"all" | "open" | "paid" | "partial" | "voided" | "unknown">("all");
  const [sortKey,    setSort]   = useState<SortKey>("invoice_date");
  const [sortAsc,    setSortAsc] = useState(false);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  const params = new URLSearchParams({ year: String(year) });
  if (source !== "all") params.set("source", source);

  const { data: raw, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoices(year, source),
    queryFn:  () => fetchJson<InvoiceRow[]>(`/api/finance/ledger/invoices?${params}`),
  });

  // Client-side status filter + sort (avoids extra API params for now)
  const invoices = (raw ?? [])
    .filter((inv) => status === "all" || inv.status === status)
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

  const SortIcon = ({ k }: { k: SortKey }) => (
    <span className={`ml-1 ${sortKey === k ? "text-amber-400" : "text-zinc-700"}`}>
      {sortKey === k ? (sortAsc ? "↑" : "↓") : "↕"}
    </span>
  );

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
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">Invoice #</th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("invoice_date")}>
                  Date <SortIcon k="invoice_date" />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("customer_name")}>
                  Customer <SortIcon k="customer_name" />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">Source</th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("status")}>
                  Status <SortIcon k="status" />
                </th>
                <th className="px-4 py-2 text-left text-zinc-500 font-medium">Categories</th>
                <th className="px-4 py-2 text-right text-zinc-500 font-medium cursor-pointer select-none hover:text-zinc-300"
                  onClick={() => handleSort("total_cents")}>
                  Total <SortIcon k="total_cents" />
                </th>
                <th className="px-4 py-2 text-center text-zinc-500 font-medium">Batches</th>
              </tr>
            </thead>
            <tbody>
              {isFetching ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-600">Loading…</td></tr>
              ) : invoices.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-600">
                  No invoices found.{" "}
                  <Link href="/finance/import" className="text-amber-500 hover:text-amber-400 underline">Import or sync invoices →</Link>
                </td></tr>
              ) : (
                invoices.map((inv) => {
                  const linkCount = (inv.invoice_batch_links as unknown as { count: number }[])[0]?.count ?? 0;
                  return (
                    <tr key={inv.id} className="border-t border-zinc-800/40 hover:bg-zinc-800/30 cursor-pointer">
                      <td className="px-4 py-2">
                        <Link href={`/finance/invoices/${inv.id}`} className="font-mono text-amber-400 hover:text-amber-300">
                          {inv.invoice_number ?? inv.external_id}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-zinc-400">{fmtDate(inv.invoice_date)}</td>
                      <td className="px-4 py-2 text-zinc-300">
                        {inv.contract_brewing_partners?.company_name ?? inv.customer_name ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          inv.source === "square" ? "bg-blue-900/40 text-blue-400" : "bg-violet-900/40 text-violet-400"
                        }`}>
                          {inv.source === "square" ? "Square" : "QuickBooks"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[inv.status] ?? STATUS_CLS.unknown}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <CategoryBar items={inv.invoice_line_items} />
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-zinc-200 tabular-nums">
                        {fmtDollars(inv.total_cents)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {linkCount > 0
                          ? <span className="text-green-400 font-medium">{linkCount}</span>
                          : <span className="text-zinc-600">—</span>
                        }
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
