import type { Order } from "@/types/square";

// Only the field the check reads, so narrower order-shaped types can be passed
// directly.
type ReturnOrderShape = {
  returns?: unknown[];
};

/**
 * Is this Square order a *return order* rather than a real sale?
 *
 * A refund does not mutate the original sale — Square creates a separate order
 * carrying the refund, with a negative `net_amounts.total_money`, no
 * `line_items`, and the returned goods under `returns[]`. These come back from
 * the COMPLETED-orders search alongside genuine sales.
 *
 * They contribute no revenue (empty `line_items`), so totals are unaffected,
 * but they must be excluded from any *count* of orders — otherwise guest count
 * is inflated and average ticket diluted by one phantom order per refund.
 *
 * Note: return orders must still be PASSED to `buildTaproomModelReport`, which
 * resolves `refund.order_id` against them to attribute returns. Filter them out
 * of counts, not out of the array.
 */
export function isReturnOrder(order: ReturnOrderShape): boolean {
  return (order.returns ?? []).length > 0;
}

/**
 * Map each return order's own id → the id of the sale it reverses, read from
 * `returns[].source_order_id`.
 *
 * A refund's `order_id` is this return order, not the sale. To make a refund
 * drill through to what was actually sold, resolve it here and store the sale
 * id. Orders that carry no `source_order_id` (a real sale, or a refund that
 * points straight at its sale) simply don't appear in the map — callers keep
 * the original id for those.
 *
 * Pure: the caller supplies the already-fetched orders.
 */
export function resolveSourceOrderIds(orders: Order[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of orders) {
    const source = (o.returns ?? [])
      .map((r) => r.source_order_id)
      .find((id): id is string => !!id);
    if (source) map.set(o.id, source);
  }
  return map;
}
