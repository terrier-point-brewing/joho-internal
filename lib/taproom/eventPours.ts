/**
 * What makes a Square order an EVENT order.
 *
 * One rule, shared by the Events tab's pour table and the payroll tip pool:
 * an order is an event order when it closed inside a listed event's buffered
 * window AND carries at least one Event Pour line. The pours route counts its
 * sales and tips; the payroll grid carves its tips OUT of the taproom pool
 * (lib/square/payroll.ts), because the taproom is open while an event runs
 * and event staff — volunteers among them — are settled from the event
 * itself (event_tip_payouts), never by the clocked-in crew's hours.
 *
 * The recognition test is the pours route's, verbatim: a line is an Event
 * Pour if its catalog variation is one of the Event Pour item's today, or its
 * sale-time name contains "event pour" (the variations get renamed for every
 * event, so the catalog alone misses older sales).
 */
import type { CatalogItem, Order } from "@/types/square";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { bufferedEventWindow } from "./eventWindow";

export interface EventWindowRef { event_start: string; event_end: string }

/** The Event Pour item's variation ids, from a live catalog read. */
export function eventPourVariationIds(catalogItems: CatalogItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of catalogItems) {
    if (!item.item_data.name.toLowerCase().includes("event pour")) continue;
    for (const v of item.item_data.variations ?? []) ids.add(v.id);
  }
  return ids;
}

export function isEventPourLine(
  li: { catalog_object_id?: string; name?: string },
  variationIds: Set<string>,
): boolean {
  return (li.catalog_object_id != null && variationIds.has(li.catalog_object_id))
    || (li.name ?? "").toLowerCase().includes("event pour");
}

export function orderHasEventPour(
  order: Pick<Order, "line_items">,
  variationIds: Set<string>,
): boolean {
  return (order.line_items ?? []).some(li => isEventPourLine(li, variationIds));
}

/**
 * Pure: the ids of every order that belongs to some event — closed inside a
 * buffered event window, not an invoice, with an Event Pour on it. This is
 * the set the payroll pool subtracts.
 */
export function eventOrderIds(
  orders: Pick<Order, "id" | "closed_at" | "line_items" | "source">[],
  events: EventWindowRef[],
  variationIds: Set<string>,
): Set<string> {
  const out = new Set<string>();
  if (events.length === 0) return out;
  const windows = events.map(bufferedEventWindow);
  for (const order of orders) {
    if (!order.closed_at) continue;
    if (isInvoiceOrder(order as Order)) continue;
    const closedMs = new Date(order.closed_at).getTime();
    if (!windows.some(w => closedMs >= w.startMs && closedMs <= w.endMs)) continue;
    if (!orderHasEventPour(order, variationIds)) continue;
    out.add(order.id);
  }
  return out;
}
