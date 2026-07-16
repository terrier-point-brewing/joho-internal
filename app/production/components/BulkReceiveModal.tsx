"use client";

import { useState } from "react";
import { Modal, Field, ModalActions } from "./shared";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { fmtUsd } from "@/lib/utils/formatting";

export interface BulkReceiveItem {
  id: string;
  name: string;
  unit: string | null;
}

export interface BulkReceiveModalProps {
  itemType: "ingredient" | "packaging";
  items: BulkReceiveItem[];
  onClose: () => void;
  onDone: () => Promise<void>;
}

interface Row {
  itemId: string;
  quantity: string;
  totalCost: string;
}

const EMPTY_ROW: Row = { itemId: "", quantity: "", totalCost: "" };

export default function BulkReceiveModal({ itemType, items, onClose, onDone }: BulkReceiveModalProps) {
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [freightTotal, setFreightTotal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemsById = new Map(items.map((it) => [it.id, it]));
  const chosenIds = new Set(rows.map((r) => r.itemId).filter(Boolean));

  function addRow() {
    setRows((rs) => [...rs, { ...EMPTY_ROW }]);
  }
  function removeRow(idx: number) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, i) => i !== idx)));
  }
  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  const freightNum = parseFloat(freightTotal) || 0;
  const previewShipping = allocateFreightByWeight(
    rows.map((r) => ({
      unit: itemType === "ingredient" ? itemsById.get(r.itemId)?.unit ?? "" : "",
      quantity: parseFloat(r.quantity) || 0,
    })),
    freightNum
  );

  const rowsValid =
    rows.length > 0 &&
    chosenIds.size === rows.length &&
    rows.every((r) => r.itemId && parseFloat(r.quantity) > 0 && parseFloat(r.totalCost) > 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rowsValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const idKey = itemType === "ingredient" ? "ingredient_id" : "packaging_item_id";
      const endpoint =
        itemType === "ingredient"
          ? "/api/production/stock-adjustments/bulk"
          : "/api/production/packaging-adjustments/bulk";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: rows.map((r) => {
            const quantity = parseFloat(r.quantity);
            return {
              [idKey]: r.itemId,
              quantity,
              purchase_cost: parseFloat(r.totalCost) / quantity,
            };
          }),
          freight_total: freightNum,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk receive failed");
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        throw new Error(json.errors.map((e: { error: string }) => e.error).join("; "));
      }
      await onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Bulk Receive — ${itemType === "ingredient" ? "Ingredients" : "Packaging"}`}
      onClose={onClose}
      extraWide
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-3 py-2 text-xs font-medium text-muted">Item</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right">Quantity</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Total Cost ($)</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Allocated Freight</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Purchase $/Unit</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Freight $/Unit</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Total $/Unit</th>
                <th className="px-3 py-2 text-xs font-medium text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const qty = parseFloat(row.quantity) || 0;
                const totalCost = parseFloat(row.totalCost) || 0;
                const allocatedFreight = previewShipping[idx] ?? 0;
                const purchaseCostPerUnit = qty > 0 ? totalCost / qty : null;
                const freightCostPerUnit = qty > 0 ? allocatedFreight / qty : null;
                const totalCostPerUnit =
                  purchaseCostPerUnit != null && freightCostPerUnit != null
                    ? purchaseCostPerUnit + freightCostPerUnit
                    : null;
                return (
                  <tr key={idx} className="border-b border-line/60 last:border-0">
                    <td className="px-2 py-1.5">
                      <select
                        className="inp text-sm w-full"
                        value={row.itemId}
                        onChange={(e) => updateRow(idx, { itemId: e.target.value })}
                      >
                        <option value="">— select —</option>
                        {items
                          .filter((it) => it.id === row.itemId || !chosenIds.has(it.id))
                          .map((it) => (
                            <option key={it.id} value={it.id}>{it.name}</option>
                          ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.001" min="0" className="inp text-sm w-full text-right tabular-nums"
                        placeholder="0" value={row.quantity}
                        onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number" step="0.01" min="0" className="inp text-sm w-full text-right tabular-nums"
                        placeholder="0.00" value={row.totalCost}
                        onChange={(e) => updateRow(idx, { totalCost: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary whitespace-nowrap">
                      {fmtUsd(allocatedFreight)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary whitespace-nowrap">
                      {purchaseCostPerUnit != null ? fmtUsd(purchaseCostPerUnit) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-secondary whitespace-nowrap">
                      {freightCostPerUnit != null ? fmtUsd(freightCostPerUnit) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-strong font-medium whitespace-nowrap">
                      {totalCostPerUnit != null ? fmtUsd(totalCostPerUnit) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button" onClick={() => removeRow(idx)} disabled={rows.length === 1}
                        className="text-xs text-faint hover:text-danger transition-colors disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          type="button" onClick={addRow}
          className="text-xs text-accent-emphasis hover:text-accent transition-colors font-medium"
        >
          + Add item
        </button>

        <Field label="Total Freight / Shared Charges ($)">
          <input
            type="number" step="0.01" min="0" className="inp" placeholder="0.00"
            value={freightTotal} onChange={(e) => setFreightTotal(e.target.value)}
          />
          <p className="text-xs mt-1 text-muted">
            Split across the items above proportional to weight (derived from each item&apos;s unit where possible).
            Each row&apos;s <span className="text-secondary">Total $/Unit</span> (purchase + freight) is blended
            with existing stock as a weighted average to produce the new Cost/Unit shown on the {itemType === "ingredient" ? "Ingredients" : "Packaging"} table.
          </p>
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <ModalActions submitting={submitting} onCancel={onClose} label="Record Bulk Receive" disabled={!rowsValid} />
      </form>
    </Modal>
  );
}
