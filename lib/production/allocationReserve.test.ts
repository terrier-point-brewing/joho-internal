import { describe, it, expect } from "vitest";
import {
  allocationView,
  batchReserve,
  planShipment,
  planCreditedWrites,
  completionReconciliation,
  assessWriteOff,
  isDepositBacked,
  WRITE_OFF_WARN_FRACTION,
  type AllocationInput,
  type BatchInput,
  type ShipmentWarning,
} from "./allocationReserve";

function alloc(over: Partial<AllocationInput> = {}): AllocationInput {
  return { id: "a1", batchId: "b1", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0, ...over };
}
function batch(over: Partial<BatchInput> = {}): BatchInput {
  return { batchId: "b1", producedBbl: 16, totalExportedBbl: 0, status: "packaging", allocations: [], ...over };
}
function hasType(ws: ShipmentWarning[], t: ShipmentWarning["type"]) {
  return ws.some((w) => w.type === t);
}

describe("isDepositBacked", () => {
  it("only contract_brewing is deposit-backed", () => {
    expect(isDepositBacked("contract_brewing")).toBe(true);
    expect(isDepositBacked("distribution")).toBe(false);
    expect(isDepositBacked("wholesale")).toBe(false);
    expect(isDepositBacked("safety_stock")).toBe(false);
  });
});

describe("allocationView", () => {
  it("contract, incomplete batch: realizable set, final null, not fulfilled", () => {
    const v = allocationView(alloc({ exportedBbl: 0 }), batch({ producedBbl: 16, status: "packaging" }));
    expect(v.depositBacked).toBe(true);
    expect(v.realizableBbl).toBeCloseTo(12); // 75% × 16
    expect(v.finalEntitlementBbl).toBeNull();
    expect(v.fulfilled).toBe(false);
  });

  it("contract, complete batch: final set, fulfilled when exported ≥ A", () => {
    const complete = batch({ producedBbl: 16, status: "complete" });
    expect(allocationView(alloc({ exportedBbl: 12 }), complete).finalEntitlementBbl).toBeCloseTo(12);
    expect(allocationView(alloc({ exportedBbl: 12 }), complete).fulfilled).toBe(true);
    expect(allocationView(alloc({ exportedBbl: 11 }), complete).fulfilled).toBe(false);
  });

  it("soft allocation: fulfilled against realizable, no deposit backing", () => {
    const soft = alloc({ channel: "distribution", percentage: 50, bookedBbl: null, exportedBbl: 8 });
    const v = allocationView(soft, batch({ producedBbl: 16, status: "packaging" }));
    expect(v.depositBacked).toBe(false);
    expect(v.realizableBbl).toBeCloseTo(8);
    expect(v.fulfilled).toBe(true); // 8 ≥ 8
    expect(allocationView({ ...soft, exportedBbl: 7 }, batch({ producedBbl: 16 })).fulfilled).toBe(false);
  });

  it("zero produced: no NaN", () => {
    const v = allocationView(alloc(), batch({ producedBbl: 0, status: "complete" }));
    expect(v.realizableBbl).toBe(0);
    expect(v.finalEntitlementBbl).toBe(0);
  });

  it("written-off allocation is fulfilled even when under-delivered on an incomplete batch", () => {
    const v = allocationView(alloc({ exportedBbl: 2, writtenOff: true }), batch({ producedBbl: 16, status: "packaging" }));
    expect(v.writtenOff).toBe(true);
    expect(v.fulfilled).toBe(true); // forgiven → closed
  });
});

