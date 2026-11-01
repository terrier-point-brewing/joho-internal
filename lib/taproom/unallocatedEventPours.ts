/**
 * Event Pours that no listed event claims.
 *
 * An event "owns" a pour purely by time: the pours route counts any Event Pour
 * line on an order closed inside [event_start, event_end]. So a pour rung on
 * the Event Pour item while no event window was open is invisible — it sits in
 * Square, lands in Finance under Events, but no event on the tab shows it.
 * Typical causes: the event was never created, its window was set too short,
 * or tabs were closed after the end time.
 *
 * This module finds those pours and groups them into clusters a manager can
 * act on in one press — "create an event for this" or "stretch that event's
 * window to cover it". The grouping rule is deliberately simple: pours on the
 * same brewery-local day that are at most `gapMs` apart belong together.
 */
import type { Order } from "@/types/square";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { localDateString } from "@/lib/utils/datetime";

export interface EventWindow {
  id: string;
  event_name: string;
  event_start: string;
  event_end: string;
}

/** One Event Pour line on an order that no event window covers. */
export interface OrphanPour {
  order_id: string;
  closed_at: string;
  variation_id: string;
  variation_name: string;
  quantity: number;
  gross_cents: number;
  discount_cents: number;
  tax_cents: number;
}

export interface OrphanCluster {
  /** Brewery-local calendar day (YYYY-MM-DD). */
  date: string;
  first_closed_at: string;
  last_closed_at: string;
  order_count: number;
  quantity: number;
  gross_cents: number;
  discount_cents: number;
  tax_cents: number;
  rows: { variation_id: string; variation_name: string; quantity: number; gross_cents: number }[];
  /**
   * The listed event closest in time to this cluster, when one ends or starts
   * within `nearbyMs` of it. That is the event whose window was most likely
   * set too tight, so the UI offers to stretch it.
   */
  nearest_event: { id: string; event_name: string; event_start: string; event_end: string } | null;
}

const DEFAULT_GAP_MS = 3 * 60 * 60 * 1000;    // pours >3h apart are different events
const DEFAULT_NEARBY_MS = 6 * 60 * 60 * 1000; // an event within 6h is "the one they meant"

export function isInsideAnyEvent(closedAtMs: number, events: EventWindow[]): boolean {
  for (const ev of events) {
    const s = new Date(ev.event_start).getTime();
    const e = new Date(ev.event_end).getTime();
    if (closedAtMs >= s && closedAtMs <= e) return true;
  }
  return false;
}

/**
 * Pure: the Event Pour lines, from `orders`, whose order closed outside every
 * event window. `variationNames` is the catalog's Event Pour variations
 * (id → display name) — the same test the pours route applies, so a pour is
 * an orphan exactly when no event's table would show it.
 */
export function findOrphanPours(
  orders: Order[],
  variationNames: Map<string, string>,
  events: EventWindow[],
): OrphanPour[] {
  const out: OrphanPour[] = [];
  for (const order of orders) {
    if (!order.closed_at) continue;
    if (isInvoiceOrder(order)) continue;
    const closedMs = new Date(order.closed_at).getTime();
    if (isInsideAnyEvent(closedMs, events)) continue;
    for (const li of order.line_items ?? []) {
      const varId = li.catalog_object_id ?? "";
      const name = variationNames.get(varId);
      if (!name) continue;
      out.push({
        order_id: order.id,
        closed_at: order.closed_at,
        variation_id: varId,
        variation_name: name,
        quantity: parseFloat(li.quantity ?? "0"),
        gross_cents: li.gross_sales_money?.amount ?? 0,
        discount_cents: li.total_discount_money?.amount ?? 0,
        tax_cents: li.total_tax_money?.amount ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.closed_at.localeCompare(b.closed_at));
}

/** Pure: group orphan pours into same-day runs separated by at most `gapMs`. */
export function clusterOrphanPours(
  pours: OrphanPour[],
  events: EventWindow[],
  tz: string,
  opts: { gapMs?: number; nearbyMs?: number } = {},
): OrphanCluster[] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const nearbyMs = opts.nearbyMs ?? DEFAULT_NEARBY_MS;
  const sorted = [...pours].sort((a, b) => a.closed_at.localeCompare(b.closed_at));

  const groups: OrphanPour[][] = [];
  for (const p of sorted) {
    const cur = groups[groups.length - 1];
    if (
      cur &&
      localDateString(p.closed_at, tz) === localDateString(cur[0].closed_at, tz) &&
      new Date(p.closed_at).getTime() - new Date(cur[cur.length - 1].closed_at).getTime() <= gapMs
    ) {
      cur.push(p);
    } else {
      groups.push([p]);
    }
  }

  return groups.map((g) => {
    const first = g[0].closed_at;
    const last = g[g.length - 1].closed_at;
    const byVar = new Map<string, OrphanCluster["rows"][number]>();
    const orders = new Set<string>();
    let quantity = 0, gross = 0, discount = 0, tax = 0;
    for (const p of g) {
      orders.add(p.order_id);
      quantity += p.quantity; gross += p.gross_cents; discount += p.discount_cents; tax += p.tax_cents;
      const row = byVar.get(p.variation_id);
      if (row) { row.quantity += p.quantity; row.gross_cents += p.gross_cents; }
      else byVar.set(p.variation_id, { variation_id: p.variation_id, variation_name: p.variation_name, quantity: p.quantity, gross_cents: p.gross_cents });
    }
    return {
      date: localDateString(first, tz),
      first_closed_at: first,
      last_closed_at: last,
      order_count: orders.size,
      quantity,
      gross_cents: gross,
      discount_cents: discount,
      tax_cents: tax,
      rows: [...byVar.values()].sort((a, b) => b.gross_cents - a.gross_cents),
      nearest_event: nearestEvent(new Date(first).getTime(), new Date(last).getTime(), events, nearbyMs),
    };
  }).sort((a, b) => b.first_closed_at.localeCompare(a.first_closed_at));
}

/** The event whose window edge is closest to the cluster, if within `nearbyMs`. */
export function nearestEvent(
  firstMs: number,
  lastMs: number,
  events: EventWindow[],
  nearbyMs: number,
): OrphanCluster["nearest_event"] {
  let best: OrphanCluster["nearest_event"] = null;
  let bestDist = Infinity;
  for (const ev of events) {
    const s = new Date(ev.event_start).getTime();
    const e = new Date(ev.event_end).getTime();
    // Distance from the cluster to the window: 0 if they overlap.
    const dist = lastMs < s ? s - lastMs : firstMs > e ? firstMs - e : 0;
    if (dist <= nearbyMs && dist < bestDist) {
      bestDist = dist;
      best = { id: ev.id, event_name: ev.event_name, event_start: ev.event_start, event_end: ev.event_end };
    }
  }
  return best;
}

/**
 * The window an event needs so it covers the cluster: its current window
 * stretched to include [first, last], padded a little so a tab closed a minute
 * after the last recorded pour still lands inside.
 */
export function stretchedWindow(
  ev: { event_start: string; event_end: string },
  cluster: { first_closed_at: string; last_closed_at: string },
  padMs = 15 * 60 * 1000,
): { event_start: string; event_end: string } {
  const s = Math.min(new Date(ev.event_start).getTime(), new Date(cluster.first_closed_at).getTime() - padMs);
  const e = Math.max(new Date(ev.event_end).getTime(), new Date(cluster.last_closed_at).getTime() + padMs);
  return { event_start: new Date(s).toISOString(), event_end: new Date(e).toISOString() };
}
