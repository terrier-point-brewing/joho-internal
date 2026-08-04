import { describe, it, expect } from "vitest";
import { selectPendingDeductionRecipes, type ExportStatusRow } from "./pendingSquareDeduction";

const row = (over: Partial<ExportStatusRow> = {}): ExportStatusRow => ({
  recipeId: "R1", channel: "distribution", status: "unpaid", ...over,
});

describe("selectPendingDeductionRecipes", () => {
  // The bug this exists to prevent: ship 24 of 100, push sets Square to 76, the
  // invoice then deducts 24 again and Square lands at 52. Left alone Square goes
  // 100 → 76 on its own and is correct.
  it("defers a distribution shipment whose invoice has not settled", () => {
    expect(selectPendingDeductionRecipes([row()])).toEqual(new Set(["R1"]));
  });

  it("defers wholesale the same way", () => {
    expect(selectPendingDeductionRecipes([row({ channel: "wholesale" })])).toEqual(new Set(["R1"]));
  });

  // No invoice yet means the deduction is further away, not closer.
  it("defers a shipment with no invoice raised at all", () => {
    expect(selectPendingDeductionRecipes([row({ status: "invoice_required" })])).toEqual(new Set(["R1"]));
  });

  it("releases once the invoice is paid, because Square has now taken its units", () => {
    expect(selectPendingDeductionRecipes([row({ status: "paid" })])).toEqual(new Set());
  });

  // Contract-brewing invoices bill packaging fees, excise and services — never
  // inventory-tracked SKUs — so Square will NEVER decrement for them. Deferring
  // these would mean Square never learns the beer left at all.
  it("never defers contract brewing, whatever its invoice status", () => {
    expect(selectPendingDeductionRecipes([
      row({ channel: "contract_brewing", status: "unpaid" }),
      row({ channel: "contract_brewing", status: "invoice_required" }),
    ])).toEqual(new Set());
  });

  it("never defers taproom, which is already settled at the till", () => {
    expect(selectPendingDeductionRecipes([row({ channel: "taproom", status: "unpaid" })])).toEqual(new Set());
  });

  it("defers a recipe if ANY of its shipments is pending", () => {
    expect(selectPendingDeductionRecipes([
      row({ status: "paid" }),
      row({ status: "unpaid" }),
    ])).toEqual(new Set(["R1"]));
  });

  it("keeps recipes independent of one another", () => {
    expect(selectPendingDeductionRecipes([
      row({ recipeId: "R1", status: "unpaid" }),
      row({ recipeId: "R2", status: "paid" }),
    ])).toEqual(new Set(["R1"]));
  });

  it("ignores rows with no recipe", () => {
    expect(selectPendingDeductionRecipes([row({ recipeId: null })])).toEqual(new Set());
  });

  it("defers nothing when there are no shipments", () => {
    expect(selectPendingDeductionRecipes([])).toEqual(new Set());
  });
});
