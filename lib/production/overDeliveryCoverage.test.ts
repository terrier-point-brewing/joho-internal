import { describe, it, expect } from "vitest";
import { coveredOverDeliveryBbl } from "./overDeliveryCoverage";

describe("coveredOverDeliveryBbl", () => {
  it("covers beer past the booking that is still inside the paid share", () => {
    // 50% paid up front on a batch that yielded 21: the share is 10.5 bbl, the
    // booking stopped crediting at 10, so the 0.5 bbl past it is already paid for.
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 0.5, paidShareBbl: 10.5, creditedBbl: 10, earlierOverBbl: 0 })).toBe(0.5);
  });

  it("charges only the part beyond the paid share", () => {
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 2, paidShareBbl: 10.5, creditedBbl: 10, earlierOverBbl: 0 })).toBe(0.5);
  });

  it("lets an earlier over-delivery use the headroom first", () => {
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 1, paidShareBbl: 10.5, creditedBbl: 10, earlierOverBbl: 0.5 })).toBe(0);
  });

  it("lends no cover when shrinkage left the share below what already shipped", () => {
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 1, paidShareBbl: 9, creditedBbl: 9, earlierOverBbl: 0 })).toBe(0);
  });

  it("lends no cover without an up-front deposit", () => {
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 3, paidShareBbl: 0, creditedBbl: 0, earlierOverBbl: 0 })).toBe(0);
  });

  it("does not leave float dust chargeable", () => {
    expect(coveredOverDeliveryBbl({ selectedOverBbl: 0.5, paidShareBbl: 10.4979, creditedBbl: 10, earlierOverBbl: 0 })).toBe(0.5);
  });
});
