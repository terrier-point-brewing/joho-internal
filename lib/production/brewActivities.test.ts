import { describe, it, expect } from "vitest";
import { parseActivityStep, seedBatchActivities } from "./brewActivities";

describe("parseActivityStep", () => {
  it("coerces numeric strings and keeps activity/sort_order", () => {
    expect(parseActivityStep({ activity: "Mash in", temp: "152", amount: "5.5", vsp: "3" }, 2)).toEqual({
      sort_order: 2,
      activity: "Mash in",
      time_label: null,
      temp: 152,
      temp_unit: "F",
      amount: 5.5,
      amount_unit: null,
      vsp: 3,
    });
  });

  it("collapses blank strings and nullish values to null", () => {
    const out = parseActivityStep({ activity: "Whirlpool", time_label: "", temp: "", amount: null, vsp: undefined }, 0);
    expect(out.time_label).toBeNull();
    expect(out.temp).toBeNull();
    expect(out.amount).toBeNull();
    expect(out.vsp).toBeNull();
  });

  it("defaults temp_unit to F but honors an explicit unit", () => {
    expect(parseActivityStep({ activity: "x" }, 0).temp_unit).toBe("F");
    expect(parseActivityStep({ activity: "x", temp_unit: "C" }, 0).temp_unit).toBe("C");
  });

  it("preserves 0 as a real value (not treated as blank)", () => {
    const out = parseActivityStep({ activity: "Cold crash", temp: 0, amount: 0 }, 1);
    expect(out.temp).toBe(0);
    expect(out.amount).toBe(0);
  });
});

describe("seedBatchActivities", () => {
  const templates = [
    { sort_order: 0, activity: "Mash", time_label: "0:00", temp: 152, amount: 10, amount_unit: "lb", vsp: 2 },
    { sort_order: 1, activity: "Boil", time_label: null, temp: 212, temp_unit: "F", amount: null },
  ];

  it("copies each template row scoped to the batch, defaulting temp_unit/amount_unit/vsp", () => {
    const rows = seedBatchActivities(templates, "batch-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      batch_id: "batch-1",
      sort_order: 0,
      activity: "Mash",
      time_label: "0:00",
      temp: 152,
      temp_unit: "F",
      amount: 10,
      amount_unit: "lb",
      vsp: 2,
    });
    expect(rows[1].amount_unit).toBeNull();
    expect(rows[1].vsp).toBeNull();
    expect(rows[1].temp_unit).toBe("F");
  });

  it("returns an empty array when the recipe has no default activities", () => {
    expect(seedBatchActivities([], "batch-1")).toEqual([]);
  });
});