describe("batchReserve", () => {
  it("reserves the contract owed, computes on-hand and free-to-ship", () => {
    const b = batch({
      producedBbl: 16,
      totalExportedBbl: 4,
      allocations: [
        alloc({ id: "c", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 3 }),
        alloc({ id: "s", channel: "distribution", percentage: 25, bookedBbl: null, exportedBbl: 1 }),
      ],
    });
    const r = batchReserve(b);
    expect(r.reservedForContractBbl).toBeCloseTo(9);  // 0.75×16 − 3
    expect(r.onHandBbl).toBeCloseTo(12);              // 16 − 4
    expect(r.freeToShipBbl).toBeCloseTo(3);           // 12 − 9
    expect(r.underCovered).toBe(false);               // on-hand 12 ≥ reserve 9
  });

  it("underCovered when a COMPLETE batch can no longer cover what it still owes", () => {
    const b = batch({
      producedBbl: 12,
      totalExportedBbl: 11, // most of it went elsewhere
      status: "complete",
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 2 })],
    });
    // owes 0.75×12 − 2 = 7, holds 12 − 11 = 1
    expect(batchReserve(b).underCovered).toBe(true);
  });

  it("NOT underCovered when a complete batch merely yielded below its booked estimate", () => {
    // Shrinkage is borne pro-rata by the partner: delivering their share of the
    // ACTUAL produced fully settles the deposit, even though 12 < booked 15.
    const b = batch({
      producedBbl: 12,
      totalExportedBbl: 9,
      status: "complete",
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 9 })],
    });
    expect(batchReserve(b).underCovered).toBe(false);
  });

  it("NOT underCovered before the batch is complete (production still climbing)", () => {
    // A batch that hasn't finished packaging (or hasn't started) is expected to
    // sit below its guaranteed total — that is not a shortfall, so no badge.
    expect(batchReserve(batch({ producedBbl: 0, status: "planning",
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15 })] })).underCovered).toBe(false);
    expect(batchReserve(batch({ producedBbl: 8, status: "packaging",
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15 })] })).underCovered).toBe(false);
  });

  it("a written-off contract allocation releases its reserve and clears under-coverage", () => {
    const b = batch({
      producedBbl: 12,
      status: "complete",
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 3, writtenOff: true })],
    });
    const r = batchReserve(b);
    expect(r.reservedForContractBbl).toBe(0); // written off → nothing reserved
    expect(r.underCovered).toBe(false);        // written off → no longer counts toward guarantee
  });

  it("soft-only batch has zero contract reserve", () => {
    const b = batch({ producedBbl: 10, allocations: [alloc({ channel: "wholesale", bookedBbl: null })] });
    const r = batchReserve(b);
    expect(r.reservedForContractBbl).toBe(0);
    expect(r.freeToShipBbl).toBeCloseTo(10);
    expect(r.underCovered).toBe(false);
  });
});

describe("completionReconciliation", () => {
  it("returns null for soft channels (no deposit)", () => {
    const soft = alloc({ channel: "distribution", bookedBbl: null });
    expect(completionReconciliation(soft, batch({ status: "complete" }))).toBeNull();
  });

  it("returns null before the batch is complete", () => {
    expect(completionReconciliation(alloc(), batch({ status: "packaging" }))).toBeNull();
  });

  it("delivering the full share of actual yield satisfies the deposit — NO refund", () => {
    // booked 15 (75% of a planned 20); shrinkage leaves 17 produced → A = 75% × 17 = 12.75.
    // Shipping exactly 12.75 fully settles the deposit; the partner shoulders the
    // shrinkage, so there is no over/under delivery and (crucially) no refund field.
    const complete = batch({ producedBbl: 17, status: "complete" });
    expect(completionReconciliation(alloc({ exportedBbl: 12.75 }), complete)).toEqual({
      finalEntitlementBbl: 12.75,
      overDeliveredBbl: 0,
      underDeliveredBbl: 0,
    });
  });

  it("flags over- and under-delivery against the final entitlement", () => {
    const complete = batch({ producedBbl: 16, status: "complete" }); // A = 75% × 16 = 12
    expect(completionReconciliation(alloc({ exportedBbl: 13 }), complete)).toEqual({
      finalEntitlementBbl: 12, overDeliveredBbl: 1, underDeliveredBbl: 0,
    });
    expect(completionReconciliation(alloc({ exportedBbl: 10 }), complete)).toEqual({
      finalEntitlementBbl: 12, overDeliveredBbl: 0, underDeliveredBbl: 2,
    });
  });
});

