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

  it("measures a part-packaged batch against its projected yield, not just what is packaged so far", () => {
    // 40 planned; 28 packaged and 25 of it shipped to the contract partner; ~10.8 more expected from the tank.
    const p = claimPool({ planned_bbl: 40, produced_bbl: 28, projected_bbl: 38.8, converted_bbl: 0, bufferPct: 10, total_exported_bbl: 25,
      allocations: [alloc("c", "contract_brewing", 57, 24), alloc("t", "taproom", 30)] });
    // pool: taproom 11.64 + unallocated 13% 5.04 = 16.68; on hand 13.8 − owed to partner 0 (over-shipped); reserve 3.88.
    expect(p.basisBbl).toBe(38.8);
    expect(p.claimableBbl).toBe(9.92);
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

describe("claimPool — ready now vs still in tank", () => {
  it("calls none of it ready while nothing is packaged", () => {
    const p = claimPool({ planned_bbl: 20, produced_bbl: 0, converted_bbl: 0, bufferPct: 10,
      allocations: [alloc("c", "contract_brewing", 70), alloc("t", "taproom", 30)] });
    expect(p).toMatchObject({ claimableBbl: 4, readyNowBbl: 0, inTankBbl: 4 });
  });

  it("splits a part-packaged batch: what is on the floor, and what is still to come", () => {
    // 28 packaged, 25 shipped (24 of it to the contract partner, who is owed 57% × 28 = 15.96 → nothing more yet).
    const p = claimPool({ planned_bbl: 40, produced_bbl: 28, projected_bbl: 38.8, converted_bbl: 0, bufferPct: 10, total_exported_bbl: 25,
      allocations: [alloc("c", "contract_brewing", 57, 24), alloc("t", "taproom", 30)] });
    expect(p.claimableBbl).toBe(9.92);
    expect(p.readyNowBbl).toBe(3);      // 28 − 25 on the floor
    expect(p.inTankBbl).toBe(6.92);
  });

  it("holds back packaged beer another partner is still owed", () => {
    // 30 packaged, 5 shipped to the partner, who is owed 50% × 30 = 15 → 10 of the 25 on the floor is theirs.
    const p = claimPool({ planned_bbl: 40, produced_bbl: 30, projected_bbl: 39, converted_bbl: 0, bufferPct: 0, total_exported_bbl: 5,
      allocations: [alloc("c", "contract_brewing", 50, 5), alloc("t", "taproom", 50)] });
    expect(p.readyNowBbl).toBe(15);
    expect(p.readyNowBbl + p.inTankBbl).toBe(p.claimableBbl);
  });

  it("is all ready once the tank is empty", () => {
    const p = claimPool({ planned_bbl: 40, produced_bbl: 36, projected_bbl: 36, converted_bbl: 0, bufferPct: 10, total_exported_bbl: 18,
      allocations: [alloc("c", "contract_brewing", 50, 18), alloc("t", "taproom", 50)] });
    expect(p).toMatchObject({ claimableBbl: 14.4, readyNowBbl: 14.4, inTankBbl: 0 });
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
