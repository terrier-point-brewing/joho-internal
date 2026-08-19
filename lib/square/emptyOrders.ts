import type { Money, Order } from "@/types/square";

// Only the fields the check reads, so narrower order-shaped types can be passed
// directly.
type EmptyOrderShape = Pick<Order, "line_items" | "total_money" | "total_tax_money" | "total_tip_money">;

/**
 * Is this Square order an *empty shell* — a record of something that happened at
 * the register that was never a sale?
 *
 * Square emits a COMPLETED or CANCELED order with no `line_items` and no money
 * for several everyday register events:
 *
 *   - a cash-drawer open (the "No Sale" button) — a single `NO_SALE` tender
 *   - a ticket started on the POS and abandoned before anything was rung up
 *   - a tab whose items were all removed before it was closed, at $0
 *
 * Persisted, each becomes a blank $0 row in the Orders ledger with nothing to
 * show and nothing to map — it reads as "unmapped" forever and inflates the
 * order count, the same phantom-row problem `isReturnOrder` exists to prevent.
 *
 * The money test is what makes dropping them safe. A real sale that is later
 * canceled keeps both its `line_items` and its `total_money` in Square's
 * payload, so it can never match here — cancellation still withdraws it through
 * the normal path rather than being silently skipped.
 */
export function isEmptyShellOrder(order: EmptyOrderShape): boolean {
  if ((order.line_items ?? []).length > 0) return false;
  return [order.total_money, order.total_tax_money, order.total_tip_money].every(
    (m: Money | undefined) => (m?.amount ?? 0) === 0,
  );
}
