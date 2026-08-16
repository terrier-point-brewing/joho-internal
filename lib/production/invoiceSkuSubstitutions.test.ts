import { describe, it, expect } from "vitest";
import { selectRecordableSubstitutions, type SubstitutionClaim } from "./invoiceSkuSubstitutions";

const claim = (over: Partial<SubstitutionClaim> = {}): SubstitutionClaim => ({
  exportTransactionId: "tx-fortnight",
  squareVariationId: "sq-house-sixtel",
  restoreInventory: true,
  ...over,
});

describe("selectRecordableSubstitutions", () => {
  it("records a claim whose shipment the database agrees is unlinked", () => {
    const rows = selectRecordableSubstitutions([claim()], new Map([["tx-fortnight", 20]]));
    expect(rows).toEqual([
      { exportTransactionId: "tx-fortnight", squareVariationId: "sq-house-sixtel", quantity: 20, restoreInventory: true },
    ]);
  });

  it("takes the quantity from the shipment, never from the claim", () => {
    // The claim carries no quantity by design — this is the assertion that keeps
    // it that way, so a client can't ask Square to be credited 200 for a 20-keg
    // shipment.
    const rows = selectRecordableSubstitutions([claim()], new Map([["tx-fortnight", 20]]));
    expect(rows[0].quantity).toBe(20);
  });

  it("drops a claim for a shipment that HAS its own Square link", () => {
    // Square deducted the right SKU for real stock; crediting it back would
    // invent 20 kegs of inventory.
    expect(selectRecordableSubstitutions([claim({ exportTransactionId: "tx-house" })], new Map([["tx-fortnight", 20]])))
      .toEqual([]);
  });

  it("drops a claim for a shipment outside the invoice's selection", () => {
    expect(selectRecordableSubstitutions([claim({ exportTransactionId: "tx-elsewhere" })], new Map())).toEqual([]);
  });

  it("drops a claim with no borrowed variation", () => {
    expect(selectRecordableSubstitutions([claim({ squareVariationId: "" })], new Map([["tx-fortnight", 20]]))).toEqual([]);
  });

  it("keeps only the first claim per shipment", () => {
    const rows = selectRecordableSubstitutions(
      [claim(), claim({ squareVariationId: "sq-other" })],
      new Map([["tx-fortnight", 20]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].squareVariationId).toBe("sq-house-sixtel");
  });

  it("records an opted-out claim, so the substitution is still on the record", () => {
    const rows = selectRecordableSubstitutions(
      [claim({ restoreInventory: false })],
      new Map([["tx-fortnight", 20]]),
    );
    expect(rows).toEqual([
      { exportTransactionId: "tx-fortnight", squareVariationId: "sq-house-sixtel", quantity: 20, restoreInventory: false },
    ]);
  });

  it("drops a zero-quantity shipment", () => {
    expect(selectRecordableSubstitutions([claim()], new Map([["tx-fortnight", 0]]))).toEqual([]);
  });
});
