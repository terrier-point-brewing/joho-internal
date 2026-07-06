// lib/production/inventoryGrid.ts
//
// Pure transform: takes the Square-mapping grid (columns + rows, from
// fetchMappingGrid) and a map of link_id → on-hand inventory (from
// fetchSellThrough) and produces a taproom cold-storage inventory grid.
//
// The mapping grid already establishes which recipe/variation belongs in which
// column and carries the recipe_square_links id (`linkId`) on every linked cell
// variation. Sell-through supplies on-hand quantity keyed by that same link id,
// so the two join with zero re-derivation. Suggestions and unlinked/no-inventory
// variations are dropped — this view shows only what is actually sellable.

import type { ColumnDef, GridRow } from "@/lib/production/squareMappingGrid";

export type Packaging = "draft" | "keg" | "can";

/** On-hand inventory for a single recipe_square_links row. */
export interface LinkInventory {
  currentQty: number; // draft: fl oz remaining in keg. keg/can: unit count.
  currentBbl: number;
  packaging: Packaging;
}

export interface InventoryCellVariation {
  variationId: string;
  variationName: string;
  packaging: Packaging;
  currentQty: number;
  currentBbl: number;
}

export interface InventoryCell {
  totalBbl: number;
  variations: InventoryCellVariation[];
}

export interface InventoryRow {
  recipeId: string;
  recipeName: string;
  recipePartnerName: string | null;
  totalBbl: number;
  cells: Record<string, InventoryCell | null>; // null = recipe has no variation for this column
}

export interface InventoryGrid {
  columns: ColumnDef[];
  rows: InventoryRow[];
  columnTotals: Record<string, number>;
  grandTotalBbl: number;
}

const round = (n: number) => Number(n.toFixed(2));

export function buildInventoryGrid(
  grid: { columns: ColumnDef[]; rows: GridRow[] },
  inventoryByLinkId: Map<string, LinkInventory>,
): InventoryGrid {
  const { columns } = grid;
  const columnTotals: Record<string, number> = Object.fromEntries(columns.map((c) => [c.key, 0]));
  let grandTotalBbl = 0;

  const rows: InventoryRow[] = grid.rows.map((row) => {
    const cells: Record<string, InventoryCell | null> = {};
    let rowTotalBbl = 0;

    for (const col of columns) {
      const cell = row.cells[col.key];

      // Structural empty — recipe has no variation for this column.
      if (cell === null || cell === undefined) {
        cells[col.key] = null;
        continue;
      }

      const variations: InventoryCellVariation[] = [];
      for (const v of cell.variations) {
        // Only linked variations can carry inventory; skip suggestions/unmapped slots.
        if (!v.linkId) continue;
        const inv = inventoryByLinkId.get(v.linkId);
        if (!inv) continue;
        variations.push({
          variationId: v.variationId,
          variationName: v.variationName,
          packaging: inv.packaging,
          currentQty: inv.currentQty,
          currentBbl: inv.currentBbl,
        });
      }

      const cellTotal = variations.reduce((s, v) => s + v.currentBbl, 0);
      cells[col.key] = { totalBbl: round(cellTotal), variations };
      rowTotalBbl += cellTotal;
      columnTotals[col.key] += cellTotal;
    }

    grandTotalBbl += rowTotalBbl;
    return {
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      recipePartnerName: row.recipePartnerName,
      totalBbl: round(rowTotalBbl),
      cells,
    };
  });

  for (const key of Object.keys(columnTotals)) columnTotals[key] = round(columnTotals[key]);

  return { columns, rows, columnTotals, grandTotalBbl: round(grandTotalBbl) };
}
