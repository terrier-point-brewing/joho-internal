"use client";

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
  const selectedItem = items.find((i) => i.itemId === itemId) ?? null;

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={itemId ?? ""}
        onChange={(e) => {
          const newItemId = e.target.value || null;
          onChange(newItemId, null);
        }}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
      >
        <option value="">— select item —</option>
        {items.map((i) => (
          <option key={i.itemId} value={i.itemId}>{i.itemName}</option>
        ))}
      </select>
      <select
        value={variationId ?? ""}
        disabled={!selectedItem}
        onChange={(e) => onChange(itemId, e.target.value || null)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 disabled:opacity-40 focus:outline-none focus:border-amber-600"
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
      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
    >
      <option value="">— select discount —</option>
      {discounts.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}
