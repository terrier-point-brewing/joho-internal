import { describe, it, expect } from "vitest";
import { volumeFlOzPerUnit, inferInventoryUnit } from "./catalogUnits";

describe("volumeFlOzPerUnit", () => {
  it("parses a single pour size", () => {
    expect(volumeFlOzPerUnit("Draft - 16oz")).toBe(16);
  });
  it("parses a 4-pack of 12oz cans", () => {
    expect(volumeFlOzPerUnit("12oz 4-Pack")).toBe(48);
  });
  it("parses a 6-pack of 12oz cans", () => {
    expect(volumeFlOzPerUnit("12oz 6-Pack")).toBe(72);
  });
  it("parses a case as 24 units", () => {
    expect(volumeFlOzPerUnit("16oz Case")).toBe(384);
  });
  it("parses keg sizes", () => {
    expect(volumeFlOzPerUnit("1/6 Keg")).toBe(661);
    expect(volumeFlOzPerUnit("1/4 Keg")).toBe(992);
    expect(volumeFlOzPerUnit("1/2 Keg")).toBe(1984);
  });
  it("returns null for a bare base variation", () => {
    expect(volumeFlOzPerUnit("Draft")).toBeNull();
    expect(volumeFlOzPerUnit("Regular")).toBeNull();
    expect(volumeFlOzPerUnit(null)).toBeNull();
  });
});

describe("inferInventoryUnit", () => {
  it("treats a bare base variation as fl_oz", () => {
    expect(inferInventoryUnit("Draft")).toBe("fl_oz");
    expect(inferInventoryUnit("Regular")).toBe("fl_oz");
  });
  it("treats sized/packed variations as each", () => {
    expect(inferInventoryUnit("1/6 Keg")).toBe("each");
    expect(inferInventoryUnit("12oz 4-Pack")).toBe("each");
    expect(inferInventoryUnit("Draft - 16oz")).toBe("each");
  });
  it("returns null for empty", () => {
    expect(inferInventoryUnit(null)).toBeNull();
  });
});
