// Identifies a FinancialsRow synthesized from an operator-entered manual
// entry (manualNetSales.ts's injectManualNetSales). Lives in its own
// dependency-free module because three unrelated layers need the same
// predicate -- the tree builder (break the adjustment out as its own line),
// the data-quality summary (don't flag it as uncategorized), and the injector
// that stamps the marker in the first place -- and one of them
// (app/finance/financials/buildTree.ts) is pulled into the client bundle, so
// it must not reach this through aggregateRows' transitive imports.
//
// sourceRef.table -- NOT mappingSource -- is the discriminant. A "manual"
// mappingSource means "this row's ACCOUNT was chosen by hand rather than by
// rule" and is set on ordinary bank rows and expense splits too;
// manual_entries is the only producer of adjustment rows.

import type { FinancialsRow } from "./types";

export const MANUAL_ADJUSTMENT_TABLE = "manual_entries";

export function isManualAdjustmentRow(row: FinancialsRow): boolean {
  return row.sourceRef.table === MANUAL_ADJUSTMENT_TABLE;
}
