import { describe, it, expect } from "vitest";
import { bblToPct, planRehome, type HomeSource } from "./rehome";

const taproom: HomeSource = { kind: "allocation", allocationId: "t", channel: "taproom", partnerName: null, percentage: 15, freeBbl: 4.88, requires: "none" };
const unallocated: HomeSource = { kind: "unallocated", allocationId: null, channel: null, partnerName: null, percentage: 20, freeBbl: 6.5, requires: "none" };
const paid: HomeSource = { kind: "allocation", allocationId: "p", channel: "contract_brewing", partnerName: "Fortnight Brewing", percentage: 30, freeBbl: 3, requires: "refund" };

describe("planRehome", () => {
  it("sizes the move against produced volume once the batch is packaged", () => {
    // B-034: 32.56 produced; 2.13 bbl over → 6.54% moves from taproom to the partner.
    const plan = planRehome({ bbl: 2.13, producedBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom });
    expect(plan).toEqual({ deltaPct: 6.54, basisBbl: 32.56, sourceNewPct: 8.46, targetNewPct: 81.54 });
    expect(bblToPct(2.13, 32.56)).toBe(6.54);
  });

  it("falls back to planned volume before anything is packaged", () => {
    const plan = planRehome({ bbl: 4, producedBbl: 0, plannedBbl: 40, targetPct: 70, source: unallocated });
    expect(plan).toEqual({ deltaPct: 10, basisBbl: 40, sourceNewPct: null, targetNewPct: 80 });
  });

  it("refuses to draw more than the source can give up", () => {
    expect(() => planRehome({ bbl: 5, producedBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom }))
      .toThrow(/can only give up 4.88 bbl/);
  });

  it("refuses a paid allocation and points at the refund flow", () => {
    expect(() => planRehome({ bbl: 1, producedBbl: 32.56, plannedBbl: 40, targetPct: 75, source: paid }))
      .toThrow(/Fortnight Brewing's deposit is paid.*refund/);
  });

  it("refuses to push the target past 100% or move nothing", () => {
    expect(() => planRehome({ bbl: 10, producedBbl: 32.56, plannedBbl: 40, targetPct: 75, source: { ...unallocated, freeBbl: 20 } })).toThrow(/above 100%/);
    expect(() => planRehome({ bbl: 0, producedBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom })).toThrow(/Nothing to move/);
  });
});

describe("planRehome — self", () => {
  it("when the target's own share already covers it, nothing moves and only the booking rises", () => {
    const self: HomeSource = { kind: "self", allocationId: "me", channel: "contract_brewing", partnerName: "Argus", percentage: 100, freeBbl: 0.5, requires: "none" };
    expect(planRehome({ bbl: 0.5, producedBbl: 5.17, plannedBbl: 5.17, targetPct: 100, source: self }))
      .toEqual({ deltaPct: 0, basisBbl: 5.17, sourceNewPct: null, targetNewPct: 100 });
  });
});
