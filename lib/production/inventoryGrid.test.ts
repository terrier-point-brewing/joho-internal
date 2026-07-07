import { describe, it, expect } from "vitest";
import { buildInventoryGrid, type LinkInventory } from "./inventoryGrid";
import type { ColumnDef, GridRow } from "./squareMappingGrid";

const columns: ColumnDef[] = [
  { key: "draft", label: "Draft", type: "draft", volumeFlOz: null, format: null },
  { key: "keg|1984", label: "1/2 Keg", type: "keg", volumeFlOz: 1984, format: null },
  { key: "can|12|6-pack", label: "12oz 6-Pack", type: "can", volumeFlOz: 12, format: "6-pack" },
];

// Minimal cell-variation factory — only the fields buildInventoryGrid reads.
function cellVar(variationId: string, variationName: string, linkId: string | null) {
  return {
    variationId,
    variationName,
    linkId,
    linkedSquareCatalogVariationId: null,
    linkedSquareName: linkId ? "Square Item" : null,
    suggestion: null,
  };
}

function row(recipeId: string, recipeName: string, cells: GridRow["cells"], partner: string | null = null): GridRow {
  return { recipeId, recipeName, recipePartnerName: partner, cells };
}

describe("buildInventoryGrid", () => {
  it("joins on-hand quantities by link id and sums row/column/grand totals", () => {
    const rows: GridRow[] = [
      row("r1", "Coast IPA", {
        draft: { variations: [cellVar("draft", "Draft", "L1")] },
        "keg|1984": { variations: [cellVar("v-keg", "1/2 Keg", "L2")] },
        "can|12|6-pack": { variations: [cellVar("v-can", "12oz 6-Pack", "L3")] },
      }),
      row("r2", "Amber Ale", {
        draft: { variations: [cellVar("draft", "Draft", "L4")] },
        "keg|1984": { variations: [cellVar("v-keg", "1/2 Keg", "L5")] },
        "can|12|6-pack": null, // recipe has no can variation — structural empty
      }),
    ];

    const inv = new Map<string, LinkInventory>([
      ["L1", { currentQty: 3968, currentBbl: 1, packaging: "draft" }],
      ["L2", { currentQty: 4, currentBbl: 2, packaging: "keg" }],
      ["L3", { currentQty: 24, currentBbl: 0.5, packaging: "can" }],
      ["L4", { currentQty: 1984, currentBbl: 0.5, packaging: "draft" }],
      ["L5", { currentQty: 2, currentBbl: 1, packaging: "keg" }],
    ]);

    const grid = buildInventoryGrid({ columns, rows }, inv);

    // Row totals
    expect(grid.rows[0].totalBbl).toBe(3.5); // 1 + 2 + 0.5
    expect(grid.rows[1].totalBbl).toBe(1.5); // 0.5 + 1

    // Structural empty preserved as null
    expect(grid.rows[1].cells["can|12|6-pack"]).toBeNull();

    // Cell contents
    expect(grid.rows[0].cells["keg|1984"]).toEqual({
      totalBbl: 2,
      variations: [{ variationId: "v-keg", variationName: "1/2 Keg", packaging: "keg", currentQty: 4, currentBbl: 2 }],
    });

    // Column totals
    expect(grid.columnTotals["draft"]).toBe(1.5);
    expect(grid.columnTotals["keg|1984"]).toBe(3);
    expect(grid.columnTotals["can|12|6-pack"]).toBe(0.5);

    // Grand total
    expect(grid.grandTotalBbl).toBe(5);
  });

  it("drops recipes with no on-hand stock so only taproom-available inventory shows", () => {
    const rows: GridRow[] = [
      row("r1", "Ghost Beer", {
        draft: { variations: [cellVar("draft", "Draft", null)] }, // unmapped
        "keg|1984": { variations: [cellVar("v-keg", "1/2 Keg", "L-missing")] }, // linked but no inventory row
        "can|12|6-pack": null,
      }),
      // Partner beer that is brewed here but not stocked for the taproom.
      row("r2", "Contract Lager", {
        draft: null,
        "keg|1984": { variations: [cellVar("v-keg2", "1/2 Keg", "L-empty")] },
        "can|12|6-pack": null,
      }, "Fortnight Brewing"),
    ];

    const grid = buildInventoryGrid({ columns, rows }, new Map());

    // No stock anywhere → both rows are dropped from the taproom-availability view.
    expect(grid.rows).toHaveLength(0);
    expect(grid.grandTotalBbl).toBe(0);
  });

  it("keeps a recipe with stock but drops its zero-stock partner neighbours", () => {
    const rows: GridRow[] = [
      row("r1", "Stocked IPA", {
        draft: { variations: [cellVar("draft", "Draft", "L1")] },
        "keg|1984": null,
        "can|12|6-pack": null,
      }),
      row("r2", "Empty Partner Ale", {
        draft: { variations: [cellVar("draft", "Draft", "L2")] },
        "keg|1984": null,
        "can|12|6-pack": null,
      }, "Argus Beverage Ventures LLC"),
    ];

    const inv = new Map<string, LinkInventory>([
      ["L1", { currentQty: 1984, currentBbl: 0.5, packaging: "draft" }],
      // L2 has an inventory row but zero on hand — not available to the taproom.
      ["L2", { currentQty: 0, currentBbl: 0, packaging: "draft" }],
    ]);

    const grid = buildInventoryGrid({ columns, rows }, inv);

    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].recipeName).toBe("Stocked IPA");
  });
});
