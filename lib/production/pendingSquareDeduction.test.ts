import { describe, it, expect } from "vitest";
import { selectPendingDeductionHolds, selectPendingDeductionRecipes, type ShipmentDeduction } from "./pendingSquareDeduction";

// The deferring state is the window BEFORE send: shipped, invoice drafted (or
// not yet raised), Square's deduction still to come.
const ship = (over: Partial<ShipmentDeduction> = {}): ShipmentDeduction => ({
  recipeId: "R1",
  channel: "distribution",
  status: "invoice_required",
  invoiceId: "INV-1",
  skuTracked: true,
  invoiceHasInventoryLine: true,
  ...over,
});

describe("selectPendingDeductionRecipes", () => {
  // The bug this exists to prevent: ship 24 of 100, push sets Square to 76, the
  // invoice then deducts 24 again and Square lands at 52. Left alone Square goes
  // 100 → 76 on its own and is correct.
  it("defers a drafted product invoice that has not been sent", () => {
    expect(selectPendingDeductionRecipes([ship()])).toEqual(new Set(["R1"]));
  });

  // Corrected 2026-09-01. This previously asserted the opposite — that sending
  // released the hold, because publishing was believed to be when Square
  // deducts. It is not: raising an invoice COMMITS the units and Square moves
  // them out of IN_STOCK only at payment, which is why an unpaid invoice shows
  // an oversell warning rather than reading as sold. Releasing at send let the
  // push write IN_STOCK down while the commitment was still outstanding, and
  // payment then took the same units again.
  //
  // Waiting costs nothing: the commitment holds Square's AVAILABLE equal to cold
  // storage for the whole window, so the taproom cannot sell the shipped units.
  it("keeps deferring a sent-but-unpaid invoice — Square deducts at payment", () => {
    expect(selectPendingDeductionRecipes([ship({ status: "unpaid" })])).toEqual(new Set(["R1"]));
  });

  it("stays released once paid", () => {
    expect(selectPendingDeductionRecipes([ship({ status: "paid" })])).toEqual(new Set());
  });

  // The mechanism gate: Square cannot decrement a variation it does not track,
  // so with no invoice to say otherwise, nothing is owed for it.
  it("never defers an untracked SKU with no invoice", () => {
    expect(selectPendingDeductionRecipes([
      ship({ skuTracked: false, invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set());
  });

  // Evidence ordering: skuTracked rests on resolving the shipped item's name to
  // a SKU, and a failed resolution must not release a shipment whose drafted
  // invoice PROVABLY carries an inventory line. Invoice lines outrank the gate.
  it("defers when the drafted invoice has an inventory line, even if the SKU could not be resolved", () => {
    expect(selectPendingDeductionRecipes([
      ship({ skuTracked: false, invoiceId: "INV-1", invoiceHasInventoryLine: true }),
    ])).toEqual(new Set(["R1"]));
  });

  // Contract brewing with its invoice drafted: fee lines only, Square will never
  // deduct, so there is nothing to wait for.
  it("releases a drafted invoice that carries no inventory line", () => {
    expect(selectPendingDeductionRecipes([ship({ invoiceHasInventoryLine: false })])).toEqual(new Set());
  });

  // No invoice yet: the channel predicts what the app will build for it.
  it("defers a distribution shipment with no invoice raised yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set(["R1"]));
  });

  // Model 2 (contract brewing): the fee invoice will never deduct, so the
  // ship-time push is the only signal Square gets. Deferring it would leave
  // Square offering beer that physically left, until an invoice that changes
  // nothing — the exact staleness the ship trigger exists to prevent.
  it("does NOT defer a contract-brewing shipment with no invoice yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "contract_brewing", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set());
  });

  // An unrecognised channel fails toward stale, never toward double-count.
  it("defers an unknown channel with no invoice yet", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "some_future_channel", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual(new Set(["R1"]));
  });

  // Cross-model revision (ship as distribution, re-bill as contract): the draft's
  // actual lines overrule the channel prediction the moment the draft exists.
  it("lets a fee-only draft release a shipment whose channel predicted a deduction", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "distribution", invoiceId: "INV-FEES", invoiceHasInventoryLine: false }),
    ])).toEqual(new Set());
  });

  // And the reverse (ship as contract, re-bill with product lines): the draft
  // defers the recipe from that moment on, whatever the channel said at ship.
  it("lets a product draft defer a shipment whose channel predicted no deduction", () => {
    expect(selectPendingDeductionRecipes([
      ship({ channel: "contract_brewing", invoiceId: "INV-PRODUCT", invoiceHasInventoryLine: true }),
    ])).toEqual(new Set(["R1"]));
  });

  it("defers a recipe if ANY of its shipments is pending", () => {
    expect(selectPendingDeductionRecipes([
      ship({ status: "paid" }),
      ship(),
    ])).toEqual(new Set(["R1"]));
  });

  it("keeps recipes independent of one another", () => {
    expect(selectPendingDeductionRecipes([
      ship({ recipeId: "R1" }),
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

  it("ignores rows with no recipe... none exist by construction of the loader", () => {
    expect(selectPendingDeductionRecipes([])).toEqual(new Set());
  });
});

describe("selectPendingDeductionHolds", () => {
  // The two holds mean different things to whoever is looking at the screen:
  // one is waiting on the customer, the other is waiting on someone here to
  // raise the invoice. Only the second is theirs to clear.
  it("labels a sent invoice as awaiting payment, with the invoice named", () => {
    expect(selectPendingDeductionHolds([ship({ status: "unpaid", invoiceId: "INV-1" })])).toEqual([
      { recipeId: "R1", reason: "awaiting_payment", invoiceIds: ["INV-1"] },
    ]);
  });

  it("labels a drafted invoice as awaiting invoice", () => {
    expect(selectPendingDeductionHolds([ship({ status: "invoice_required", invoiceId: "INV-2" })])).toEqual([
      { recipeId: "R1", reason: "awaiting_invoice", invoiceIds: ["INV-2"] },
    ]);
  });

  it("labels a shipment with no invoice at all as awaiting invoice, naming none", () => {
    expect(selectPendingDeductionHolds([
      ship({ status: "invoice_required", invoiceId: null, invoiceHasInventoryLine: null }),
    ])).toEqual([{ recipeId: "R1", reason: "awaiting_invoice", invoiceIds: [] }]);
  });

  // A recipe held by both kinds at once reports the one with a name on it —
  // "chase invoice 000054" beats "something of this beer is unbilled".
  it("prefers awaiting_payment when a recipe is held by both, and merges invoices", () => {
    expect(selectPendingDeductionHolds([
      ship({ status: "invoice_required", invoiceId: "INV-2" }),
      ship({ status: "unpaid", invoiceId: "INV-1" }),
    ])).toEqual([{ recipeId: "R1", reason: "awaiting_payment", invoiceIds: ["INV-2", "INV-1"] }]);
  });

  it("holds nothing once paid", () => {
    expect(selectPendingDeductionHolds([ship({ status: "paid" })])).toEqual([]);
  });
});