describe("assessWriteOff", () => {
  it("contract, incomplete batch: entitlement is the booked deposit", () => {
    const a = assessWriteOff({ depositBacked: true, bookedBbl: 15, finalEntitlementBbl: null, realizableBbl: 12, exportedBbl: 10 });
    expect(a.entitlementBbl).toBe(15);
    expect(a.remainingBbl).toBe(5);
    expect(a.fraction).toBeCloseTo(5 / 15);
    expect(a.exceedsTolerance).toBe(true); // 33% > 10%
    expect(a.fullyDelivered).toBe(false);
  });

  it("contract, complete batch: entitlement is the final actual (A), not the booked estimate", () => {
    // booked 15, but produced only yielded A = 12.75; shipped 12.5 → owed 0.25.
    const a = assessWriteOff({ depositBacked: true, bookedBbl: 15, finalEntitlementBbl: 12.75, realizableBbl: 12.75, exportedBbl: 12.5 });
    expect(a.entitlementBbl).toBe(12.75);
    expect(a.remainingBbl).toBe(0.25);
    expect(a.exceedsTolerance).toBe(false); // 0.25/12.75 ≈ 2% < 10%
  });

  it("warns exactly at the boundary above the tolerance", () => {
    // remaining 1.5 of 10 = 15% > 10% → warn
    const warn = assessWriteOff({ depositBacked: true, bookedBbl: 10, finalEntitlementBbl: 10, realizableBbl: 10, exportedBbl: 8.5 });
    expect(warn.exceedsTolerance).toBe(true);
    // remaining 1.0 of 10 = 10% → NOT above tolerance
    const ok = assessWriteOff({ depositBacked: true, bookedBbl: 10, finalEntitlementBbl: 10, realizableBbl: 10, exportedBbl: 9 });
    expect(ok.exceedsTolerance).toBe(false);
    expect(ok.warnFraction).toBe(WRITE_OFF_WARN_FRACTION);
  });

  it("soft channel: entitlement is the produced-so-far share", () => {
    const a = assessWriteOff({ depositBacked: false, bookedBbl: null, finalEntitlementBbl: null, realizableBbl: 8, exportedBbl: 6 });
    expect(a.entitlementBbl).toBe(8);
    expect(a.remainingBbl).toBe(2);
  });

  it("nothing left to forgive when already fully delivered", () => {
    const a = assessWriteOff({ depositBacked: true, bookedBbl: 15, finalEntitlementBbl: 12, realizableBbl: 12, exportedBbl: 12 });
    expect(a.remainingBbl).toBe(0);
    expect(a.fullyDelivered).toBe(true);
    expect(a.exceedsTolerance).toBe(false);
  });

  it("zero entitlement does not divide by zero", () => {
    const a = assessWriteOff({ depositBacked: false, bookedBbl: null, finalEntitlementBbl: null, realizableBbl: 0, exportedBbl: 0 });
    expect(a.fraction).toBe(0);
    expect(a.remainingBbl).toBe(0);
    expect(a.fullyDelivered).toBe(true);
  });
});

