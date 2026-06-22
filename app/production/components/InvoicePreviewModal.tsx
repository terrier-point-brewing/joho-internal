"use client";

import { useState } from "react";
import { Modal } from "./shared";
import { useInvoicePreview } from "../hooks/queries";

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

  const effectiveLineItems = lineItems ?? data?.lineItems ?? [];

  function updateLine(id: string, patch: Partial<DraftLineItem>) {
    setLineItems((effectiveLineItems).map((li) => (li.id === id ? { ...li, ...patch } : li)));
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

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionIds, lineItems: effectiveLineItems }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to create invoice");
      }
      onCreated();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  }

  const totalCents = effectiveLineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

  return (
    <Modal title={`Generate Invoice — ${data?.customerName ?? "…"}`} onClose={onClose} extraWide>
      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading line items…</p>
      ) : previewError ? (
        <p className="text-sm text-red-400">{previewError instanceof Error ? previewError.message : "Failed to load preview"}</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500">Description</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Qty</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Unit Price</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {effectiveLineItems.map((li) => (
                  <tr key={li.id} className="border-b border-zinc-800 last:border-0">
                    <td className="px-3 py-2">
                      <input className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-64"
                        value={li.description} onChange={(e) => updateLine(li.id, { description: e.target.value })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="1" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-16 text-right"
                        value={li.quantity} onChange={(e) => updateLine(li.id, { quantity: Number(e.target.value) })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="0.01" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-24 text-right"
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        onChange={(e) => updateLine(li.id, { unitPriceCents: Math.round(Number(e.target.value) * 100) })} />
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">
                      ${((li.quantity * li.unitPriceCents) / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => removeLine(li.id)} className="text-xs text-zinc-600 hover:text-red-400">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={addLine} className="text-xs px-2.5 py-1 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded transition-colors">
            + Add line item
          </button>

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <span className="text-sm text-zinc-400">Total</span>
            <span className="text-sm font-medium text-zinc-100 tabular-nums">${(totalCents / 100).toFixed(2)}</span>
          </div>

          {createError && <p className="text-xs text-red-400">{createError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200" disabled={creating}>Cancel</button>
            <button onClick={handleCreate} disabled={creating || effectiveLineItems.length === 0}
              className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40">
              {creating ? "Creating…" : "Create & Send Invoice"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
