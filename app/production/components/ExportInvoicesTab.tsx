"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery, useExportServiceMappingsQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { fmtUsd } from "@/lib/utils/formatting";

interface InvoiceLineItem {
  id: string;
  sort_order: number;
  description: string | null;
  category: string | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  square_catalog_variation_id: string | null;
}

interface InvoiceShipment {
  id: string;
  channel: string;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

interface ExportInvoiceListItem {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  customer_name: string | null;
  partner_id: string | null;
  partner_name: string | null;
  status: "draft" | "open" | "paid" | "voided" | "partial" | "unknown";
  source: "square" | "quickbooks";
  square_invoice_id: string | null;
  subtotal_cents: number;
  total_cents: number;
  line_items: InvoiceLineItem[];
  shipments: InvoiceShipment[];
}

interface ExportInvoicesTabProps {
  highlightInvoiceId?: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-800 text-zinc-400",
  open: "bg-amber-900/40 text-amber-400",
  paid: "bg-emerald-900/40 text-emerald-400",
  voided: "bg-red-900/40 text-red-400",
  partial: "bg-blue-900/40 text-blue-300",
  unknown: "bg-zinc-800 text-zinc-500",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Sent / Open",
  paid: "Paid",
  voided: "Voided",
  partial: "Partial",
  unknown: "Unknown",
};

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ViewInSquareButton({ squareInvoiceId }: { squareInvoiceId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/production/export/invoice-status?invoiceId=${squareInvoiceId}`);
      const data = await res.json();
      if (!res.ok || !data.publicUrl) { setError("Link unavailable"); return; }
      window.open(data.publicUrl, "_blank");
    } catch { setError("Failed"); }
    finally { setLoading(false); }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button onClick={open} disabled={loading}
        className="text-xs text-amber-400 hover:text-amber-300 underline disabled:opacity-50">
        {loading ? "Loading…" : "View in Square →"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

function InvoiceExpandedPanel({
  invoice,
  onRefresh,
}: {
  invoice: ExportInvoiceListItem;
  onRefresh: () => void;
}) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [addPrice, setAddPrice] = useState("");
  const [addMappingId, setAddMappingId] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isDraft = invoice.status === "draft";
  const isSquare = invoice.source === "square";
  const isPaid = invoice.status === "paid";

  // Service mappings with a Square variation (usable as line items)
  const selectableMappings = mappings.filter(
    (m) => m.square_catalog_variation_id && m.service_type !== "bulk_discount" &&
      m.service_type !== "distribution_discount" && m.service_type !== "wholesale_discount"
  );

  async function patchLineItem(body: Record<string, unknown>) {
    setActionLoading(true); setActionError(null);
    try {
      const res = await fetch(`/api/production/export/invoices/${invoice.id}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed");
    } finally { setActionLoading(false); }
  }

  async function removeLineItem(lineItemId: string) {
    if (!confirm("Remove this line item?")) return;
    await patchLineItem({ action: "remove", line_item_id: lineItemId });
  }

  async function addLineItem() {
    if (!addDesc && !addMappingId) return;
    let description = addDesc;
    let squareCatalogVariationId: string | null = null;
    const unitPriceCents = Math.round(parseFloat(addPrice) * 100);

    if (addMappingId) {
      const mapping = selectableMappings.find((m) => m.id === addMappingId);
      if (mapping) {
        description = description || mapping.display_name;
        squareCatalogVariationId = mapping.square_catalog_variation_id;
      }
    }

    await patchLineItem({
      action: "add",
      description,
      quantity: Number(addQty) || 1,
      unit_price_cents: unitPriceCents,
      square_catalog_variation_id: squareCatalogVariationId,
    });
    setAddDesc(""); setAddQty("1"); setAddPrice(""); setAddMappingId(""); setAddOpen(false);
  }

