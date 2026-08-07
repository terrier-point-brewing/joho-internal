// lib/production/materialBreakdownSnapshot.ts
//
// Freezes the Packaging Materials cost derivation onto an export invoice.
// Mirrors depositBreakdown.ts: flatten → delete → insert, replaced wholesale if
// the invoice is regenerated. Packaging item unit costs drift over time, so
// recomputing later would not reproduce what the customer was billed.
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MaterialLineBreakdown } from "./exportInvoicePreview";

/** One stored row: a single component consumed by a single packaging run. */
export interface MaterialComponentRow {
  recipe_id: string | null;
  beer_name: string | null;
  variant_label: string | null;
  packaging_format: string;
  packages: number;
  units_per_package: number;
  component_role: string;
  component_name: string;
  unit_cost_usd: number | null;
  quantity_used: number;
  line_total_cents: number;
  sort_order: number;
}

/**
 * Flatten the nested breakdown (recipe → packaging runs → components) into the
 * storage shape. sort_order is a single running index across the whole invoice,
 * so reading the rows back in that order reproduces the display grouping.
 * Exported for unit testing.
 */
export function flattenMaterialBreakdowns(breakdowns: MaterialLineBreakdown[]): MaterialComponentRow[] {
  const rows: MaterialComponentRow[] = [];
  for (const b of breakdowns) {
    for (const txn of b.transactions) {
      for (const c of txn.components) {
        rows.push({
          recipe_id: b.recipeId,
          beer_name: b.beerName,
          variant_label: txn.label,
          packaging_format: txn.format,
          packages: txn.packages,
          units_per_package: txn.unitsPerPackage,
          component_role: c.role,
          component_name: c.name,
          unit_cost_usd: c.unitCostDollars,
          quantity_used: c.quantity,
          line_total_cents: c.extendedCents,
          sort_order: rows.length,
        });
      }
    }
  }
  return rows;
}

/**
 * Replace the stored materials derivation for an invoice with a fresh snapshot.
 * Always clears first, so regenerating an invoice whose materials no longer
 * apply leaves no stale rows behind.
 */
export async function snapshotMaterialBreakdown(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  invoiceId: string,
  breakdowns: MaterialLineBreakdown[]
): Promise<void> {
  const rows = flattenMaterialBreakdowns(breakdowns);

  await admin.from("export_invoice_material_components").delete().eq("invoice_id", invoiceId);

  if (rows.length === 0) return;

  await admin.from("export_invoice_material_components").insert(
    rows.map((r) => ({ invoice_id: invoiceId, ...r }))
  );
}
