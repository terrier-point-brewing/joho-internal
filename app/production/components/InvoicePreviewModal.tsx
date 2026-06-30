"use client";

import { useState } from "react";
import { Modal } from "./shared";
import { useInvoicePreview } from "../hooks/queries";
import { fmtUsd } from "@/lib/utils/formatting";

interface DraftLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId: string | null;
  discountCatalogId?: string | null;
}

export default function InvoicePreviewModal({
  transactionIds,
  onClose,
  onCreated,
}: {
  transactionIds: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { data, isLoading, error: previewError } = useInvoicePreview(transactionIds);
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Manual invoice mode ────────────────────────────────────────────────────
  const [invoiceMode, setInvoiceMode] = useState<"square" | "manual">("square");
  const [manualSource, setManualSource] = useState<"quickbooks" | "other">("quickbooks");
  const [manualRef, setManualRef] = useState("");
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));

  const effectiveLineItems = lineItems ?? data?.lineItems ?? [];

  function updateLine(id: string, patch: Partial<DraftLineItem>) {
    setLineItems(effectiveLineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }

  function removeLine(id: string) {
    setLineItems(effectiveLineItems.filter((li) => li.id !== id));
  }

  function addLine() {
    setLineItems([
      ...effectiveLineItems,
      { id: crypto.randomUUID(), description: "", quantity: 1, unitPriceCents: 0, squareCatalogVariationId: null },
    ]);
  }

  const totalCents = effectiveLineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

  const manualValid = totalCents > 0 && effectiveLineItems.length > 0 &&
    (manualSource === "other" || manualRef.trim().length > 0);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      if (invoiceMode === "square") {
        const res = await fetch("/api/production/export/invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "generate", transactionIds, lineItems: effectiveLineItems }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create invoice");
      } else {
        const res = await fetch("/api/production/export/invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record",
            transactionIds,
            source: manualSource,
            external_ref: manualRef.trim() || undefined,
            invoice_date: manualDate,
            total_cents: totalCents,
            lineItems: effectiveLineItems,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to record invoice");
      }
      onCreated();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  }

  const title = invoiceMode === "square"
    ? `Generate Invoice — ${data?.customerName ?? "…"}`
    : `Manual Invoice — ${data?.customerName ?? "…"}`;

  return (
    <Modal title={title} onClose={onClose} extraWide>
      {isLoading ? (
        <p className="text-sm text-muted">Loading line items…</p>
      ) : previewError ? (
        <p className="text-sm text-danger">{previewError instanceof Error ? previewError.message : "Failed to load preview"}</p>
      ) : (
        <div className="space-y-4">
          {/* ── Mode toggle ─────────────────────────────────────────────────── */}
          <div className="flex gap-1 p-0.5 bg-surface-mid rounded-lg w-fit">
            <button
              onClick={() => setInvoiceMode("square")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                invoiceMode === "square" ? "bg-surface-high text-primary" : "text-secondary hover:text-strong"
              }`}
            >
              Via Square
            </button>
            <button
              onClick={() => setInvoiceMode("manual")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                invoiceMode === "manual" ? "bg-surface-high text-primary" : "text-secondary hover:text-strong"
              }`}
            >
              Manual
            </button>
          </div>

          {/* ── Manual-only fields ──────────────────────────────────────────── */}
          {invoiceMode === "manual" && (
            <div className="rounded-lg bg-surface border border-line p-3 grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-secondary">Source</label>
                <select
                  value={manualSource}
                  onChange={(e) => setManualSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-secondary">
                  {manualSource === "quickbooks" ? <>QB Invoice # <span className="text-danger">*</span></> : "Reference # (optional)"}
                </label>
                <input
                  type="text"
                  value={manualRef}
                  onChange={(e) => setManualRef(e.target.value)}
                  placeholder={manualSource === "quickbooks" ? "e.g. INV-1042" : "e.g. PO-5678"}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong placeholder:text-faint"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-secondary">Invoice date</label>
                <input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                />
              </div>
            </div>
          )}

          {/* ── Line items ──────────────────────────────────────────────────── */}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface/50 text-left">
                  <th className="px-3 py-2 text-xs font-medium text-muted">Description</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right">Qty</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right">Unit Price</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted text-right">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {effectiveLineItems.map((li) => (
                  <tr key={li.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">
                      <input className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-64"
                        value={li.description} onChange={(e) => updateLine(li.id, { description: e.target.value })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="1" className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-16 text-right"
                        value={li.quantity} onChange={(e) => updateLine(li.id, { quantity: Number(e.target.value) })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="0.01" className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-24 text-right"
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        onChange={(e) => updateLine(li.id, { unitPriceCents: Math.round(Number(e.target.value) * 100) })} />
                    </td>
                    <td className="px-3 py-2 text-right text-body tabular-nums">
                      {fmtUsd((li.quantity * li.unitPriceCents) / 100)}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => removeLine(li.id)} className="text-xs text-faint hover:text-danger">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={addLine} className="text-xs px-2.5 py-1 border border-line-strong hover:border-line-subtle text-body rounded transition-colors">
            + Add line item
          </button>

          <div className="flex items-center justify-between pt-2 border-t border-line">
            <span className="text-sm text-secondary">Total</span>
            <span className="text-sm font-medium text-primary tabular-nums">{fmtUsd(totalCents / 100)}</span>
          </div>

          {invoiceMode === "manual" && (
            <p className="text-xs text-muted">
              Manual invoices are recorded as <span className="text-body">Unpaid</span> — use &ldquo;Mark Paid&rdquo; once payment is received.
            </p>
          )}

          {createError && <p className="text-xs text-danger">{createError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-sm text-secondary hover:text-strong" disabled={creating}>Cancel</button>
            <button
              onClick={handleCreate}
              disabled={creating || effectiveLineItems.length === 0 || (invoiceMode === "manual" && !manualValid)}
              className="text-sm px-3 py-1.5 bg-accent-emphasis hover:bg-accent-emphasis text-primary rounded transition-colors disabled:opacity-40"
            >
              {creating
                ? (invoiceMode === "square" ? "Generating…" : "Recording…")
                : (invoiceMode === "square" ? "Generate Invoice" : "Create Manual Invoice")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
