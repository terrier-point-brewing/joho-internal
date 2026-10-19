import type { TaproomLineContribution } from "@/types/reports";
import { localDateString } from "@/lib/utils/datetime";

// Per-item sell-through, as dated events the Items tab buckets by day, week or
// month (via lib/reports/draftTrend, the same engine Draft Stats uses).
//
// Built from the per-line contributions that feed the Sales Pulse category
// table, so an item's total here is the sum of the lines its drill shows —
// nothing is re-derived from Square. Items are keyed on item AND variation
// name, so "Kettle Chips / BBQ" and "Kettle Chips / Sea Salt" are two rows.

export interface ItemSalesItem {
  id: string;
  categoryId: string;
  itemName: string;
  variationName: string;
  /** Fluid ounces one sold unit represents (a 16oz pour, a 4-pack), or null when unknown. */
  flOzPerUnit: number | null;
}

export interface ItemSalesEvent {
  item_id: string;
  /** Brewery-local business date, YYYY-MM-DD. */
  date: string;
  units: number;
  net_cents: number;
  /** units × the item's fl oz per unit; 0 when that is unknown. */
  fl_oz: number;
}

export interface ItemSalesData {
  start: string;
  end: string;
  items: ItemSalesItem[];
  /** One event per item per day it sold (or was returned). */
  events: ItemSalesEvent[];
}

export function itemKey(l: Pick<TaproomLineContribution, "categoryId" | "itemName" | "variationName">): string {
  return `${l.categoryId}|${l.itemName}|${l.variationName}`;
}

/** Key for every variation of one item — the fl oz view rolls pour sizes up to the beer. */
export function itemGroupKey(l: Pick<TaproomLineContribution, "categoryId" | "itemName">): string {
  return `${l.categoryId}|${l.itemName}|*`;
}

/** Whether a line belongs to `key`: an exact item key, or an item group (`…|*`). */
export function matchesItemKey(l: TaproomLineContribution, key: string): boolean {
  return key.endsWith("|*") ? itemGroupKey(l) === key : itemKey(l) === key;
}

/** Net and signed units for one contribution — the category table's convention. */
export function lineNet(l: TaproomLineContribution): { units: number; net: number } {
  return {
    units: l.kind === "return" ? -l.quantity : l.quantity,
    net: l.grossSalesCents - l.discountsCents - l.returnsCents,
  };
}

export function buildItemSalesData(
  lines: TaproomLineContribution[],
  start: string,
  end: string,
  tz: string,
  /** Fl oz per sold unit, by item name + variation name; null/absent = unknown. */
  flOzFor: (itemName: string, variationName: string) => number | null = () => null,
): ItemSalesData {
  const items = new Map<string, ItemSalesItem>();
  const days = new Map<string, ItemSalesEvent>();

  for (const l of lines) {
    const id = itemKey(l);
    let item = items.get(id);
    if (!item) {
      item = {
        id, categoryId: l.categoryId, itemName: l.itemName, variationName: l.variationName,
        flOzPerUnit: flOzFor(l.itemName, l.variationName),
      };
      items.set(id, item);
    }
    const date = localDateString(l.occurredAt, tz);
    const k = `${id}\u0000${date}`;
    let ev = days.get(k);
    if (!ev) {
      ev = { item_id: id, date, units: 0, net_cents: 0, fl_oz: 0 };
      days.set(k, ev);
    }
    const { units, net } = lineNet(l);
    ev.units += units;
    ev.net_cents += net;
    ev.fl_oz += units * (item.flOzPerUnit ?? 0);
  }

  return {
    start, end,
    items: [...items.values()].sort((a, b) =>
      a.itemName.localeCompare(b.itemName) || a.variationName.localeCompare(b.variationName)),
    events: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
