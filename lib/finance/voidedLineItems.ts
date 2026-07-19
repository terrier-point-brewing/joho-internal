/**
 * Read-only line-item extraction for CANCELED (voided) Square orders.
 *
 * Canceled orders are deliberately stored WITHOUT `pos_line_items` rows so they
 * contribute nothing to the P&L / tax base (see `syncPosTransactions.ts` — the
 * financials and tax-base queries join `pos_line_items` with no status filter,
 * and rely on "canceled ⇒ zero line items"). But the full Square order — its
 * line items, discounts, and taxes — is preserved in `square_orders.raw_data`.
 *
 * This module reconstructs the voided line items from that stored JSON purely for
 * DISPLAY in the Orders ledger, so there's a clear record of what was canceled and
 * for how much. These are never persisted and never GL-mapped — they exist only in
 * the API response, keeping the "$0 contribution" invariant intact by construction.
 */
import type { Order, OrderLineItem } from "@/types/square";

/** A voided line item, shaped for read-only display (no GL mapping fields). */
export interface VoidedLineItem {
  uid: string | null;
  name: string;
  variation_name: string | null;
  quantity: number;
  gross_sales_cents: number;
  discount_cents: number;
  tax_cents: number;
}

/** Sum of gross sales across voided line items — the order's would-be gross. */
export function voidedGrossSalesCents(items: VoidedLineItem[]): number {
  return items.reduce((sum, li) => sum + li.gross_sales_cents, 0);
}

/**
 * Extract read-only display line items from a canceled order's `raw_data` (a
 * stored Square `Order`). Tolerant of malformed/absent input — returns [] when
 * `raw_data` is null, not an object, or carries no line items.
 */
export function extractVoidedLineItems(rawData: unknown): VoidedLineItem[] {
  if (!rawData || typeof rawData !== "object") return [];
  const lineItems = (rawData as Partial<Order>).line_items;
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map(mapLineItem);
}

function mapLineItem(li: OrderLineItem): VoidedLineItem {
  const qty = parseFloat(li.quantity ?? "1");
  return {
    uid: li.uid ?? null,
    name: li.name ?? "",
    variation_name: li.variation_name ?? null,
    quantity: Number.isFinite(qty) ? qty : 1,
    gross_sales_cents: li.gross_sales_money?.amount ?? 0,
    discount_cents: li.total_discount_money?.amount ?? 0,
    tax_cents: li.total_tax_money?.amount ?? 0,
  };
}
