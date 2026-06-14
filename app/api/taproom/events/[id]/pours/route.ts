import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createSupabaseServerClient();

  const { data: event, error: eventErr } = await supabase
    .from("events")
    .select("*")
    .eq("id", params.id)
    .single();

  if (eventErr || !event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  // Convert timestamptz to YYYY-MM-DD for Square date range
  const startDate = event.event_start.slice(0, 10);
  const endDate   = event.event_end.slice(0, 10);

  const [catalogItems, orders] = await Promise.all([
    fetchCatalogItems() as Promise<CatalogItem[]>,
    fetchCompletedOrders(startDate, endDate),
  ]);

  // Build map: variation_id → variation display name
  const variationNames = new Map<string, string>();
  for (const item of catalogItems) {
    if (!item.item_data.name.toLowerCase().includes("event pour")) continue;
    for (const v of item.item_data.variations ?? []) {
      variationNames.set(v.id, v.item_variation_data.name ?? item.item_data.name);
    }
  }

  // Aggregate by variation across all orders in the window
  const byVariation = new Map<string, {
    variation_id: string;
    variation_name: string;
    quantity: number;
    gross_cents: number;
    discount_cents: number;
    tax_cents: number;
  }>();

  const eventStart = new Date(event.event_start).getTime();
  const eventEnd   = new Date(event.event_end).getTime();

  for (const order of orders) {
    // Filter to orders whose closed_at falls within the precise event window
    const closedAt = order.closed_at ? new Date(order.closed_at).getTime() : null;
    if (!closedAt || closedAt < eventStart || closedAt > eventEnd) continue;
    if ((order.source?.name ?? "") === "Invoices") continue;

    for (const li of order.line_items ?? []) {
      const varId = li.catalog_object_id ?? "";
      if (!variationNames.has(varId)) continue;

      const qty      = parseFloat(li.quantity ?? "0");
      const gross    = li.gross_sales_money?.amount ?? 0;
      const discount = li.total_discount_money?.amount ?? 0;
      const tax      = li.total_tax_money?.amount ?? 0;

      const existing = byVariation.get(varId);
      if (existing) {
        existing.quantity      += qty;
        existing.gross_cents   += gross;
        existing.discount_cents += discount;
        existing.tax_cents     += tax;
      } else {
        byVariation.set(varId, {
          variation_id:   varId,
          variation_name: variationNames.get(varId)!,
          quantity:       qty,
          gross_cents:    gross,
          discount_cents: discount,
          tax_cents:      tax,
        });
      }
    }
  }

  const rows = [...byVariation.values()].sort((a, b) =>
    b.gross_cents - a.gross_cents
  );

  const totals = rows.reduce(
    (acc, r) => ({
      quantity:       acc.quantity      + r.quantity,
      gross_cents:    acc.gross_cents   + r.gross_cents,
      discount_cents: acc.discount_cents + r.discount_cents,
      tax_cents:      acc.tax_cents     + r.tax_cents,
    }),
    { quantity: 0, gross_cents: 0, discount_cents: 0, tax_cents: 0 }
  );

  return NextResponse.json({ event, rows, totals });
}
