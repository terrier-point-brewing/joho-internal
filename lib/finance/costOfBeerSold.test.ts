// Cost of beer sold: each unit that left × its batch's unit cost, plus the
// packaging around it, bucketed by the month it left.
import { describe, it, expect } from "vitest";
import { costSoldRows, preTrackingBatchIds } from "./costOfBeerSold";
import type { BatchCost } from "./batchCost";
import type { PackagingItemRow } from "./inventoryValuation";

const MONTHS = ["2026-08", "2026-09"];

function batchCost(costPerBblCents: number): BatchCost {
  return { rawCostCents: 0, yieldBasisBbl: 1, costPerBblCents, wipCents: 0, packagedBbl: 0, inTankBbl: 0, convertedBbl: 0, complete: true };
}

const CAN = { id: "can", type: "can", name: "16oz can", unit_cost_usd: 0.2, can_count: null };
const KEG = { id: "keg", type: "keg", name: "Sixtel", unit_cost_usd: 100, can_count: null };
const PAKTECH = { id: "pt", type: "paktech", name: "4-pack PakTech", unit_cost_usd: null, can_count: 4 };
const variations = new Map([
  ["v-keg", { id: "v-keg", format: "loose", total_volume_fl_oz: 661, container_id: "keg", lid_id: null, label_id: null, paktech_id: null, tray_id: null }],
  ["v-4pk", { id: "v-4pk", format: "4-pack", total_volume_fl_oz: 64, container_id: "can", lid_id: null, label_id: null, paktech_id: "pt", tray_id: null }],
]);
const items = new Map<string, PackagingItemRow>([[CAN.id, CAN], [KEG.id, KEG], [PAKTECH.id, PAKTECH]]);

describe("costSoldRows", () => {
  it("prices a shipment at its batch's unit cost and buckets it by the month it left", () => {
    const out = costSoldRows(
      [{ id: "x1", batch_id: "b1", recipe_id: "r1", variation_id: "v-keg", volume_bbl: 2, quantity: 12, created_at: "2026-08-20T15:00:00Z" }],
      MONTHS,
      new Map([["b1", batchCost(5_000)]]),
      new Map([["r1", 9_999]]),
      variations,
      items,
    );
    expect(out["2026-08"].beerCents).toBe(10_000);
    // A keg is a returnable float: no packaging cost rides on it, even priced.
    expect(out["2026-08"].packagingCents).toBe(0);
    expect(out["2026-08"].ids).toEqual(["x1"]);
    expect(out["2026-09"].beerCents).toBe(0);
  });

  it("adds the cans a 4-pack consumed, and falls back to the recipe when the batch has no cost", () => {
    const out = costSoldRows(
      [{ id: "x2", batch_id: null, recipe_id: "r1", variation_id: "v-4pk", volume_bbl: 0.5, quantity: 3, created_at: "2026-09-02T15:00:00Z" }],
      MONTHS,
      new Map(),
      new Map([["r1", 4_000]]),
      variations,
      items,
    );
    expect(out["2026-09"].beerCents).toBe(2_000);
    // 3 four-packs × 4 cans × $0.20
    expect(out["2026-09"].packagingCents).toBe(240);
  });

  it("ignores rows outside the window rather than inventing a month", () => {
    const out = costSoldRows(
      [{ id: "x3", batch_id: "b1", recipe_id: "r1", variation_id: null, volume_bbl: 1, quantity: 1, created_at: "2026-07-31T15:00:00Z" }],
      MONTHS,
      new Map([["b1", batchCost(5_000)]]),
      new Map(),
      variations,
      items,
    );
    expect(Object.keys(out)).toEqual(MONTHS);
    expect(out["2026-08"].beerCents).toBe(0);
  });

  it("charges no beer for a batch brewed before tracking began, but still its packaging", () => {
    const out = costSoldRows(
      [{ id: "x4", batch_id: "old", recipe_id: "r1", variation_id: "v-4pk", volume_bbl: 0.5, quantity: 3, created_at: "2026-08-10T15:00:00Z" }],
      MONTHS,
      new Map([["old", batchCost(5_000)]]),
      new Map([["r1", 4_000]]),
      variations,
      items,
      new Set(["old"]),
    );
    // The ingredients were expensed when bought; costing them again would
    // surface as a phantom gain on the inventory residual.
    expect(out["2026-08"].beerCents).toBe(0);
    expect(out["2026-08"].packagingCents).toBe(240);
    expect(out["2026-08"].ids).toEqual(["x4"]);
  });
});

describe("preTrackingBatchIds", () => {
  const batches = [
    { id: "june", planned_brew_date: "2026-06-20", created_at: "2026-06-18T00:00:00Z", converted_from_batch_id: null },
    { id: "july", planned_brew_date: "2026-07-01", created_at: "2026-06-25T00:00:00Z", converted_from_batch_id: null },
    { id: "undated", planned_brew_date: null, created_at: "2026-06-30T12:00:00Z", converted_from_batch_id: null },
    { id: "child", planned_brew_date: "2026-08-05", created_at: "2026-08-05T00:00:00Z", converted_from_batch_id: "june" },
    { id: "grandchild", planned_brew_date: "2026-09-01", created_at: "2026-09-01T00:00:00Z", converted_from_batch_id: "child" },
  ];

  it("takes the brew date, falls back to created_at, and follows a conversion to its root", () => {
    expect([...preTrackingBatchIds(batches, "2026-07")].sort()).toEqual(["child", "grandchild", "june", "undated"]);
  });

  it("is empty when tracking has not begun", () => {
    expect(preTrackingBatchIds(batches, null).size).toBe(0);
  });
});
