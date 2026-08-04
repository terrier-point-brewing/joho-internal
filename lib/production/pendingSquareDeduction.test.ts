import { describe, it, expect } from "vitest";
import { selectPendingDeductionRecipes, type ShipmentDeduction } from "./pendingSquareDeduction";

const ship = (over: Partial<ShipmentDeduction> = {}): ShipmentDeduction => ({
  recipeId: "R1",
  status: "unpaid",
  invoiceId: "INV-1",
  skuTracked: true,
  invoiceHasInventoryLine: true,
  ...over,
});

describe("selectPendingDeductionRecipes", () => {
  // The bug this exists to prevent: ship 24 of 100, push sets Square to 76, the
  // invoice then deducts 24 again and Square lands at 52. Left alone Square goes
  // 100 → 76 on its own and is correct.
  it("defers a shipment whose invoice will decrement Square", () => {
    expect(selectPendingDeductionRecipes([ship()])).toEqual(new Set(["R1"]));
  });

  it("releases once settled, because Square has now taken its units", () => {
    expect(selectPendingDeductionRecipes([ship({ status: "paid" })])).toEqual(new Set());
  });

  // The mechanism, not the channel: Square cannot decrement a variation it does
  // not track, so nothing is owed no matter what the invoice says.
  it("never defers an untracked SKU", () => {
    expect(selectPendingDeductionRecipes([
      ship({ skuTracked: false }),
      ship({ skuTracked: false, invoiceId: null }),
    ])).toEqual(new Set());
  });

  // Contract brewing: the invoice bills packaging fees, excise and services and
  // carries no product line, so Square will NEVER decrement. Deferring would mean
  // Square never learns the beer left at all.
  it("releases once an invoice exists that carries no inventory line", () => {
    expect(selectPendingDeductionRecipes([ship({ invoiceHasInventoryLine: false })])).toEqual(new Set());
  });

  // No invoice yet, so nothing to inspect. Stale is recoverable; double-counting
  // is the failure worth avoiding.
  it("defers a shipment with no invoice raised yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set(["R1"]));
  });

  it("does not defer an unraised invoice for an untracked SKU", () => {
    expect(selectPendingDeductionRecipes([
      ship({ status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null, skuTracked: false }),
    ])).toEqual(new Set());
  });

  it("defers a recipe if ANY of its shipments is pending", () => {
    expect(selectPendingDeductionRecipes([
      ship({ status: "paid" }),
      ship({ status: "unpaid" }),
    ])).toEqual(new Set(["R1"]));
  });

  it("keeps recipes independent of one another", () => {
    expect(selectPendingDeductionRecipes([
      ship({ recipeId: "R1", status: "unpaid" }),
      ship({ recipeId: "R2", status: "paid" }),
    ])).toEqual(new Set(["R1"]));
  });

  // A contract shipment and a distribution shipment of the same beer: the
  // distribution one still owes a deduction, so the recipe stays deferred.
  it("defers the recipe when one shipment owes a deduction and another does not", () => {
    expect(selectPendingDeductionRecipes([
      ship({ invoiceId: "INV-FEES", invoiceHasInventoryLine: false }),
      ship({ invoiceId: "INV-PRODUCT", invoiceHasInventoryLine: true }),
    ])).toEqual(new Set(["R1"]));
  });

  it("defers nothing when there are no shipments", () => {
    expect(selectPendingDeductionRecipes([])).toEqual(new Set());
  });
});
