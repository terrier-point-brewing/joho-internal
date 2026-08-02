/**
 * Per-line sales-tax rows, shared by both line-item tables.
 *
 * Lives in its own module rather than in syncPosTransactions.ts so that the
 * canonical invoice writer (lib/finance/invoiceLineItems.ts) can use it without
 * the two modules importing each other: syncPosTransactions now writes invoice
 * lines THROUGH that canonical writer, and a cycle between the two is the kind
 * of thing that resolves fine today and breaks on an unrelated refactor.
 *
 * Re-exported from syncPosTransactions.ts so existing importers keep resolving
 * it from there.
 */
import type { Order } from "@/types/square";

/**
 * One row for `pos_line_item_taxes` or its invoice-side sibling table — the
 * two tables are structurally identical, so one builder serves both. The
 * caller decides which table to insert into by which db-id map it passes.
 * (The invoice-side insert itself lives in lib/finance/invoiceLineItems.ts,
 * the canonical writer for that table.)
 */
export interface LineItemTaxRow {
  line_item_id: string;
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  amount_cents: number;
}

/**
 * Line-item tax rows for one order. Pure. Resolves each line's
 * `applied_taxes[].tax_uid` against the order's `taxes[]` (catalog tax id +
 * name + rate) and looks up the line's already-inserted db id via
 * `lineItemDbIdByUid` (keyed by `square_line_item_uid`, scoped to this order —
 * uids are only unique within a single order's line_items).
 */
export function buildLineItemTaxRows(
  order: Order,
  lineItemDbIdByUid: Map<string, string>,
): LineItemTaxRow[] {
  const taxByUid = new Map((order.taxes ?? []).map((t) => [t.uid, t]));
  const rows: LineItemTaxRow[] = [];
  for (const li of order.line_items ?? []) {
    const lineItemDbId = li.uid ? lineItemDbIdByUid.get(li.uid) : undefined;
    if (!lineItemDbId) continue;
    for (const at of li.applied_taxes ?? []) {
      const tax = taxByUid.get(at.tax_uid);
      if (!tax) continue;
      rows.push({
        line_item_id: lineItemDbId,
        square_tax_id: tax.catalog_object_id ?? tax.uid,
        tax_name: tax.name ?? null,
        tax_pct: tax.percentage != null ? parseFloat(tax.percentage) : null,
        amount_cents: at.applied_money?.amount ?? 0,
      });
    }
  }
  return rows;
}
