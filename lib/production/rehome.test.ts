import { describe, it, expect } from "vitest";
import { netOfCredited, depositRemainingCents, splitAutoHome, bblToPct, drawsFromBody, pendingConversionBbl, planAutoHome, planRehome, refundCentsForDraw, type HomeSource } from "./rehome";

const taproom: HomeSource = { kind: "allocation", allocationId: "t", channel: "taproom", partnerName: null, percentage: 15, freeBbl: 4.88, requires: "none" };
const unallocated: HomeSource = { kind: "unallocated", allocationId: null, channel: null, partnerName: null, percentage: 20, freeBbl: 6.5, requires: "none" };
const paid: HomeSource = { kind: "allocation", allocationId: "p", channel: "contract_brewing", partnerName: "Fortnight Brewing", percentage: 30, freeBbl: 3, requires: "refund", deposit: { paidCents: 90000, refundable: true } };

describe("planRehome", () => {
  it("sizes the move against produced volume once the batch is packaged", () => {
    // B-034: 32.56 produced; 2.13 bbl over → 6.54% moves from taproom to the partner.
    const plan = planRehome({ bbl: 2.13, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom });
    expect(plan).toEqual({ deltaPct: 6.54, basisBbl: 32.56, sourceNewPct: 8.46, targetNewPct: 81.54, refundCents: 0 });
    expect(bblToPct(2.13, 32.56)).toBe(6.54);
  });

  it("falls back to planned volume before anything is packaged", () => {
    const plan = planRehome({ bbl: 4, yieldBbl: 0, plannedBbl: 40, targetPct: 70, source: unallocated });
    expect(plan).toEqual({ deltaPct: 10, basisBbl: 40, sourceNewPct: null, targetNewPct: 80, refundCents: 0 });
  });

  it("refuses to draw more than the source can give up", () => {
    expect(() => planRehome({ bbl: 5, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom }))
      .toThrow(/can only give up 4.88 bbl/);
  });

  it("refuses a paid allocation until the refund it implies is confirmed", () => {
    expect(() => planRehome({ bbl: 1, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: paid }))
      .toThrow(/Fortnight Brewing's deposit is paid.*confirm the refund/);
  });

  it("draws on a paid allocation against the exact slice of its deposit", () => {
    // 1 bbl of 32.56 = 3.07%; 30% → 26.93% refunds $900 × (1 − 26.93/30) = $92.10.
    expect(refundCentsForDraw(paid, 1, 32.56)).toBe(9210);
    const plan = planRehome({ bbl: 1, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: paid, refund: { acknowledgedCents: 9210 } });
    expect(plan).toEqual({ deltaPct: 3.07, basisBbl: 32.56, sourceNewPct: 26.93, targetNewPct: 78.07, refundCents: 9210 });
  });

  it("refuses when the confirmed refund no longer matches, and a deposit the app cannot refund", () => {
    expect(() => planRehome({ bbl: 1, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: paid, refund: { acknowledgedCents: 9000 } }))
      .toThrow(/now \$92.10, not \$90.00/);
    const untracked: HomeSource = { ...paid, deposit: { paidCents: 0, refundable: false } };
    expect(() => planRehome({ bbl: 1, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: untracked, refund: { acknowledgedCents: 0 } }))
      .toThrow(/Square Dashboard/);
  });

  it("never empties a paid partner's share", () => {
    const whole: HomeSource = { ...paid, freeBbl: 9.768 };
    expect(() => planRehome({ bbl: 9.768, yieldBbl: 32.56, plannedBbl: 40, targetPct: 0, source: whole, refund: { acknowledgedCents: 90000 } }))
      .toThrow(/take all of Fortnight Brewing's share/);
  });

  it("refuses to push the target past 100% or move nothing", () => {
    expect(() => planRehome({ bbl: 10, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: { ...unallocated, freeBbl: 20 } })).toThrow(/above 100%/);
    expect(() => planRehome({ bbl: 0, yieldBbl: 32.56, plannedBbl: 40, targetPct: 75, source: taproom })).toThrow(/Nothing to move/);
  });
});

describe("planRehome — self", () => {
  it("when the target's own share already covers it, nothing moves and only the booking rises", () => {
    const self: HomeSource = { kind: "self", allocationId: "me", channel: "contract_brewing", partnerName: "Argus", percentage: 100, freeBbl: 0.5, requires: "none" };
    expect(planRehome({ bbl: 0.5, yieldBbl: 5.17, plannedBbl: 5.17, targetPct: 100, source: self }))
      .toEqual({ deltaPct: 0, basisBbl: 5.17, sourceNewPct: null, targetNewPct: 100, refundCents: 0 });
  });
});

describe("planAutoHome", () => {
  const self: HomeSource = { kind: "self", allocationId: "me", channel: "distribution", partnerName: "Fortnight Brewing", percentage: 20, freeBbl: 5.82, requires: "none" };

  it("takes the deal's own unshipped share first, less what this shipment already credits to it", () => {
    // Booked 4 on a 5.82 bbl share; shipping 5 credits 4 and leaves 1 over.
    expect(planAutoHome([self, taproom], 1, 4)).toEqual([{ source: { kind: "allocation", allocationId: "me" }, label: "their own unshipped share", bbl: 1, bookBbl: 1 }]);
  });

  it("then the unallocated remainder, then the taproom", () => {
    // 5.82 − 4 leaves 1.82 of their own; the other 8.18 comes from ours.
    expect(planAutoHome([self, taproom, unallocated, paid], 10, 4)).toEqual([
      { source: { kind: "allocation", allocationId: "me" }, label: "their own unshipped share", bbl: 1.82, bookBbl: 1.82 },
      { source: { kind: "unallocated" }, label: "the unallocated share", bbl: 6.5, bookBbl: 6.5 },
      { source: { kind: "allocation", allocationId: "t" }, label: "the taproom", bbl: 1.68, bookBbl: 1.68 },
    ]);
  });

  it("never draws on another partner: when ours cannot cover it, a person decides", () => {
    expect(planAutoHome([taproom, paid], 6)).toBeNull();
    expect(planAutoHome([paid], 1)).toBeNull();
  });

  it("restores share the deal already shipped against, without booking it", () => {
    // B-056: finished 3.0 bbl short, leaving Argus 1.57 bbl under what had
    // shipped. Shipping 3.5 more needs 5.07 of share but books only 3.5.
    const free: HomeSource = { ...unallocated, freeBbl: 4.09 };
    expect(planAutoHome([free, taproom], 3.5, 0, 1.57)).toEqual([
      { source: { kind: "unallocated" }, label: "the unallocated share", bbl: 4.09, bookBbl: 2.52 },
      { source: { kind: "allocation", allocationId: "t" }, label: "the taproom", bbl: 0.98, bookBbl: 0.98 },
    ]);
    expect(planAutoHome([{ ...taproom, freeBbl: 4.75 }], 3.5, 0, 1.57)).toBeNull();
  });
});

describe("pendingConversionBbl", () => {
  it("reserves only conversions that have not happened: an executed one is already out of the yield", () => {
    expect(pendingConversionBbl([
      { volume_bbl: 5.17, converted_at: "2026-09-11T19:20:06Z" },
      { volume_bbl: "2", converted_at: null },
    ])).toBe(2);
  });
});

describe("planRehome — booking a new commitment at the Export Bay", () => {
  it("sizes the new allocation from zero and takes the same share off the taproom plan", () => {
    // B-064 shape: 100% taproom; Argus ships 3.1 bbl with no commitment.
    const fullTaproom: HomeSource = { kind: "allocation", allocationId: "t", channel: "taproom", partnerName: null, percentage: 100, freeBbl: 31, requires: "none" };
    expect(planRehome({ bbl: 3.1, yieldBbl: 31, plannedBbl: 40, targetPct: 0, source: fullTaproom }))
      .toEqual({ deltaPct: 10, basisBbl: 31, sourceNewPct: 90, targetNewPct: 10, refundCents: 0 });
  });
});

describe("drawsFromBody — a split across sources", () => {
  it("reads a draws list, carrying each confirmed refund", () => {
    expect(drawsFromBody({ draws: [
      { source: { kind: "allocation", allocation_id: "t" }, bbl: 5.38 },
      { source: { kind: "allocation", allocation_id: "p" }, bbl: "0.85", refund_cents: 3265 },
    ] })).toEqual([
      { source: { kind: "allocation", allocationId: "t" }, bbl: 5.38, refund: null },
      { source: { kind: "allocation", allocationId: "p" }, bbl: 0.85, refund: { acknowledgedCents: 3265 } },
    ]);
  });

  it("still accepts the older single source + bbl body", () => {
    expect(drawsFromBody({ source: { kind: "unallocated" }, bbl: 2 })).toEqual([{ source: { kind: "unallocated" }, bbl: 2, refund: null }]);
    expect(drawsFromBody({ source: { kind: "unallocated" } }, 6.23)).toEqual([{ source: { kind: "unallocated" }, bbl: 6.23, refund: null }]);
  });

  it("refuses an empty list, a repeated source, a missing id, or a non-positive bbl", () => {
    expect(() => drawsFromBody({ draws: [] })).toThrow(/Choose where/);
    expect(() => drawsFromBody({ draws: [{ source: { kind: "unallocated" }, bbl: 1 }, { source: { kind: "unallocated" }, bbl: 1 }] })).toThrow(/listed twice/);
    expect(() => drawsFromBody({ draws: [{ source: { kind: "allocation" }, bbl: 1 }] })).toThrow(/allocation_id/);
    expect(() => drawsFromBody({ draws: [{ source: { kind: "unallocated" }, bbl: 0 }] })).toThrow(/positive bbl/);
  });
});

describe("netOfCredited", () => {
  const self: HomeSource = { kind: "self", allocationId: "me", channel: "distribution", partnerName: "Fortnight Brewing", percentage: 78, freeBbl: 6.82, requires: "none" };
  const taproom: HomeSource = { kind: "allocation", allocationId: "t", channel: "taproom", partnerName: null, percentage: 2, freeBbl: 0.33, requires: "none" };
  it("lists the deal's own share net of what the shipment already credits to it (B-067: 6.82 free, 5.86 credited → 0.96)", () => {
    expect(netOfCredited([self, taproom], 5.86)).toEqual([{ ...self, freeBbl: 0.96 }, taproom]);
  });
  it("drops the deal's own share when the credit uses all of it", () => {
    expect(netOfCredited([self, taproom], 6.82)).toEqual([taproom]);
  });
});

describe("depositRemainingCents", () => {
  it("prices a second reduction off what the deposit still holds (Argus on B-067: $482.18 paid, $344.41 refunded → $137.77)", () => {
    expect(depositRemainingCents({ deposit_amount_paid_cents: 48218, refund_amount_cents: 34441 })).toBe(13777);
    expect(depositRemainingCents({ deposit_amount_paid_cents: "48218", refund_amount_cents: null })).toBe(48218);
  });
});

describe("splitAutoHome", () => {
  const self: HomeSource = { kind: "self", allocationId: "me", channel: "distribution", partnerName: "Fortnight Brewing", percentage: 78, freeBbl: 0.96, requires: "none" };
  const taproom: HomeSource = { kind: "allocation", allocationId: "t", channel: "taproom", partnerName: null, percentage: 2, freeBbl: 0.33, requires: "none" };
  const paid: HomeSource = { kind: "allocation", allocationId: "p", channel: "contract_brewing", partnerName: "Argus", percentage: 20, freeBbl: 1.35, requires: "refund", deposit: { paidCents: 13777, refundable: true } };
  it("takes ours as far as it goes and asks only for the remainder, from other partners (B-067: 1.48 over)", () => {
    const split = splitAutoHome([self, taproom, paid], 1.48);
    expect(split.auto).toEqual([
      { source: { kind: "allocation", allocationId: "me" }, label: "their own unshipped share", bbl: 0.96, bookBbl: 0.96 },
      { source: { kind: "allocation", allocationId: "t" }, label: "the taproom", bbl: 0.33, bookBbl: 0.33 },
    ]);
    expect(split.askBbl).toBe(0.19);
    expect(split.askSources).toEqual([paid]);
  });
  it("asks nothing when ours covers it", () => {
    const split = splitAutoHome([self, taproom, paid], 1);
    expect(split.askBbl).toBe(0);
    expect(split.auto.map((d) => d.bbl)).toEqual([0.96, 0.04]);
  });
  it("restores short share through the auto draws before the operator's book", () => {
    const split = splitAutoHome([taproom, paid], 1, 0.5);
    expect(split.auto).toEqual([{ source: { kind: "allocation", allocationId: "t" }, label: "the taproom", bbl: 0.33, bookBbl: 0 }]);
    expect(split.shortLeft).toBe(0.17);
    expect(split.askBbl).toBe(1);
  });
});
