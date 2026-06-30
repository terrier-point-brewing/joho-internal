"use client";

import { useState } from "react";
import type { SquareCatalogOptions } from "@/app/production/types";

export function SquareCatalogSelect({
  items,
  itemId,
  variationId,
  onChange,
}: {
  items: SquareCatalogOptions["items"];
  itemId: string | null;
  variationId: string | null;
  onChange: (itemId: string | null, variationId: string | null) => void;
}) {
  // The backend requires item + variation together, so a freshly picked item
  // with no variation yet can't be persisted — track it locally until a
  // variation is chosen (or auto-resolve it when there's only one).
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const effectiveItemId = pendingItemId ?? itemId;
  const selectedItem = items.find((i) => i.itemId === effectiveItemId) ?? null;

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={effectiveItemId ?? ""}
        onChange={(e) => {
          const newItemId = e.target.value || null;
          if (!newItemId) {
            setPendingItemId(null);
            onChange(null, null);
            return;
          }
          const item = items.find((i) => i.itemId === newItemId) ?? null;
          if (item && item.variations.length === 1) {
            setPendingItemId(null);
            onChange(newItemId, item.variations[0].variationId);
          } else {
            setPendingItemId(newItemId);
          }
        }}
        className="inp-sm"
      >
        <option value="">— select item —</option>
        {items.map((i) => (
          <option key={i.itemId} value={i.itemId}>{i.itemName}</option>
        ))}
      </select>
      <select
        value={pendingItemId ? "" : (variationId ?? "")}
        disabled={!selectedItem}
        onChange={(e) => {
          const newVariationId = e.target.value || null;
          setPendingItemId(null);
          onChange(effectiveItemId, newVariationId);
        }}
        className="inp-sm disabled:opacity-40"
      >
        <option value="">— select variation —</option>
        {(selectedItem?.variations ?? []).map((v) => (
          <option key={v.variationId} value={v.variationId}>{v.variationName}</option>
        ))}
      </select>
    </div>
  );
}

export function SquareDiscountSelect({
  discounts,
  value,
  onChange,
}: {
  discounts: SquareCatalogOptions["discounts"];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="inp-sm"
    >
      <option value="">— select discount —</option>
      {discounts.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}