describe("planShipment", () => {
  const contractBatch = (): BatchInput =>
    batch({
      batchId: "b1",
      producedBbl: 16,
      totalExportedBbl: 0,
      allocations: [
        alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0 }),
        alloc({ id: "S", channel: "distribution", percentage: 25, bookedBbl: null, exportedBbl: 0 }),
      ],
    });

  it("soft ship within free-to-ship raises no warning", () => {
    const plan = planShipment({
      requestedBbl: 3,
      candidates: [{ allocationId: "S", batchId: "b1", channel: "distribution", bookedRemainingBbl: null }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 3 }],
      batches: [contractBatch()],
    });
    expect(plan.warnings).toHaveLength(0);
    expect(plan.credits).toEqual([{ allocationId: "S", bbl: 3, overAllocation: false }]);
  });

  it("soft ship dipping into contract reserve warns guarantee_coverage", () => {
    const plan = planShipment({
      requestedBbl: 6, // free-to-ship is only 4 (16 onHand − 12 reserved)
      candidates: [{ allocationId: "S", batchId: "b1", channel: "distribution", bookedRemainingBbl: null }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 6 }],
      batches: [contractBatch()],
    });
    expect(hasType(plan.warnings, "guarantee_coverage")).toBe(true);
    expect(hasType(plan.warnings, "over_booked")).toBe(false);
    const w = plan.warnings.find((x) => x.type === "guarantee_coverage")!;
    expect(w).toMatchObject({ batchId: "b1", reservedBbl: 12, onHandAfterBbl: 10, drawBbl: 6 });
  });

  it("contract ship beyond booked with no soft → over_booked + over-delivery credit", () => {
    const b = batch({
      batchId: "b1",
      producedBbl: 16,
      allocations: [alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0 })],
    });
    const plan = planShipment({
      requestedBbl: 16,
      candidates: [{ allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 15 }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 16 }],
      batches: [b],
    });
    expect(plan.credits).toEqual([
      { allocationId: "A", bbl: 15, overAllocation: false },
      { allocationId: null, bbl: 1, overAllocation: true },
    ]);
    const w = plan.warnings.find((x) => x.type === "over_booked")!;
    expect(w).toMatchObject({ type: "over_booked", overBbl: 1 });
  });

  it("soft allocation absorbs the remainder → no over_booked", () => {
    const plan = planShipment({
      requestedBbl: 16,
      candidates: [
        { allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 15 },
        { allocationId: "S", batchId: "b1", channel: "distribution", bookedRemainingBbl: null },
      ],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 16 }],
      batches: [contractBatch()],
    });
    expect(hasType(plan.warnings, "over_booked")).toBe(false);
    expect(plan.credits).toEqual([
      { allocationId: "A", bbl: 15, overAllocation: false },
      { allocationId: "S", bbl: 1, overAllocation: false },
    ]);
  });

  it("a deposit holder consuming its own reserve does not warn", () => {
    const b = batch({
      batchId: "b1",
      producedBbl: 16,
      allocations: [alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0 })],
    });
    const plan = planShipment({
      requestedBbl: 12, // exactly A's realizable share
      candidates: [{ allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 15 }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 12 }],
      batches: [b],
    });
    expect(plan.warnings).toHaveLength(0);
  });

  it("COMPLETE batch that can't cover its remaining reserve warns reserve_shortfall", () => {
    const b = batch({
      batchId: "b1",
      producedBbl: 12,
      totalExportedBbl: 11,
      status: "complete",
      allocations: [alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 2 })],
    });
    const plan = planShipment({
      requestedBbl: 1,
      candidates: [{ allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 13 }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 1 }],
      batches: [b],
    });
    const w = plan.warnings.find((x) => x.type === "reserve_shortfall")!;
    expect(w).toMatchObject({ batchId: "b1", onHandBbl: 1, owedBbl: 7 });
  });

  it("does NOT warn reserve_shortfall while a batch is still packaging", () => {
    const b = batch({
      batchId: "b1",
      producedBbl: 12,
      status: "packaging", // final yield unknown — sub-guarantee is expected, not a shortfall
      allocations: [alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0 })],
    });
    const plan = planShipment({
      requestedBbl: 1,
      candidates: [{ allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 15 }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 1 }],
      batches: [b],
    });
    expect(hasType(plan.warnings, "reserve_shortfall")).toBe(false);
  });

  it("multi-batch FIFO: soft draw strands an older batch's deposit", () => {
    const b1 = batch({
      batchId: "b1",
      producedBbl: 8,
      status: "complete",
      totalExportedBbl: 0,
      allocations: [alloc({ id: "C1", channel: "contract_brewing", percentage: 100, bookedBbl: 10, exportedBbl: 0 })],
    });
    const b2 = batch({ batchId: "b2", producedBbl: 10, totalExportedBbl: 0, allocations: [] });
    const plan = planShipment({
      requestedBbl: 12,
      candidates: [{ allocationId: "S", batchId: "b2", channel: "distribution", bookedRemainingBbl: null }],
      perBatchDrawBbl: [
        { batchId: "b1", drawBbl: 8 }, // FIFO drains the older, deposit-guaranteed batch first
        { batchId: "b2", drawBbl: 4 },
      ],
      batches: [b1, b2],
    });
    const cov = plan.warnings.filter((w) => w.type === "guarantee_coverage");
    expect(cov).toHaveLength(1);
    expect(cov[0]).toMatchObject({ batchId: "b1" });
    // b1 still HOLDS everything it owes (8 on hand, 8 reserved) — the draw is
    // what would strand it, which is the guarantee_coverage warning above.
    expect(hasType(plan.warnings, "reserve_shortfall")).toBe(false);
  });

  it("a fully-delivered batch cannot absorb a younger batch's beer (B-041/B-054)", () => {
    // B-041: booked 20, produced 17.0963 after shrinkage, all 17.0963 shipped.
    // Its booked remainder (2.9037) is pure shrinkage — crediting against it once
    // let a later B-054 shipment be logged as B-041 delivery.
    const b1 = batch({
      batchId: "b1",
      producedBbl: 17.0963,
      totalExportedBbl: 17.0963,
      status: "complete",
      allocations: [alloc({ id: "A1", channel: "contract_brewing", percentage: 100, bookedBbl: 20, exportedBbl: 17.0963 })],
    });
    const b2 = batch({
      batchId: "b2",
      producedBbl: 16.2588,
      totalExportedBbl: 7.0968,
      status: "complete",
      allocations: [alloc({ id: "A2", channel: "contract_brewing", percentage: 100, bookedBbl: 20, exportedBbl: 7.0968 })],
    });
    const plan = planShipment({
      requestedBbl: 8.9955, // 54 sixtels, physically drawn from b2
      candidates: [
        { allocationId: "A1", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 2.9037, realizableRemainingBbl: 0 },
        { allocationId: "A2", batchId: "b2", channel: "contract_brewing", bookedRemainingBbl: 12.9032, realizableRemainingBbl: 9.162 },
      ],
      perBatchDrawBbl: [{ batchId: "b2", drawBbl: 8.9955 }],
      batches: [b1, b2],
    });
    expect(plan.credits).toEqual([{ allocationId: "A2", bbl: 8.9955, overAllocation: false }]);
  });

  it("soft channel never emits over_booked even when requesting far more", () => {
    const plan = planShipment({
      requestedBbl: 100,
      candidates: [{ allocationId: "S", batchId: "b1", channel: "wholesale", bookedRemainingBbl: null }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 100 }],
      batches: [batch({ batchId: "b1", producedBbl: 100, allocations: [] })],
    });
    expect(hasType(plan.warnings, "over_booked")).toBe(false);
    expect(plan.credits).toEqual([{ allocationId: "S", bbl: 100, overAllocation: false }]);
  });

  it("zero-produced batch in the draw does not throw or NaN", () => {
    const plan = planShipment({
      requestedBbl: 0,
      candidates: [],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 0 }],
      batches: [batch({ batchId: "b1", producedBbl: 0, allocations: [] })],
    });
    expect(plan.warnings).toHaveLength(0);
    expect(plan.credits).toHaveLength(0);
  });
});

