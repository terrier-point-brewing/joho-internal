import { describe, it, expect } from "vitest";
import {
  allocationView,
  batchReserve,
  planShipment,
  isDepositBacked,
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
    expect(r.underCovered).toBe(false);               // produced 16 ≥ booked 15
  });

  it("underCovered when produced hasn't reached guaranteed total", () => {
    const b = batch({
      producedBbl: 12,
      allocations: [alloc({ channel: "contract_brewing", percentage: 75, bookedBbl: 15 })],
    });
    expect(batchReserve(b).underCovered).toBe(true); // 12 < 15
  });

  it("soft-only batch has zero contract reserve", () => {
    const b = batch({ producedBbl: 10, allocations: [alloc({ channel: "wholesale", bookedBbl: null })] });
    const r = batchReserve(b);
    expect(r.reservedForContractBbl).toBe(0);
    expect(r.freeToShipBbl).toBeCloseTo(10);
    expect(r.underCovered).toBe(false);
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

  it("under-produced batch warns under_production", () => {
    const b = batch({
      batchId: "b1",
      producedBbl: 12,
      allocations: [alloc({ id: "A", channel: "contract_brewing", percentage: 75, bookedBbl: 15, exportedBbl: 0 })],
    });
    const plan = planShipment({
      requestedBbl: 1,
      candidates: [{ allocationId: "A", batchId: "b1", channel: "contract_brewing", bookedRemainingBbl: 15 }],
      perBatchDrawBbl: [{ batchId: "b1", drawBbl: 1 }],
      batches: [b],
    });
    const w = plan.warnings.find((x) => x.type === "under_production")!;
    expect(w).toMatchObject({ batchId: "b1", producedBbl: 12, guaranteedBbl: 15 });
  });

  it("multi-batch FIFO: soft draw strands an older batch's deposit", () => {
    const b1 = batch({
      batchId: "b1",
      producedBbl: 8,
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
    expect(hasType(plan.warnings, "under_production")).toBe(true); // b1: 8 < 10
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
