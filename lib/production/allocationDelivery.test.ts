import { describe, it, expect } from "vitest";
import { isFullyDelivered, owedBbl, sumExportedByAllocation } from "./allocationDelivery";

describe("sumExportedByAllocation", () => {
  it("sums by allocation and ignores rows with no allocation (over-delivery, ad-hoc)", () => {
    const m = sumExportedByAllocation([
      { allocation_id: "a", volume_bbl: 5.8034 },
      { allocation_id: "a", volume_bbl: "10.1966" },
      { allocation_id: "b", volume_bbl: 2 },
      { allocation_id: null, volume_bbl: 14 },
    ]);
    expect(m.get("a")).toBeCloseTo(16, 6);
    expect(m.get("b")).toBe(2);
    expect(m.size).toBe(2);
  });

  it("a reversal row (negative volume) nets against the same allocation", () => {
    const m = sumExportedByAllocation([
      { allocation_id: "a", volume_bbl: 4 },
      { allocation_id: "a", volume_bbl: -4 },
    ]);
    expect(m.get("a")).toBe(0);
  });
});

describe("owedBbl", () => {
  it("contract: share of produced, capped at booked", () => {
    expect(owedBbl({ channel: "contract_brewing", percentage: 75, producedBbl: 32.56, bookedBbl: 30 })).toBeCloseTo(24.42, 2);
    expect(owedBbl({ channel: "contract_brewing", percentage: 100, producedBbl: 21.8, bookedBbl: 15 })).toBe(15);
  });
  it("soft channels: share of produced, no cap", () => {
    expect(owedBbl({ channel: "distribution", percentage: 12.5, producedBbl: 36.34, bookedBbl: 5 })).toBeCloseTo(4.5425, 4);
  });
});

describe("isFullyDelivered", () => {
  it("met within a 0.01 bbl tolerance; never met when nothing is owed yet", () => {
    expect(isFullyDelivered(17.6, 17.607)).toBe(true);
    expect(isFullyDelivered(11.5, 24.53)).toBe(false);
    expect(isFullyDelivered(0, 0)).toBe(false);
  });
});
