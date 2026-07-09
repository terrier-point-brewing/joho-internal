// lib/production/depositReconstruction.test.ts
import { describe, it, expect } from "vitest";
import {
  reconstructFieldAsOf,
  reconstructBreakdownAsOf,
  type AuditRow,
} from "./depositReconstruction";

const irow = (over: Partial<AuditRow>): AuditRow => ({
  table_name: "ingredients", record_id: "i1", operation: "UPDATE",
  changed_at: "2026-01-01T00:00:00Z", old_data: null, new_data: null, ...over,
});
const rirow = (over: Partial<AuditRow>): AuditRow => ({
  table_name: "recipe_ingredients", record_id: "r1", operation: "INSERT",
  changed_at: "2026-01-01T00:00:00Z", old_data: null, new_data: null, ...over,
});

const ingredientsNow = new Map([
  ["i1", { id: "i1", name: "Malt", unit: "lb", cost_per_unit: 5 }],
  ["i2", { id: "i2", name: "Hops", unit: "oz", cost_per_unit: 3 }],
]);

describe("reconstructFieldAsOf", () => {
  it("returns the latest new_data value at or before asOf", () => {
    const rows = [
      irow({ changed_at: "2026-01-10T00:00:00Z", new_data: { cost_per_unit: 2 } }),
      irow({ changed_at: "2026-02-10T00:00:00Z", new_data: { cost_per_unit: 5 } }),
    ];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-20T00:00:00Z", 9)).toBe(2);
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-03-01T00:00:00Z", 9)).toBe(5);
  });
  it("uses the earliest old_data when asOf precedes all changes", () => {
    const rows = [irow({ changed_at: "2026-02-10T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } })];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(2);
  });
  it("falls back to the current value when there is no audit history", () => {
    expect(reconstructFieldAsOf([], "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(9);
  });
});

describe("reconstructBreakdownAsOf", () => {
  it("uses historical prices at asOf", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [{ recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 }],
      ingredientsNow,
      recipeIngredientAudit: [rirow({ record_id: "r1", changed_at: "2026-01-01T00:00:00Z", new_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 10 } })],
      ingredientAudit: [irow({ record_id: "i1", changed_at: "2026-03-01T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].cost_per_unit).toBe(2);
    expect(out[0].weight).toBe(20);
  });

  it("excludes a recipe ingredient inserted after asOf", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [
        { recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 },
        { recipe_ingredient_id: "r2", ingredient_id: "i2", quantity_per_bbl: 4 },
      ],
      ingredientsNow,
      recipeIngredientAudit: [
        rirow({ record_id: "r1", changed_at: "2026-01-01T00:00:00Z", new_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 10 } }),
        rirow({ record_id: "r2", changed_at: "2026-05-01T00:00:00Z", new_data: { id: "r2", recipe_id: "rec", ingredient_id: "i2", quantity_per_bbl: 4 } }),
      ],
      ingredientAudit: [],
    });
    expect(out.map((b) => b.ingredient_id)).toEqual(["i1"]);
  });

  it("includes a recipe ingredient deleted after asOf using historical qty", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [],
      ingredientsNow,
      recipeIngredientAudit: [
        rirow({ record_id: "r1", operation: "INSERT", changed_at: "2026-01-01T00:00:00Z", new_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 7 } }),
        rirow({ record_id: "r1", operation: "DELETE", changed_at: "2026-04-01T00:00:00Z", old_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 7 }, new_data: null }),
      ],
      ingredientAudit: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].ingredient_id).toBe("i1");
    expect(out[0].quantity_per_bbl).toBe(7);
    expect(out[0].weight).toBe(35);
  });

  it("handles recipe-edit churn (old rows deleted + new rows inserted after asOf)", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [{ recipe_ingredient_id: "r1b", ingredient_id: "i1", quantity_per_bbl: 12 }],
      ingredientsNow,
      recipeIngredientAudit: [
        rirow({ record_id: "r1", operation: "INSERT", changed_at: "2026-01-01T00:00:00Z", new_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 8 } }),
        rirow({ record_id: "r1", operation: "DELETE", changed_at: "2026-03-01T00:00:00Z", old_data: { id: "r1", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 8 }, new_data: null }),
        rirow({ record_id: "r1b", operation: "INSERT", changed_at: "2026-03-01T00:00:00Z", new_data: { id: "r1b", recipe_id: "rec", ingredient_id: "i1", quantity_per_bbl: 12 } }),
      ],
      ingredientAudit: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].quantity_per_bbl).toBe(8);
  });

  it("treats an unaudited current recipe ingredient as present with fallback qty", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [{ recipe_ingredient_id: "r9", ingredient_id: "i2", quantity_per_bbl: 6 }],
      ingredientsNow,
      recipeIngredientAudit: [],
      ingredientAudit: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].quantity_per_bbl).toBe(6);
    expect(out[0].weight).toBe(18);
  });

  it("skips ingredients with no known cost", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      currentRecipeIngredients: [{ recipe_ingredient_id: "r3", ingredient_id: "i3", quantity_per_bbl: 10 }],
      ingredientsNow,
      recipeIngredientAudit: [],
      ingredientAudit: [],
    });
    expect(out).toEqual([]);
  });
});
