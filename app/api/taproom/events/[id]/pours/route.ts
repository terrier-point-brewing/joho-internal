import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: event, error: eventErr } = await supabase
    .from("events")
    .select("*")
    .eq("id", id)
    .single();

  if (eventErr || !event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const startDate = event.event_start.slice(0, 10);
  const endDate   = event.event_end.slice(0, 10);

  const [catalogItems, orders] = await Promise.all([
    fetchCatalogItems() as Promise<CatalogItem[]>,
    fetchCompletedOrders(startDate, endDate),
  ]);

  // Which catalog variations are Event Pours today. Used only to RECOGNISE an
  // event-pour line; never to label it. The Event Pour item's variations get
  // renamed for every event, so the catalog's current names belong to the
  // latest event, not to the one being viewed. The label comes from the order
  // line itself, which Square snapshots at the time of sale.
  const eventPourVariationIds = new Set<string>();
  const currentNames = new Map<string, string>();
  for (const item of catalogItems) {
    if (!item.item_data.name.toLowerCase().includes("event pour")) continue;
    for (const v of item.item_data.variations ?? []) {
      eventPourVariationIds.add(v.id);
      currentNames.set(v.id, v.item_variation_data.name ?? item.item_data.name);
    }
  }
  const isEventPourLine = (li: { catalog_object_id?: string; name?: string }) =>
    (li.catalog_object_id != null && eventPourVariationIds.has(li.catalog_object_id)) ||
    (li.name ?? "").toLowerCase().includes("event pour");

  const byVariation = new Map<string, {
    variation_id:   string;
    variation_name: string;
    quantity:       number;
    gross_cents:    number;
    discount_cents: number;
    tax_cents:      number;
  }>();

  const eventStart = new Date(event.event_start).getTime();
  const eventEnd   = new Date(event.event_end).getTime();
  let totalTipsCents = 0;
  let cardTipsCents  = 0;
  let cashTipsCents  = 0;

  for (const order of orders) {
    const closedAt = order.closed_at ? new Date(order.closed_at).getTime() : null;
    if (!closedAt || closedAt < eventStart || closedAt > eventEnd) continue;
    if (isInvoiceOrder(order)) continue;

    let orderHasEventPour = false;

    for (const li of order.line_items ?? []) {
      const varId = li.catalog_object_id ?? "";
      if (!isEventPourLine(li)) continue;

      orderHasEventPour = true;

      // Sale-time name, so a later rename cannot relabel this event's rows.
      // Rows are keyed on that name: the same variation sold under two names
      // (renamed mid-window) shows as two rows rather than one mislabelled one.
      const name = li.variation_name?.trim() || currentNames.get(varId) || li.name || "Event Pour";
      const key  = `${varId}|${name}`;

      const qty      = parseFloat(li.quantity ?? "0");
      const gross    = li.gross_sales_money?.amount ?? 0;
      const discount = li.total_discount_money?.amount ?? 0;
      const tax      = li.total_tax_money?.amount ?? 0;

      const existing = byVariation.get(key);
      if (existing) {
        existing.quantity      += qty;
        existing.gross_cents   += gross;
        existing.discount_cents += discount;
        existing.tax_cents     += tax;
      } else {
        byVariation.set(key, {
          variation_id:   key,
          variation_name: name,
          quantity:       qty,
          gross_cents:    gross,
          discount_cents: discount,
          tax_cents:      tax,
        });
      }
    }

    if (orderHasEventPour) {
      totalTipsCents += order.total_tip_money?.amount ?? 0;
      // Square books the tip on the tender it was paid with, so the card/cash
      // split lives on `tenders[].tip_money`, not on the order total. Anything
      // that isn't physical cash (CARD, SQUARE_GIFT_CARD, WALLET, …) settles
      // through Square and is "card" for tip-pool purposes.
      for (const t of order.tenders ?? []) {
        const tip = t.tip_money?.amount ?? 0;
        if (t.type === "CASH") cashTipsCents += tip;
        else cardTipsCents += tip;
      }
    }
  }

  const rows = [...byVariation.values()].sort((a, b) => b.gross_cents - a.gross_cents);

  const totals = rows.reduce(
    (acc, r) => ({
      quantity:       acc.quantity       + r.quantity,
      gross_cents:    acc.gross_cents    + r.gross_cents,
      discount_cents: acc.discount_cents + r.discount_cents,
      tax_cents:      acc.tax_cents      + r.tax_cents,
      tip_cents:      acc.tip_cents,
      card_tip_cents: acc.card_tip_cents,
      cash_tip_cents: acc.cash_tip_cents,
    }),
    {
      quantity: 0, gross_cents: 0, discount_cents: 0, tax_cents: 0,
      tip_cents: totalTipsCents, card_tip_cents: cardTipsCents, cash_tip_cents: cashTipsCents,
    }
  );

  return NextResponse.json({ event, rows, totals });
}
