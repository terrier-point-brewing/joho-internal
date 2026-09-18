import { describe, expect, it } from "vitest";
import { claimPool, planClaim, visibleToPartner } from "./claimable";

const alloc = (id: string, channel: string, percentage: number, exported_bbl = 0) =>
  ({ id, channel, percentage, exported_bbl, written_off_at: null });

describe("claimPool", () => {
  it("offers the taproom's share less the batch-wide buffer", () => {
    const p = claimPool({ planned_bbl: 40, produced_bbl: 0, converted_bbl: 0, bufferPct: 10,
      allocations: [alloc("c", "contract_brewing", 50), alloc("t", "taproom", 50)] });
    // taproom 20 bbl, buffer 4 bbl.
    expect(p).toMatchObject({ basisBbl: 40, bufferBbl: 4, claimableBbl: 16 });
  });

  it("uses packaged volume once there is any, and nets what the taproom already took", () => {
    const p = claimPool({ planned_bbl: 40, produced_bbl: 36, converted_bbl: 0, bufferPct: 10,
      allocations: [alloc("c", "contract_brewing", 50), alloc("t", "taproom", 50, 10)] });
    // share 18 − shipped 10 = 8; buffer 3.6.
    expect(p.claimableBbl).toBe(4.4);
  });

  it("counts the unallocated remainder and draws from it first", () => {
    const p = claimPool({ planned_bbl: 20, produced_bbl: 0, converted_bbl: 0, bufferPct: 5,
      allocations: [alloc("t", "taproom", 60)] });
    expect(p.claimableBbl).toBe(19);
    expect(p.sources.map((s) => s.allocationId)).toEqual([null, "t"]);
  });

  it("never counts partner, safety-stock, written-off or converted share", () => {
    const p = claimPool({ planned_bbl: 40, produced_bbl: 0, converted_bbl: 10, bufferPct: 0,
      allocations: [
        alloc("d", "distribution", 25), alloc("s", "safety_stock", 25),
        { ...alloc("w", "taproom", 25), written_off_at: "2026-09-01" },
      ] });
    expect(p.claimableBbl).toBe(0);
  });

  it("caps packaged beer at what is physically on hand after other partners' shares", () => {
    // Paper: taproom share 18, nothing credited to it. Reality: 30 of 36 bbl
    // has left the building, 10 of it against the partner's 18.
    const p = claimPool({ planned_bbl: 40, produced_bbl: 36, converted_bbl: 0, bufferPct: 0, total_exported_bbl: 30,
      allocations: [alloc("c", "contract_brewing", 50, 10), alloc("t", "taproom", 50)] });
    // on hand 6 − still owed to the partner 8 → nothing to claim.
    expect(p.claimableBbl).toBe(0);
  });

  it("is zero when the buffer swallows the pool", () => {
    const p = claimPool({ planned_bbl: 40, produced_bbl: 0, converted_bbl: 0, bufferPct: 10,
      allocations: [alloc("c", "contract_brewing", 92), alloc("t", "taproom", 8)] });
    expect(p.claimableBbl).toBe(0);
  });
});

describe("planClaim", () => {
  const pool = claimPool({ planned_bbl: 40, produced_bbl: 0, converted_bbl: 0, bufferPct: 10,
    allocations: [alloc("c", "contract_brewing", 40), alloc("t", "taproom", 50)] });
  // unallocated 10% = 4 bbl, taproom 20 bbl, buffer 4 → 20 claimable.

  it("drains unallocated first, then shrinks the taproom", () => {
    const plan = planClaim(pool, 10);
    expect(plan.targetPct).toBe(25);
    expect(plan.draws).toEqual([
      { allocationId: null, bbl: 4, newPct: null },
      { allocationId: "t", bbl: 6, newPct: 35 },
    ]);
  });

  it("refuses more than is claimable, naming the reserve", () => {
    expect(() => planClaim(pool, 21)).toThrow(/Only 20 bbl.*4 bbl reserve/);
  });

  it("refuses nothing", () => {
    expect(() => planClaim(pool, 0)).toThrow("Nothing to claim.");
  });
});

describe("visibleToPartner", () => {
  it("hides only an exclusive partner's beer, and never from its owner", () => {
    expect(visibleToPartner("a", { partner_id: "b", exclusive: false })).toBe(true);
    expect(visibleToPartner("a", { partner_id: "b", exclusive: true })).toBe(false);
    expect(visibleToPartner("b", { partner_id: "b", exclusive: true })).toBe(true);
    expect(visibleToPartner("a", { partner_id: null, exclusive: false })).toBe(true);
  });
});
