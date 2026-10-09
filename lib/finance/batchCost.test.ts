// Batch costing: the raw cost follows the beer, shrinkage spreads over the
// yield, and a conversion inherits rather than re-buys its base beer.
import { describe, it, expect } from "vitest";
import { costBatches, workInProcessCents, type BatchCostInput, type CostLedgerTransfer } from "./batchCost";

const TANKS = { fv1: "fermenter", fv2: "fermenter", keg: "kegging", can: "canning" };

function batch(over: Partial<BatchCostInput> & { id: string }): BatchCostInput {
  return { recipeId: "r1", turns: 1, volumeBbl: 20, status: "fermenting", convertedFromBatchId: null, ...over };
}

function transfer(over: Partial<CostLedgerTransfer> & { batch_id: string; transfer_type: string }): CostLedgerTransfer {
  return {
    from_tank_id: null,
    to_tank_id: null,
    to_batch_id: null,
    volume_bbl: 0,
    shrinkage_bbl: 0,
    transferred_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

// $1,000 of grain per turn.
const RECIPE = new Map([["r1", 100_000]]);

describe("costBatches", () => {
  it("holds the whole raw cost in tank, at the expected yield, before anything is packaged", () => {
    const ledger = [transfer({ batch_id: "b1", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 20 })];

    const cost = costBatches([batch({ id: "b1" })], ledger, TANKS, 90, RECIPE).get("b1")!;

    // 20 bbl in tank is expected to package out at 18; all of the $1,000 is
    // still WIP and the unit cost is already the post-shrinkage one.
    expect(cost.yieldBasisBbl).toBe(18);
    expect(cost.costPerBblCents).toBeCloseTo(100_000 / 18, 6);
    expect(cost.wipCents).toBe(100_000);
  });

  it("moves the packaged share out of WIP at the projected unit cost", () => {
    const ledger = [
      transfer({ batch_id: "b1", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 20 }),
      transfer({ batch_id: "b1", transfer_type: "kegging", from_tank_id: "fv1", to_tank_id: "keg", volume_bbl: 6, shrinkage_bbl: 1 }),
    ];

    const cost = costBatches([batch({ id: "b1" })], ledger, TANKS, 90, RECIPE).get("b1")!;

    // 6 packaged + 13 in tank x 0.9 = 17.7 bbl basis. WIP is the in-tank share.
    expect(cost.packagedBbl).toBe(6);
    expect(cost.inTankBbl).toBe(13);
    expect(cost.yieldBasisBbl).toBe(17.7);
    expect(cost.wipCents).toBe(Math.round((100_000 / 17.7) * 11.7));
  });

  it("re-prices to the real yield once the batch is complete, and empties WIP", () => {
    const ledger = [
      transfer({ batch_id: "b1", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 20 }),
      transfer({ batch_id: "b1", transfer_type: "kegging", from_tank_id: "fv1", to_tank_id: "keg", volume_bbl: 18, shrinkage_bbl: 2 }),
    ];

    const cost = costBatches([batch({ id: "b1", status: "complete" })], ledger, TANKS, 90, RECIPE).get("b1")!;

    expect(cost.yieldBasisBbl).toBe(18);
    expect(cost.costPerBblCents).toBeCloseTo(100_000 / 18, 6);
    expect(cost.wipCents).toBe(0);
  });

  it("multiplies the recipe by turns", () => {
    const ledger = [transfer({ batch_id: "b1", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 40 })];

    const cost = costBatches([batch({ id: "b1", turns: 2, volumeBbl: 40 })], ledger, TANKS, 100, RECIPE).get("b1")!;

    expect(cost.rawCostCents).toBe(200_000);
  });

  it("hands a conversion child the parent's unit cost for the bbl it received, plus its own draws", () => {
    const ledger = [
      transfer({ batch_id: "p", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 20 }),
      transfer({ batch_id: "p", transfer_type: "kegging", from_tank_id: "fv1", to_tank_id: "keg", volume_bbl: 10 }),
      transfer({ batch_id: "p", transfer_type: "conversion", from_tank_id: "fv1", to_tank_id: "fv2", to_batch_id: "c", volume_bbl: 10 }),
    ];
    const batches = [
      batch({ id: "p", status: "complete" }),
      // Listed first on purpose: order of input must not matter.
      batch({ id: "c", recipeId: "r-conv", volumeBbl: 10, convertedFromBatchId: "p" }),
    ].reverse();
    const draws = new Map([["c", 5_000]]);

    const costs = costBatches(batches, ledger, TANKS, 100, RECIPE, draws);

    // Parent: $1,000 over 10 packaged + 10 converted = $50/bbl; nothing lost.
    expect(costs.get("p")!.costPerBblCents).toBe(5_000);
    // Child: 10 bbl x $50 + $50 of its own fruit.
    expect(costs.get("c")!.rawCostCents).toBe(55_000);
    // The child's recipe (the complete bill) was never consulted.
    expect(costs.get("c")!.wipCents).toBe(55_000);
  });

  it("falls back to a child's own recipe when its parent is not in the input", () => {
    const ledger = [transfer({ batch_id: "c", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 10 })];

    const cost = costBatches(
      [batch({ id: "c", volumeBbl: 10, convertedFromBatchId: "ghost" })],
      ledger,
      TANKS,
      100,
      RECIPE,
    ).get("c")!;

    expect(cost.rawCostCents).toBe(100_000);
  });

  it("costs a batch with no ledger activity at nothing in tank, rather than inventing a shelf", () => {
    const cost = costBatches([batch({ id: "b1", status: "planning" })], [], TANKS, 90, RECIPE).get("b1")!;

    expect(cost.wipCents).toBe(0);
  });
});

describe("workInProcessCents", () => {
  it("sums WIP across batches", () => {
    const ledger = [
      transfer({ batch_id: "a", transfer_type: "brewing", to_tank_id: "fv1", volume_bbl: 20 }),
      transfer({ batch_id: "b", transfer_type: "brewing", to_tank_id: "fv2", volume_bbl: 20 }),
    ];
    const costs = costBatches([batch({ id: "a" }), batch({ id: "b", status: "complete" })], ledger, TANKS, 90, RECIPE);

    expect(workInProcessCents(costs)).toBe(100_000);
  });
});
