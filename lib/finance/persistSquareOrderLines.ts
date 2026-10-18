// lib/finance/persistSquareOrderLines.ts
//
// After a Square invoice is created (or re-created), its line items are stored
// locally from Square's ORDER, not from what was sent: the read-back is what
// splits catalog identity (`line_item_name` / `variation_name`) from the line's
// note, classifies `category`, rebuilds the tax rows and gives the header its
// authoritative totals. Three routes used to carry this block verbatim — export
// generate, export line-item edit and deposit generate — each with its own raw
// fallback insert for when Square's read-back fails. This is that block, once.
//
// The fallback is deliberately crude: delete what is there and write the draft
// values, so the invoice is never left empty and a later sync reconciles the
// catalog identity, notes and categories. A fallback that fails is reported to
// the caller rather than swallowed — the Square invoice already exists, so what
// to do about an empty local row is the route's call, not this module's.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem, Order } from "@/types/square";
import { fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import {
  buildLineItemIndexes,
  buildInvoiceLineItemRows,
  persistInvoiceLineItems,
  invoiceHeaderTotalsFromOrder,
  type LineItemCoa,
} from "@/lib/finance/invoiceLineItems";

/** A draft line as the fallback writes it; `invoice_id` and `sort_order` are set here. */
export interface FallbackLine {
  note: string | null;
  category?: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  square_catalog_variation_id?: string | null;
  square_catalog_discount_id?: string | null;
  chart_of_accounts_id?: string | null;
}

export interface PersistSquareOrderLinesOptions {
  /**
   * Chart-of-accounts mappings to carry across a rebuild, keyed by Square
   * variation id. Keyed by variation rather than sort_order because an
   * add/remove shifts every position after it.
   */
  coaByVariation?: Map<string, string>;
  /** Prefix for the console line written when the read-back fails. */
  logLabel?: string;
}

export interface PersistSquareOrderLinesResult {
  /** True when the canonical rows came from Square's order; false when the fallback ran. */
  fromSquare: boolean;
  /** Set only when the FALLBACK could not write either — the invoice has no local lines. */
  error?: string;
}

export async function persistSquareOrderLines(
  supabase: SupabaseClient,
  invoiceId: string,
  orderId: string,
  fallbackLines: FallbackLine[],
  options: PersistSquareOrderLinesOptions = {},
): Promise<PersistSquareOrderLinesResult> {
  const label = options.logLabel ?? "[persistSquareOrderLines]";
  try {
    const [orders, catalogItems] = await Promise.all([
      fetchOrdersByIds([orderId]),
      fetchCatalogItems(),
    ]);
    const order: Order | undefined = orders[0];
    if (!order) throw new Error(`order read-back returned no order for ${orderId}`);
    const indexes = await buildLineItemIndexes(supabase, catalogItems as CatalogItem[]);

    const existingCoaBySort = new Map<number, LineItemCoa>();
    if (options.coaByVariation?.size) {
      (order.line_items ?? []).forEach((li, i) => {
        const coa = li.catalog_object_id ? options.coaByVariation!.get(li.catalog_object_id) : undefined;
        if (coa) existingCoaBySort.set(i, { chart_of_accounts_id: coa });
      });
    }

    const rows = buildInvoiceLineItemRows(invoiceId, order, indexes, existingCoaBySort);
    const { error: persistErr } = await persistInvoiceLineItems(supabase, invoiceId, rows, order);
    if (persistErr) throw new Error(persistErr);

    const totals = invoiceHeaderTotalsFromOrder(order);
    const { error: hdrErr } = await supabase.from("invoices").update(totals).eq("id", invoiceId);
    if (hdrErr) console.error(`${label} header totals update failed:`, hdrErr.message);
    return { fromSquare: true };
  } catch (err) {
    console.error(`${label} read-back failed, falling back to draft values:`, err);
  }

  if (fallbackLines.length === 0) return { fromSquare: false };

  const { error: deleteErr } = await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
  if (deleteErr) return { fromSquare: false, error: deleteErr.message };
  const { error: insertErr } = await supabase.from("invoice_line_items").insert(
    fallbackLines.map((line, i) => ({
      invoice_id: invoiceId,
      sort_order: i,
      category: "other_services",
      ...line,
      square_catalog_variation_id: line.square_catalog_variation_id ?? null,
      square_catalog_discount_id: line.square_catalog_discount_id ?? null,
      chart_of_accounts_id: line.chart_of_accounts_id ?? null,
    })),
  );
  if (insertErr) return { fromSquare: false, error: insertErr.message };
  return { fromSquare: false };
}
