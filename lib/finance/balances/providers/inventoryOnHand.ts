// Values the physical inventory the brewery is holding, at what it paid for it.
//
// ── One provider, several pools ──────────────────────────────────────────────
// The Inventory Assets accounts (1210 Raw Materials, 1220 Packaging Materials)
// are the same calculation pointed at different shelves: count what is on hand,
// multiply by unit cost, sum. Modelling that as one provider reading a declared
// pool -- rather than one provider per account -- is what lets Settings offer a
// SINGLE "Inventory on hand" method whose setup asks which shelf this account
// holds. See methods/definitions.ts.
//
// An unrecognised or missing pool returns null, not 0. That is the difference
// between "this account is not set up yet" (no row written, reads as unsourced)
// and "this account genuinely holds nothing" -- and an inventory account
// showing a confident $0 is exactly the wrong thing to put in front of someone
// who has a warehouse full of malt.
//
// ── Why this is dependsOnCurrentState ────────────────────────────────────────
// `ingredients.stock_quantity` and `packaging_items.stock_quantity` are the
// quantity on hand RIGHT NOW. Neither table keeps a dated history, and the
// adjustment ledgers that would let one be reconstructed only begin in July 2026
// and carry a cost on a minority of rows -- so a cumulative-ledger balance would
// be confidently short rather than unavailable. Asking this provider about March
// therefore gets today's shelf priced at today's cost, which is not March's
// inventory. Marked like `openInvoiceAr` so the snapshot excludes it from any
// month older than the one being closed rather than writing a wrong figure.
//
// ── Partner-owned materials are not this business's asset ────────────────────
// Packaging items carrying a `partner_id` belong to a contract-brewing customer
// and sit here only so a packaging run can consume them. They are excluded from
// the valuation. They also carry no unit cost at all, so leaving them in would
// contribute 0 today and silently start contributing the day somebody fills that
// cost in -- an asset appearing on the brewery's balance sheet because a
// customer's carton got priced.

import { registerProvider, sharedRead } from "../registry";
import { inventoryPoolOf, valueInventoryPoolCents, type InventoryPool } from "@/lib/finance/inventoryValuation";
import type { BalanceContext, BalanceProvider } from "../registry";

/** Config key naming which shelf an account holds. Declared by the method's `select` setup field, and read here by the same name. */
export const INVENTORY_POOL_KEY = "inventoryPool";

// The pools and the valuation arithmetic live in lib/finance/inventoryValuation.ts
// so the P&L's inventory-relief rows can share them without crossing the
// statement-isolation boundary. Re-exported here because the method definition
// and older callers import them from this module.
export { INVENTORY_POOLS, type InventoryPool } from "@/lib/finance/inventoryValuation";

function poolOf(config: Record<string, unknown>): InventoryPool | null {
  return inventoryPoolOf(config[INVENTORY_POOL_KEY]);
}

export const inventoryOnHand: BalanceProvider = {
  key: "inventoryOnHand",
  label: "Inventory on hand at cost",
  kind: "derived",
  dependsOnCurrentState: true,
  async compute(ctx: BalanceContext): Promise<number | null> {
    const pool = poolOf(ctx.config);
    if (!pool) return null;

    // Shared across the run: the shelf is the same shelf for every account
    // asking about it, and 1210 and 1220 are computed in the same pass.
    return sharedRead(ctx, `inventoryOnHand:${pool}`, () => valueInventoryPoolCents(ctx.supabase, pool));
  },
};

registerProvider(inventoryOnHand);
