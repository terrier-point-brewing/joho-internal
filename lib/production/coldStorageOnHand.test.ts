import { describe, it, expect } from "vitest";
import { aggregateColdStorage, coldStorageKey, type ColdStorageRow } from "./coldStorageOnHand";

const row = (recipeId: string, variationId: string, qty: number, vol: number, format: string, containerType: "keg" | "can"): ColdStorageRow =>
  ({ recipeId, variationId, quantityOnHand: qty, totalVolumeFlOz: vol, format, containerType });

describe("aggregateColdStorage", () => {
  it("sums quantity across batches per (recipe, variation) and keeps volume/format/type", () => {
    const map = aggregateColdStorage([
      row("r1", "loose", 5, 16, "loose", "can"),
      row("r1", "loose", 3, 16, "loose", "can"), // second batch of same variation
      row("r1", "case", 1, 384, "case", "can"),
    ]);
    expect(map.get(coldStorageKey("r1", "loose"))).toEqual({ qty: 8, totalVolumeFlOz: 16, format: "loose", containerType: "can" });
    expect(map.get(coldStorageKey("r1", "case"))).toEqual({ qty: 1, totalVolumeFlOz: 384, format: "case", containerType: "can" });
  });

  it("keys collisions only within the same recipe+variation", () => {
    const map = aggregateColdStorage([
      row("r1", "loose", 2, 16, "loose", "can"),
      row("r2", "loose", 9, 16, "loose", "can"),
    ]);
    expect(map.get(coldStorageKey("r1", "loose"))!.qty).toBe(2);
    expect(map.get(coldStorageKey("r2", "loose"))!.qty).toBe(9);
  });
});
