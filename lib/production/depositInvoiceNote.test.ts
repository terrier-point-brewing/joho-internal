import { describe, it, expect } from "vitest";
import { depositInvoiceDescription, type DepositBasis } from "./depositInvoiceNote";

const base: DepositBasis = {
  beerName: "Hazy IPA V.1", batchNumber: "B-071", percentage: 90, batchBbl: 20,
  origin: { kind: "portal_claim", requestedBbl: 18 },
  projectedYieldBbl: 16.67, packagingYieldPct: 90, excludedBeerNames: [],
};

describe("depositInvoiceDescription", () => {
  it("explains a portal claim: bbl claimed, share of the batch, estimated yield of that share", () => {
    expect(depositInvoiceDescription(base)).toBe(
      "Ingredient deposit for your Hazy IPA V.1 batch B-071. " +
      "You claimed 18.00 bbl of this beer through the partner portal, which is 90.0% of the 20.00 bbl batch. " +
      "The batch is currently estimated to yield 16.67 bbl after packaging (beer still in tank counted at 90%), so your share is about 15.00 bbl. " +
      "The deposit is 90.0% of the batch's ingredient cost.",
    );
  });

  it("explains a partial batch request in the share the partner asked for", () => {
    const text = depositInvoiceDescription({
      ...base, percentage: 50, batchBbl: 40,
      origin: { kind: "portal_batch", requestedBbl: 20, sharePct: 50, brewBbl: 40 },
    });
    expect(text).toContain("You requested 50.0% of a 40.00 bbl brew through the partner portal (20.00 bbl), which is 50.0% of the 40.00 bbl batch.");
  });

  it("explains a whole-brew request without a redundant share", () => {
    const text = depositInvoiceDescription({
      ...base, percentage: 100, origin: { kind: "portal_batch", requestedBbl: 20, sharePct: 100, brewBbl: 20 },
    });
    expect(text).toContain("You requested this brew through the partner portal (20.00 bbl), which is 100.0% of the 20.00 bbl batch.");
  });

  it("falls back to the commitment, then to the bare allocation", () => {
    expect(depositInvoiceDescription({ ...base, origin: { kind: "commitment", requestedBbl: 18 } }))
      .toContain("Your commitment is for 18.00 bbl, which is 90.0% of the 20.00 bbl batch.");
    expect(depositInvoiceDescription({ ...base, origin: { kind: "none" } }))
      .toContain("Your allocation is 90.0% of the 20.00 bbl batch.");
  });

  it("says when the yield is not known yet and names netted-out recipes", () => {
    const text = depositInvoiceDescription({ ...base, projectedYieldBbl: null, excludedBeerNames: ["Carolina Mule"] });
    expect(text).toContain("Nothing has been transferred yet, so the batch's estimated yield is not known.");
    expect(text).toContain("The deposit is 90.0% of the batch's ingredient cost, net of the Carolina Mule ingredients already billed.");
  });
});
