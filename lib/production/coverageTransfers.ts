import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which conversion children actually carry a parent's deposit coverage.
 *
 * A parent batch's deposit pays for the parent's share of the grain — nothing
 * more. It covers a conversion child's base only when the transfer-coverage
 * route recorded that the paid invoice now spans the child (an
 * `invoice_batch_links` row). Without that row, the child's base was billed to
 * nobody: B-069 Oatmeal Stout's 15% deposit (#000072) paid for the Oatmeal
 * Stout Argus kept, not the 75% of the tank that became Cherry Chocolate Stout.
 *
 * Returns keys `${childBatchId}:${squareInvoiceId}` for every non-voided
 * invoice linked to each child. `admin` must bypass RLS — `invoices` and
 * `invoice_batch_links` are finance-locked and read as zero rows otherwise.
 */
export async function loadCoverageTransfers(
  admin: SupabaseClient,
  childBatchIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (childBatchIds.length === 0) return out;
  const { data: links } = await admin
    .from("invoice_batch_links")
    .select("batch_id, invoice_id")
    .in("batch_id", childBatchIds);
  const rows = (links ?? []) as Array<{ batch_id: string; invoice_id: string }>;
  if (rows.length === 0) return out;
  const { data: invoices } = await admin
    .from("invoices")
    .select("id, square_invoice_id")
    .in("id", [...new Set(rows.map((r) => r.invoice_id))])
    .neq("status", "voided");
  const squareIdById = new Map(
    ((invoices ?? []) as Array<{ id: string; square_invoice_id: string | null }>)
      .filter((i) => !!i.square_invoice_id)
      .map((i) => [i.id, i.square_invoice_id as string]),
  );
  for (const r of rows) {
    const sq = squareIdById.get(r.invoice_id);
    if (sq) out.add(`${r.batch_id}:${sq}`);
  }
  return out;
}

/** Whether `parent`'s own deposit invoice was carried over to `childBatchId`. */
export function coverageTransferred(
  transfers: Set<string>,
  childBatchId: string,
  parent: { square_deposit_invoice_id: string | null } | null,
): boolean {
  return !!parent?.square_deposit_invoice_id
    && transfers.has(`${childBatchId}:${parent.square_deposit_invoice_id}`);
}