describe("planCreditedWrites", () => {
  it("attributes an allocation credit to its batch and assigns full quantity", () => {
    const candidates = [{ allocationId: "A", batchId: "b1", channel: "contract_brewing" as const, bookedRemainingBbl: 15 }];
    const plan = { credits: [{ allocationId: "A", bbl: 12, overAllocation: false }], warnings: [] };
    const writes = planCreditedWrites(plan, {
      candidates,
      depleted: [{ batchId: "b1", depletedQty: 12 }],
      quantity: 12,
      overDeliveryChannel: "distribution",
    });
    expect(writes).toEqual([
      { batchId: "b1", allocationId: "A", channel: "contract_brewing", bbl: 12, qty: 12, overAllocation: false },
    ]);
  });

  it("splits over-delivery across drawn batches, flags it, and quantities sum to the shipment", () => {
    const candidates = [{ allocationId: "A", batchId: "b1", channel: "contract_brewing" as const, bookedRemainingBbl: 15 }];
    const plan = {
      credits: [
        { allocationId: "A", bbl: 15, overAllocation: false },
        { allocationId: null, bbl: 5, overAllocation: true },
      ],
      warnings: [],
    };
    const writes = planCreditedWrites(plan, {
      candidates,
      depleted: [{ batchId: "b1", depletedQty: 10 }, { batchId: "b2", depletedQty: 10 }],
      quantity: 20,
      overDeliveryChannel: "distribution",
    });
    expect(writes.map((w) => ({ b: w.batchId, a: w.allocationId, bbl: w.bbl, over: w.overAllocation }))).toEqual([
      { b: "b1", a: "A", bbl: 15, over: false },
      { b: "b1", a: null, bbl: 2.5, over: true },
      { b: "b2", a: null, bbl: 2.5, over: true },
    ]);
    expect(writes.reduce((s, w) => s + w.qty, 0)).toBeCloseTo(20);
  });
});
