"use client";

import React, { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery, useExportServiceMappingsQuery, useExportSquareCatalogQuery } from "../hooks/queries";
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
  brew_batches: { id: string; beer_name: string; batch_number: string } | null;
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
  square_dashboard_url: string | null;
  subtotal_cents: number;
  total_cents: number;
  line_items: InvoiceLineItem[];
  shipments: InvoiceShipment[];
}

interface ExportInvoicesTabProps {
  highlightInvoiceId?: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-surface-mid text-secondary",
  open: "bg-accent-muted/40 text-accent",
  paid: "bg-success-surface/40 text-success",
  voided: "bg-danger-surface/40 text-danger",
  partial: "bg-info-surface/40 text-info",
  unknown: "bg-surface-mid text-muted",
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

function InvoiceExpandedPanel({
  invoice,
  onRefresh,
}: {
  invoice: ExportInvoiceListItem;
  onRefresh: () => void;
}) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [addPrice, setAddPrice] = useState("");
  const [addMappingId, setAddMappingId] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Inline line-item editing (Draft only).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editQty, setEditQty] = useState("1");
  const [editPrice, setEditPrice] = useState("");

  const isDraft = invoice.status === "draft";
  const isSquare = invoice.source === "square";
  const isPaid = invoice.status === "paid";

  // Resolve a Square catalog variation ID to its "Item · Variation" name so the
  // panel shows the same label the generate-invoice UI does. The user-entered
  // description then reads as the line's note beneath it.
  const variationName = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of catalog?.items ?? []) {
      for (const v of it.variations) {
        m.set(v.variationId, `${it.itemName}${v.variationName ? ` · ${v.variationName}` : ""}`);
      }
    }
    return m;
  }, [catalog]);

  // Service mappings with a Square variation (usable as line items)
  const selectableMappings = mappings.filter(
    (m) => m.square_catalog_variation_id &&
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
    if (!confirm("Remove this line item? The Square draft will be cancelled and recreated.")) return;
    await patchLineItem({ action: "remove", line_item_id: lineItemId });
  }

  function startEdit(li: InvoiceLineItem) {
    setEditingId(li.id);
    setEditDesc(li.description ?? "");
    setEditQty(String(li.quantity));
    setEditPrice((li.unit_price_cents / 100).toFixed(2));
    setActionError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(lineItemId: string) {
    const quantity = Number(editQty);
    const unitPriceCents = Math.round(parseFloat(editPrice) * 100);
    if (!quantity || quantity <= 0 || isNaN(unitPriceCents) || unitPriceCents < 0) {
      setActionError("Quantity must be positive and unit price non-negative");
      return;
    }
    await patchLineItem({
      action: "edit",
      line_item_id: lineItemId,
      description: editDesc,
      quantity,
      unit_price_cents: unitPriceCents,
    });
    setEditingId(null);
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
        squareCatalogVariationId = mapping.square_catalog_variation_id ?? null;
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

  const panelClass = "rounded border border-line bg-surface/40 p-3 space-y-2";

  return (
    <div className="px-4 pb-4 space-y-3">
      {/* Metadata */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Invoice Details</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <span className="text-muted">Customer</span>
          <span className="text-strong">{invoice.partner_name ?? invoice.customer_name ?? "—"}</span>
          <span className="text-muted">Issued</span>
          <span className="text-body">{invoice.invoice_date ? fmt(invoice.invoice_date) : "—"}</span>
          <span className="text-muted">Status</span>
          <span>
            <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[invoice.status]}`}>
              {STATUS_LABEL[invoice.status] ?? invoice.status}
            </span>
          </span>
          <span className="text-muted">Source</span>
          <span className="text-body capitalize">{invoice.source}</span>
          {isSquare && invoice.square_dashboard_url && (
            <React.Fragment>
              <span className="text-muted">Square</span>
              <a
                href={invoice.square_dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent hover:text-accent-soft underline"
              >
                View in Square →
              </a>
            </React.Fragment>
          )}
        </div>
      </div>

      {/* Included Shipments */}
      {invoice.shipments.length > 0 && (
        <div className={panelClass}>
          <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Included Shipments</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted border-b border-line">
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
                <tr key={s.id} className="border-b border-line/50 last:border-0">
                  <td className="py-1 text-secondary">{fmt(s.created_at)}</td>
                  <td className="py-1 text-strong">
                    {s.brew_batches ? `#${s.brew_batches.batch_number} ${s.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="py-1 text-secondary">{CHANNEL_LABELS[s.channel] ?? s.channel}</td>
                  <td className="py-1">
                    <span className="px-1 py-0.5 rounded bg-surface-mid text-body">{s.variant_label}</span>
                  </td>
                  <td className="py-1 text-right text-strong">{s.quantity}</td>
                  <td className="py-1 text-right text-secondary">{s.volume_bbl.toFixed(3)} bbl</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Line Items */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Line Items</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted border-b border-line">
              <th className="pb-1">Item / Note</th>
              <th className="pb-1 text-right">Qty</th>
              <th className="pb-1 text-right">Unit Price</th>
              <th className="pb-1 text-right">Total</th>
              {isDraft && <th className="pb-1 w-14 text-right" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {invoice.line_items.map((li) => {
              const catName = li.square_catalog_variation_id
                ? variationName.get(li.square_catalog_variation_id) ?? null
                : null;
              const isEditing = editingId === li.id;
              const inpCls = "bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong";

              if (isEditing) {
                const liveQty = Number(editQty);
                const liveCents = Math.round(parseFloat(editPrice) * 100);
                const liveTotal = !isNaN(liveQty) && !isNaN(liveCents) ? liveQty * liveCents : 0;
                return (
                  <tr key={li.id} className="border-b border-line/50 last:border-0 align-top">
                    <td className="py-1 pr-2">
                      {catName && <div className="text-strong mb-1">{catName}</div>}
                      <input
                        type="text"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="Item note / description"
                        className={`${inpCls} w-full`}
                        aria-label="Line item note"
                      />
                    </td>
                    <td className="py-1 text-right">
                      <input
                        type="number" min="1"
                        value={editQty}
                        onChange={(e) => setEditQty(e.target.value)}
                        className={`${inpCls} w-14 text-right`}
                        aria-label="Quantity"
                      />
                    </td>
                    <td className="py-1 text-right">
                      <input
                        type="number" min="0" step="0.01"
                        value={editPrice}
                        onChange={(e) => setEditPrice(e.target.value)}
                        className={`${inpCls} w-20 text-right`}
                        aria-label="Unit price"
                      />
                    </td>
                    <td className="py-1 text-right text-body">{fmtUsd(liveTotal / 100)}</td>
                    <td className="py-1 text-right whitespace-nowrap">
                      <button
                        onClick={() => saveEdit(li.id)}
                        disabled={actionLoading}
                        className="text-success hover:text-success/80 disabled:opacity-30 mr-1.5"
                        aria-label="Save line item"
                      >
                        {actionLoading ? "…" : "✓"}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={actionLoading}
                        className="text-faint hover:text-body disabled:opacity-30"
                        aria-label="Cancel edit"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={li.id} className="border-b border-line/50 last:border-0 align-top">
                  <td className="py-1">
                    <div className="text-strong">{catName ?? li.description ?? "—"}</div>
                    {catName && li.description && (
                      <div className="text-[11px] text-muted">Note: {li.description}</div>
                    )}
                  </td>
                  <td className="py-1 text-right text-secondary">{li.quantity}</td>
                  <td className="py-1 text-right text-secondary">{fmtUsd(li.unit_price_cents / 100)}</td>
                  <td className="py-1 text-right text-body">{fmtUsd(li.total_cents / 100)}</td>
                  {isDraft && (
                    <td className="py-1 text-right whitespace-nowrap">
                      <button
                        onClick={() => startEdit(li)}
                        disabled={actionLoading || !!editingId}
                        className="text-faint hover:text-accent disabled:opacity-30 mr-1.5"
                        aria-label="Edit line item"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => removeLineItem(li.id)}
                        disabled={actionLoading || !!editingId}
                        className="text-faint hover:text-danger disabled:opacity-30"
                        aria-label="Remove line item"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex justify-end pt-1 border-t border-line mt-1">
          <span className="text-xs text-secondary">
            Total: <span className="text-primary font-medium">{fmtUsd(invoice.total_cents / 100)}</span>
          </span>
        </div>

        {/* Add line item (Draft only) */}
        {isDraft && (
          <div className="mt-2 pt-2 border-t border-line">
            {!addOpen ? (
              <button
                onClick={() => setAddOpen(true)}
                className="text-xs text-accent-emphasis hover:text-accent transition-colors"
              >
                + Add line item
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label htmlFor="add-mapping" className="sr-only">Service mapping</label>
                  <select
                    id="add-mapping"
                    value={addMappingId}
                    onChange={(e) => {
                      setAddMappingId(e.target.value);
                      if (e.target.value) setAddDesc("");
                    }}
                    className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong flex-1"
                  >
                    <option value="">Custom line item</option>
                    {selectableMappings.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <label htmlFor="add-desc" className="sr-only">Description</label>
                  <input
                    id="add-desc"
                    type="text"
                    placeholder="Description"
                    value={addDesc}
                    onChange={(e) => setAddDesc(e.target.value)}
                    className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong flex-1"
                  />
                  <label htmlFor="add-qty" className="sr-only">Quantity</label>
                  <input
                    id="add-qty"
                    type="number"
                    placeholder="Qty"
                    value={addQty}
                    min="1"
                    onChange={(e) => setAddQty(e.target.value)}
                    className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-16"
                  />
                  <label htmlFor="add-price" className="sr-only">Unit price</label>
                  <input
                    id="add-price"
                    type="number"
                    placeholder="Unit price ($)"
                    value={addPrice}
                    min="0"
                    step="0.01"
                    onChange={(e) => setAddPrice(e.target.value)}
                    className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-28"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={addLineItem}
                    disabled={actionLoading || (!addDesc && !addMappingId) || !addPrice}
                    className="btn-ghost btn-xs"
                  >
                    {actionLoading ? "Adding…" : "Add"}
                  </button>
                  <button
                    onClick={() => {
                      setAddOpen(false); setAddDesc(""); setAddQty("1");
                      setAddPrice(""); setAddMappingId("");
                    }}
                    className="text-xs text-muted hover:text-body"
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
              className="btn-amber btn-xs"
            >
              {actionLoading ? "Sending…" : "Send Invoice"}
            </button>
          )}
          {isSquare && !isPaid && !isDraft && (
            <button
              onClick={handleSync}
              disabled={actionLoading}
              className="btn-ghost btn-xs"
            >
              {actionLoading ? "Syncing…" : "Sync from Square"}
            </button>
          )}
          {actionError && <span className="text-xs text-danger">{actionError}</span>}
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

  // Sync expanded state when highlightInvoiceId changes from parent.
  // React-recommended pattern: track previous prop in state and call setState
  // during render (React retries immediately, no extra browser paint).
  const [prevHighlight, setPrevHighlight] = useState(highlightInvoiceId);
  if (prevHighlight !== highlightInvoiceId) {
    setPrevHighlight(highlightInvoiceId);
    if (highlightInvoiceId) setExpandedId(highlightInvoiceId);
  }

  const partnerNames = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  const years = useMemo(() => {
    const ys = new Set(
      invoices.map((inv) => inv.invoice_date?.slice(0, 4)).filter(Boolean) as string[]
    );
    return [...ys].sort().reverse();
  }, [invoices]);

  // partnerNames used in filter dropdown via partners list directly
  void partnerNames;

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
        <label htmlFor="inv-customer-filter" className="sr-only">Filter by customer</label>
        <select
          id="inv-customer-filter"
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong"
        >
          <option value="all">All Customers</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>{p.company_name}</option>
          ))}
        </select>

        <label htmlFor="inv-status-filter" className="sr-only">Filter by status</label>
        <select
          id="inv-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong"
        >
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Sent / Open</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
        </select>

        <label htmlFor="inv-year-filter" className="sr-only">Filter by year</label>
        <select
          id="inv-year-filter"
          value={yearFilter === "all" ? "all" : String(yearFilter)}
          onChange={(e) => setYearFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong"
        >
          <option value="all">All Years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-2 bg-surface/60 border border-line rounded text-xs">
        <span className="text-secondary">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        <span className="text-muted">|</span>
        <span className="text-secondary">
          <span className="text-accent-soft font-medium">{fmtUsd(openTotal / 100)}</span> open
        </span>
        <span className="text-muted">|</span>
        <span className="text-secondary">
          <span className="text-strong font-medium">{fmtUsd(grandTotal / 100)}</span> total
        </span>
      </div>

      {/* Expandable table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-faint">No invoices match the current filters.</p>
      ) : (
        <div className="rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 w-6" aria-label="Expand" />
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Invoice #</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.id;
                return (
                  <React.Fragment key={inv.id}>
                    <tr
                      className="border-b border-line hover:bg-surface/30 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                    >
                      <td className="px-4 py-2.5 text-muted text-xs">{isExpanded ? "▾" : "▸"}</td>
                      <td className="px-4 py-2.5 text-strong font-mono">
                        {inv.invoice_number ? `#${inv.invoice_number}` : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-secondary whitespace-nowrap">
                        {inv.invoice_date ? fmt(inv.invoice_date) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-body">
                        {inv.partner_name ?? inv.customer_name ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[inv.status]}`}>
                          {STATUS_LABEL[inv.status] ?? inv.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-strong font-medium tabular-nums">
                        {fmtUsd(inv.total_cents / 100)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-line bg-surface/20">
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
