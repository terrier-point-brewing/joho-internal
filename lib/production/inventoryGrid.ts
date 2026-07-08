// lib/production/inventoryGrid.ts
//
// Pure transform: joins the Square-mapping grid (columns + rows) with on-hand
// inventory to produce the taproom cold-storage inventory grid.
//
// SOURCE OF TRUTH: keg/can quantities come from cold_storage_inventory (keyed by
// recipe_id + packaging_variation), NOT Square. Square's per-format can counts are
// unit-conversion derivations (base loose ÷ pack size) and are not real inventory.
// Draft is the one exception — the tapped keg's remaining fl oz still lives in
// Square, so draft cells read the draft map. Only linked (mapped/sellable)
// variations are shown; unmapped recipes are dropped.

import type { ColumnDef, GridRow } from "@/lib/production/squareMappingGrid";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { coldStorageKey, type ColdStorageOnHand } from "@/lib/production/coldStorageOnHand";

export type Packaging = "draft" | "keg" | "can";

export interface DraftOnHand {
  currentQty: number; // fl oz remaining in the tapped keg
  currentBbl: number;
}

export interface InventorySources {
  coldStorage: Map<string, ColdStorageOnHand>; // key: coldStorageKey(recipeId, variationId)
  draftByLinkId: Map<string, DraftOnHand>;
}

export interface InventoryCellVariation {
  variationId: string;
  variationName: string;
  packaging: Packaging;
  format: string | null; // 'loose' | '4-pack' | '6-pack' | 'case' for cans; null otherwise
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
  cells: Record<string, InventoryCell | null>;
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
  sources: InventorySources,
): InventoryGrid {
  const { columns } = grid;
  const columnTotals: Record<string, number> = Object.fromEntries(columns.map((c) => [c.key, 0]));
  let grandTotalBbl = 0;

  const built = grid.rows.map((row) => {
    const cells: Record<string, InventoryCell | null> = {};
    let rowTotalBbl = 0;
    let mapped = false;

    for (const col of columns) {
      const cell = row.cells[col.key];
      if (cell === null || cell === undefined) {
        cells[col.key] = null;
        continue;
      }

      const variations: InventoryCellVariation[] = [];
      for (const v of cell.variations) {
        if (!v.linkId) continue; // only mapped/sellable variations carry inventory
        mapped = true;

        if (col.type === "draft") {
          const inv = sources.draftByLinkId.get(v.linkId);
          if (!inv) continue;
          variations.push({
            variationId: v.variationId,
            variationName: v.variationName,
            packaging: "draft",
            format: null,
            currentQty: inv.currentQty,
            currentBbl: inv.currentBbl,
          });
        } else {
          const inv = sources.coldStorage.get(coldStorageKey(row.recipeId, v.variationId));
          if (!inv) continue;
          const currentBbl = (inv.qty * inv.totalVolumeFlOz) / BBL_TO_FL_OZ;
          variations.push({
            variationId: v.variationId,
            variationName: v.variationName,
            packaging: col.type, // 'keg' | 'can'
            format: col.format,
            currentQty: inv.qty,
            currentBbl,
          });
        }
      }

      const cellTotal = variations.reduce((s, v) => s + v.currentBbl, 0);
      cells[col.key] = { totalBbl: round(cellTotal), variations };
      rowTotalBbl += cellTotal;
      columnTotals[col.key] += cellTotal;
    }

    grandTotalBbl += rowTotalBbl;
    const inventoryRow: InventoryRow = {
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      recipePartnerName: row.recipePartnerName,
      totalBbl: round(rowTotalBbl),
      cells,
    };
    return { inventoryRow, mapped };
  });

  for (const key of Object.keys(columnTotals)) columnTotals[key] = round(columnTotals[key]);
  const rows = built.filter((b) => b.mapped).map((b) => b.inventoryRow);
  return { columns, rows, columnTotals, grandTotalBbl: round(grandTotalBbl) };
}
