"use client";

import { useMemo } from "react";
import { SearchCombobox, type SearchComboboxItem } from "@/components/ui/SearchCombobox";
import type { SquareCatalogOptions } from "@/app/production/types";

const SEP = "::";

function fmtPrice(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * One searchable picker over every Square item + variation pair.
 *
 * Typing matches any word of the item name or the variation name, so
 * "hazy sixtel" finds the right row in one step instead of two cascading
 * dropdowns. The backend requires item + variation together, so a pick is
 * always a complete pair.
 */
export function SquareCatalogSelect({
  items,
  itemId,
  variationId,
  onChange,
  className,
}: {
  items: SquareCatalogOptions["items"];
  itemId: string | null;
  variationId: string | null;
  onChange: (itemId: string | null, variationId: string | null) => void;
  className?: string;
}) {
  const options = useMemo<SearchComboboxItem[]>(
    () =>
      items.flatMap((i) =>
        i.variations.map((v) => ({
          id: `${i.itemId}${SEP}${v.variationId}`,
          label: i.itemName,
          // A lone "Regular" variation carries no information; hide it.
          sub: i.variations.length === 1 && /^regular$/i.test(v.variationName) ? null : v.variationName,
          hint: fmtPrice(v.priceCents),
        })),
      ),
    [items],
  );

  // Resolve the selected pair by variation alone when the item id is unknown
  // (the invoice preview only tracks the variation).
  const value = useMemo(() => {
    if (!variationId) return "";
    const item = items.find((i) =>
      itemId ? i.itemId === itemId : i.variations.some((v) => v.variationId === variationId),
    );
    return item ? `${item.itemId}${SEP}${variationId}` : "";
  }, [items, itemId, variationId]);

  return (
    <SearchCombobox
      value={value}
      items={options}
      placeholder="Search Square items…"
      emptyLabel="No Square items match"
      className={className ?? "min-w-[16rem]"}
      onChange={(id) => {
        if (!id) {
          onChange(null, null);
          return;
        }
        const [nextItemId, nextVariationId] = id.split(SEP);
        onChange(nextItemId ?? null, nextVariationId ?? null);
      }}
    />
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