  async function handleSend() {
    if (!confirm("Send this invoice to the customer via email?")) return;
    setActionLoading(true); setActionError(null);
    try {
      const txIds = invoice.shipments.map((s) => s.id);
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", transactionIds: txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to send");
    } finally { setActionLoading(false); }
  }

  async function handleSync() {
    setActionLoading(true); setActionError(null);
    try {
      const txIds = invoice.shipments.map((s) => s.id);
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", transactionIds: txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to sync");
    } finally { setActionLoading(false); }
  }

  const panelClass = "rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-2";

  return (
    <div className="px-4 pb-4 space-y-3">
      {/* Metadata */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Invoice Details</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <span className="text-zinc-500">Customer</span>
          <span className="text-zinc-200">{invoice.partner_name ?? invoice.customer_name ?? "—"}</span>
          <span className="text-zinc-500">Issued</span>
          <span className="text-zinc-300">{invoice.invoice_date ? fmt(invoice.invoice_date) : "—"}</span>
          <span className="text-zinc-500">Status</span>
          <span className="inline-flex items-center gap-1">
            <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[invoice.status]}`}>
              {STATUS_LABEL[invoice.status] ?? invoice.status}
            </span>
          </span>
          <span className="text-zinc-500">Source</span>
          <span className="text-zinc-300 capitalize">{invoice.source}</span>
          {isSquare && invoice.square_invoice_id && (
            <>
              <span className="text-zinc-500">Square ID</span>
              <ViewInSquareButton squareInvoiceId={invoice.square_invoice_id} />
            </>
          )}
        </div>
        <a
          href="/finance/invoices"
          className="text-xs text-amber-400 hover:text-amber-300 underline mt-1 inline-block"
        >
          View in Finance →
        </a>
      </div>

      {/* Included Shipments */}
      {invoice.shipments.length > 0 && (
        <div className={panelClass}>
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Included Shipments</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-1">Date</th>
                <th className="pb-1">Batch</th>
                <th className="pb-1">Channel</th>
                <th className="pb-1">Packaging</th>
                <th className="pb-1 text-right">Qty</th>
                <th className="pb-1 text-right">Volume</th>
              </tr>
            </thead>
            <tbody>
              {invoice.shipments.map((s) => (
                <tr key={s.id} className="border-b border-zinc-800/50 last:border-0">
                  <td className="py-1 text-zinc-400">{fmt(s.created_at)}</td>
                  <td className="py-1 text-zinc-200">
                    {s.brew_batches ? `#${s.brew_batches.batch_number} ${s.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="py-1 text-zinc-400">{CHANNEL_LABELS[s.channel] ?? s.channel}</td>
                  <td className="py-1">
                    <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300">{s.variant_label}</span>
                  </td>
                  <td className="py-1 text-right text-zinc-200">{s.quantity}</td>
                  <td className="py-1 text-right text-zinc-400">{s.volume_bbl.toFixed(3)} bbl</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Line Items */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Line Items</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="pb-1">Description</th>
              <th className="pb-1 text-right">Qty</th>
              <th className="pb-1 text-right">Unit Price</th>
              <th className="pb-1 text-right">Total</th>
              {isDraft && <th className="pb-1 w-4" />}
            </tr>
          </thead>
          <tbody>
            {invoice.line_items.map((li) => (
              <tr key={li.id} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-1 text-zinc-200">{li.description ?? "—"}</td>
                <td className="py-1 text-right text-zinc-400">{li.quantity}</td>
                <td className="py-1 text-right text-zinc-400">{fmtUsd(li.unit_price_cents / 100)}</td>
                <td className="py-1 text-right text-zinc-300">{fmtUsd(li.total_cents / 100)}</td>
                {isDraft && (
                  <td className="py-1 text-right">
                    <button
                      onClick={() => removeLineItem(li.id)}
                      disabled={actionLoading}
                      className="text-zinc-600 hover:text-red-400 disabled:opacity-30"
                      title="Remove line item"
                    >
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end pt-1 border-t border-zinc-800 mt-1">
          <span className="text-xs text-zinc-400">Total: <span className="text-zinc-100 font-medium">{fmtUsd(invoice.total_cents / 100)}</span></span>
        </div>

        {/* Add line item (Draft only) */}
        {isDraft && (
          <div className="mt-2 pt-2 border-t border-zinc-800">
            {!addOpen ? (
              <button
                onClick={() => setAddOpen(true)}
                className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
              >
                + Add line item
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select
                    value={addMappingId}
                    onChange={(e) => {
                      setAddMappingId(e.target.value);
                      if (e.target.value) setAddDesc("");
                    }}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 flex-1"
                  >
                    <option value="">Custom line item</option>
                    {selectableMappings.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Description"
                    value={addDesc}
                    onChange={(e) => setAddDesc(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 flex-1"
                  />
                  <input
                    type="number"
                    placeholder="Qty"
                    value={addQty}
                    min="1"
                    onChange={(e) => setAddQty(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-16"
                  />
                  <input
                    type="number"
                    placeholder="Unit price ($)"
                    value={addPrice}
                    min="0"
                    step="0.01"
                    onChange={(e) => setAddPrice(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-28"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={addLineItem}
                    disabled={actionLoading || (!addDesc && !addMappingId) || !addPrice}
                    className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
                  >
                    {actionLoading ? "Adding…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddOpen(false); setAddDesc(""); setAddQty("1"); setAddPrice(""); setAddMappingId(""); }}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {(isDraft || (isSquare && !isPaid)) && (
        <div className={`${panelClass} flex items-center gap-2`}>
          {isDraft && (
            <button
              onClick={handleSend}
              disabled={actionLoading}
              className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40"
            >
              {actionLoading ? "Sending…" : "Send Invoice"}
            </button>
          )}
          {isSquare && !isPaid && !isDraft && (
            <button
              onClick={handleSync}
              disabled={actionLoading}
              className="text-xs px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
            >
              {actionLoading ? "Syncing…" : "Sync from Square"}
            </button>
          )}
          {actionError && <span className="text-xs text-red-400">{actionError}</span>}
        </div>
      )}
    </div>
  );
}

export default function ExportInvoicesTab({ highlightInvoiceId }: ExportInvoicesTabProps) {
  const qc = useQueryClient();
  const { data: invoices = [] } = useQuery({
    queryKey: queryKeys.production.exportInvoices(),
    queryFn: () => fetchJson<ExportInvoiceListItem[]>("/api/production/export/invoices"),
  });
  const { data: partners = [] } = useContractPartnersQuery();

  const [expandedId, setExpandedId] = useState<string | null>(highlightInvoiceId ?? null);
  const [customerFilter, setCustomerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState<number | "all">("all");

  // Auto-expand highlighted invoice on mount
  useEffect(() => {
    if (highlightInvoiceId) setExpandedId(highlightInvoiceId);
  }, [highlightInvoiceId]);

  const years = useMemo(() => {
    const ys = new Set(invoices.map((inv) => inv.invoice_date?.slice(0, 4)).filter(Boolean) as string[]);
    return [...ys].sort().reverse();
  }, [invoices]);

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (customerFilter !== "all" && inv.partner_id !== customerFilter) return false;
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      if (yearFilter !== "all" && inv.invoice_date?.slice(0, 4) !== String(yearFilter)) return false;
      return true;
    });
  }, [invoices, customerFilter, statusFilter, yearFilter]);

  const openTotal = filtered
    .filter((inv) => inv.status === "open" || inv.status === "draft")
    .reduce((s, inv) => s + inv.total_cents, 0);
  const grandTotal = filtered.reduce((s, inv) => s + inv.total_cents, 0);

  function refresh() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Customers</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>{p.company_name}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Sent / Open</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
          <option value="partial">Partial</option>
        </select>

        <select
          value={yearFilter === "all" ? "all" : String(yearFilter)}
          onChange={(e) => setYearFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-2 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
        <span className="text-zinc-400">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        <span className="text-zinc-500">|</span>
        <span className="text-zinc-400"><span className="text-amber-300 font-medium">{fmtUsd(openTotal / 100)}</span> open</span>
        <span className="text-zinc-500">|</span>
        <span className="text-zinc-400"><span className="text-zinc-200 font-medium">{fmtUsd(grandTotal / 100)}</span> total</span>
      </div>

      {/* Expandable table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-600">No invoices match the current filters.</p>
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 w-6" />
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Invoice #</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.id;
                return (
                  <React.Fragment key={inv.id}>
                    <tr
                      className="border-b border-zinc-800 hover:bg-zinc-900/30 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                    >
                      <td className="px-4 py-2.5 text-zinc-500 text-xs">{isExpanded ? "▾" : "▸"}</td>
                      <td className="px-4 py-2.5 text-zinc-200 font-mono">
                        {inv.invoice_number ? `#${inv.invoice_number}` : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">
                        {inv.invoice_date ? fmt(inv.invoice_date) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-300">
                        {inv.partner_name ?? inv.customer_name ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[inv.status]}`}>
                          {STATUS_LABEL[inv.status] ?? inv.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-200 font-medium tabular-nums">
                        {fmtUsd(inv.total_cents / 100)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${inv.id}-expanded`} className="border-b border-zinc-800 bg-zinc-900/20">
                        <td colSpan={6} className="p-0">
                          <InvoiceExpandedPanel invoice={inv} onRefresh={refresh} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
