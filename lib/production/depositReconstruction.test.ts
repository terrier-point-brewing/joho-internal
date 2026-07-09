import { describe, it, expect } from "vitest";
import {
  reconstructFieldAsOf,
  reconstructBreakdownAsOf,
  type AuditRow,
} from "./depositReconstruction";

const row = (over: Partial<AuditRow>): AuditRow => ({
  table_name: "ingredients", record_id: "i1", operation: "UPDATE",
  changed_at: "2026-01-01T00:00:00Z", old_data: null, new_data: null, ...over,
});

describe("reconstructFieldAsOf", () => {
  it("returns the latest new_data value at or before asOf", () => {
    const rows = [
      row({ changed_at: "2026-01-10T00:00:00Z", new_data: { cost_per_unit: 2 } }),
      row({ changed_at: "2026-02-10T00:00:00Z", new_data: { cost_per_unit: 5 } }),
    ];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-20T00:00:00Z", 9)).toBe(2);
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-03-01T00:00:00Z", 9)).toBe(5);
  });

  it("uses the earliest old_data when asOf precedes all changes", () => {
    const rows = [row({ changed_at: "2026-02-10T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } })];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(2);
  });

  it("falls back to the current value when there is no audit history", () => {
    expect(reconstructFieldAsOf([], "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(9);
  });
});

describe("reconstructBreakdownAsOf", () => {
  const ingredientsNow = new Map([
    ["i1", { id: "i1", name: "Malt", unit: "lb", cost_per_unit: 5 }],
    ["i2", { id: "i2", name: "Hops", unit: "oz", cost_per_unit: 3 }],
  ]);

  it("uses historical prices/quantities at asOf", () => {
    const audit: AuditRow[] = [
      { table_name: "ingredients", record_id: "i1", operation: "UPDATE", changed_at: "2026-03-01T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } },
    ];
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [{ recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 }],
      ingredientsNow, audit,
    });
    expect(out).toHaveLength(1);
    expect(out[0].cost_per_unit).toBe(2); // historical, not current 5
    expect(out[0].weight).toBe(20); // 10 * 2
  });

  it("excludes a recipe ingredient inserted after asOf", () => {
    const audit: AuditRow[] = [
      { table_name: "recipe_ingredients", record_id: "r2", operation: "INSERT", changed_at: "2026-05-01T00:00:00Z", old_data: null, new_data: { id: "r2", ingredient_id: "i2", quantity_per_bbl: 4 } },
    ];
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [
        { recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 },
        { recipe_ingredient_id: "r2", ingredient_id: "i2", quantity_per_bbl: 4 },
      ],
      ingredientsNow, audit,
    });
    expect(out.map((b) => b.ingredient_id)).toEqual(["i1"]);
  });

  it("skips ingredients with no known cost", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [{ recipe_ingredient_id: "r3", ingredient_id: "i3", quantity_per_bbl: 10 }],
      ingredientsNow, audit: [],
    });
    expect(out).toEqual([]);
  });
});
