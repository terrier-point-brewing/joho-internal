import { describe, it, expect } from "vitest";
import { buildInventoryGrid, type InventorySources } from "./inventoryGrid";
import { coldStorageKey } from "./coldStorageOnHand";
import type { ColdStorageOnHand } from "./coldStorageOnHand";
import type { ColumnDef, GridRow } from "./squareMappingGrid";

const columns: ColumnDef[] = [
  { key: "draft", label: "Draft", type: "draft", volumeFlOz: null, format: null },
  { key: "keg|1984", label: "1/2 Keg", type: "keg", volumeFlOz: 1984, format: null },
  { key: "can|16|loose", label: "16oz Loose", type: "can", volumeFlOz: 16, format: "loose" },
  { key: "can|16|case", label: "16oz Case", type: "can", volumeFlOz: 16, format: "case" },
];

function cellVar(variationId: string, variationName: string, linkId: string | null) {
  return { variationId, variationName, linkId, linkedSquareCatalogVariationId: null, linkedSquareName: linkId ? "Square Item" : null, suggestion: null };
}
function row(recipeId: string, recipeName: string, cells: GridRow["cells"], partner: string | null = null): GridRow {
  return { recipeId, recipeName, recipePartnerName: partner, cells };
}
const cs = (qty: number, vol: number, format: string, ct: "keg" | "can"): ColdStorageOnHand => ({ qty, totalVolumeFlOz: vol, format, containerType: ct });

describe("buildInventoryGrid", () => {
  it("sources keg/can from cold storage and draft from the draft map, computing bbl per format", () => {
    const rows: GridRow[] = [
      row("r1", "Blackberry Lemon Wheat", {
        draft: { variations: [cellVar("draft", "Draft", "L1")] },
        "keg|1984": { variations: [cellVar("v-keg", "1/2 Keg", "L2")] },
        "can|16|loose": { variations: [cellVar("v-loose", "16oz Labeled Can", "L3")] },
        "can|16|case": { variations: [cellVar("v-case", "16oz Labeled Can Case", "L4")] },
      }),
    ];
    const sources: InventorySources = {
      coldStorage: new Map([
        [coldStorageKey("r1", "v-keg"), cs(1, 1984, "loose" /* n/a for keg */, "keg")],
        [coldStorageKey("r1", "v-loose"), cs(8, 16, "loose", "can")],
        [coldStorageKey("r1", "v-case"), cs(1, 384, "case", "can")],
      ]),
      draftByLinkId: new Map([["L1", { currentQty: 1984, currentBbl: 0.5 }]]),
    };

    const grid = buildInventoryGrid({ columns, rows }, sources);
    const cells = grid.rows[0].cells;

    // Cold-storage counts flow straight through (no Square fractional derivation).
    expect(cells["can|16|loose"]!.variations[0]).toMatchObject({ packaging: "can", format: "loose", currentQty: 8 });
    expect(cells["can|16|case"]!.variations[0]).toMatchObject({ packaging: "can", format: "case", currentQty: 1 });
    // bbl uses the per-format total volume: case = 384 fl oz.
    expect(cells["can|16|case"]!.variations[0].currentBbl).toBeCloseTo(384 / 3968.077, 3);
    // Draft still comes from the draft map.
    expect(cells["draft"]!.variations[0]).toMatchObject({ packaging: "draft", currentBbl: 0.5 });
  });

  it("drops unmapped recipes but keeps mapped-but-empty ones (no cold-storage row → qty 0)", () => {
    const rows: GridRow[] = [
      row("r1", "Unmapped House Ale", { draft: { variations: [cellVar("draft", "Draft", null)] } }),
      row("r2", "Mapped But Empty", { draft: { variations: [cellVar("draft", "Draft", "L-empty")] } }, "Fortnight Brewing"),
    ];
    const grid = buildInventoryGrid({ columns, rows }, { coldStorage: new Map(), draftByLinkId: new Map() });
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].recipeName).toBe("Mapped But Empty");
  });
});
