// lib/production/materialBreakdownSnapshot.test.ts
import { describe, it, expect } from "vitest";
import { flattenMaterialBreakdowns } from "./materialBreakdownSnapshot";
import { computeMaterialBreakdown } from "./packagingMaterials";
import type { MaterialLineBreakdown } from "./exportInvoicePreview";

const can = { role: "container" as const, name: "12oz Can", unitCostDollars: 0.15, canCount: null };
const lid = { role: "lid" as const, name: "Lid", unitCostDollars: 0.05, canCount: null };

function lineBreakdown(
  recipeId: string,
  beerName: string | null,
  txns: Parameters<typeof computeMaterialBreakdown>[0]
): MaterialLineBreakdown {
  return { ...computeMaterialBreakdown(txns), recipeId, beerName };
}

describe("flattenMaterialBreakdowns", () => {
  it("emits one row per component per packaging run, carrying the run's context", () => {
    const rows = flattenMaterialBreakdowns([
      lineBreakdown("r1", "Fortnight", [
        { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid], label: "Fortnight Loose" },
      ]),
    ]);

    expect(rows).toEqual([
      {
        recipe_id: "r1", beer_name: "Fortnight", variant_label: "Fortnight Loose",
        packaging_format: "loose", packages: 100, units_per_package: 1,
        component_role: "container", component_name: "12oz Can", unit_cost_usd: 0.15,
        quantity_used: 100, line_total_cents: 1500, sort_order: 0,
      },
      {
        recipe_id: "r1", beer_name: "Fortnight", variant_label: "Fortnight Loose",
        packaging_format: "loose", packages: 100, units_per_package: 1,
        component_role: "lid", component_name: "Lid", unit_cost_usd: 0.05,
        quantity_used: 100, line_total_cents: 500, sort_order: 1,
      },
    ]);
  });

  it("numbers sort_order continuously across runs and across recipes", () => {
    const rows = flattenMaterialBreakdowns([
      lineBreakdown("r1", "Fortnight", [
        { format: "loose", packages: 10, unitsPerPackage: 1, components: [can], label: "A" },
        { format: "loose", packages: 20, unitsPerPackage: 1, components: [can], label: "B" },
      ]),
      lineBreakdown("r2", "Argus", [
        { format: "loose", packages: 30, unitsPerPackage: 1, components: [can], label: "C" },
      ]),
    ]);
    expect(rows.map((r) => [r.recipe_id, r.variant_label, r.sort_order])).toEqual([
      ["r1", "A", 0],
      ["r1", "B", 1],
      ["r2", "C", 2],
    ]);
  });

  it("stored cents sum to the breakdown total that priced the invoice line", () => {
    const b = lineBreakdown("r1", "Fortnight", [
      { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid] },
    ]);
    const rows = flattenMaterialBreakdowns([b]);
    expect(rows.reduce((s, r) => s + r.line_total_cents, 0)).toBe(b.totalCents);
  });

  it("preserves a null unit cost rather than coercing it to 0 — $0 billed is not $0 cost", () => {
    const noCostCan = { role: "container" as const, name: "12oz Can", unitCostDollars: null, canCount: null };
    const rows = flattenMaterialBreakdowns([
      lineBreakdown("r1", null, [{ format: "loose", packages: 5, unitsPerPackage: 1, components: [noCostCan] }]),
    ]);
    expect(rows[0]).toMatchObject({ unit_cost_usd: null, quantity_used: 5, line_total_cents: 0, beer_name: null });
  });

  it("returns no rows for an empty snapshot", () => {
    expect(flattenMaterialBreakdowns([])).toEqual([]);
    expect(flattenMaterialBreakdowns([lineBreakdown("r1", "Fortnight", [])])).toEqual([]);
  });
});
