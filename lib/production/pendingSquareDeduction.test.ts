import { describe, it, expect } from "vitest";
import { selectPendingDeductionRecipes, type ShipmentDeduction } from "./pendingSquareDeduction";

const ship = (over: Partial<ShipmentDeduction> = {}): ShipmentDeduction => ({
  recipeId: "R1",
  channel: "distribution",
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

  // No invoice yet: the channel predicts what the app will build for it.
  it("defers a distribution shipment with no invoice raised yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set(["R1"]));
  });

  // Model 2 (contract brewing): the fee invoice will never deduct, so the
  // ship-time push is the only signal Square gets. Deferring it would leave
  // Square offering beer that physically left, until an invoice that changes
  // nothing — the exact staleness the ship trigger exists to prevent.
  it("does NOT defer a contract-brewing shipment with no invoice yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "contract_brewing", status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set());
  });

  // An unrecognised channel fails toward stale, never toward double-count.
  it("defers an unknown channel with no invoice yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "some_future_channel", status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set(["R1"]));
  });

  // Once the contract invoice exists, the line inspection reaches the same
  // answer the prediction did — the two stages agree on the same shipment.
  it("keeps a contract shipment released after its fee invoice is raised", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "contract_brewing", invoiceId: "INV-FEES", invoiceHasInventoryLine: false }),
    ])).toEqual(new Set());
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
