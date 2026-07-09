import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export interface BreakdownInput {
  ingredient_id: string | null;
  name: string;
  unit: string;
  quantity_per_bbl: number;
  cost_per_unit: number;
  /** Relative cost weight; common factors (volume, %) cancel under scaling. */
  weight: number;
}

export interface BreakdownLine {
  ingredient_id: string | null;
  ingredient_name: string;
  unit: string;
  quantity_per_bbl: number;
  cost_per_unit: number;
  line_total_cents: number;
  sort_order: number;
}

/**
 * Convert weighted breakdown inputs into stored lines whose integer
 * line_total_cents sum EXACTLY to invoiceTotalCents (largest-remainder rounding).
 * Returns [] when total weight is non-positive (can't proportion).
 */
export function buildBreakdownLines(
  inputs: BreakdownInput[],
  invoiceTotalCents: number
): BreakdownLine[] {
  const totalWeight = inputs.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (totalWeight <= 0 || inputs.length === 0) return [];

  const raw = inputs.map((i) => (Math.max(0, i.weight) / totalWeight) * invoiceTotalCents);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = invoiceTotalCents - floors.reduce((s, f) => s + f, 0);

  // Distribute leftover cents to the largest fractional parts (ties: lower index).
  const order = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const cents = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    cents[order[k].idx] += 1;
    remainder--;
  }

  return inputs.map((i, idx) => ({
    ingredient_id: i.ingredient_id,
    ingredient_name: i.name,
    unit: i.unit,
    quantity_per_bbl: i.quantity_per_bbl,
    cost_per_unit: i.cost_per_unit,
    line_total_cents: cents[idx],
    sort_order: idx,
  }));
}

/**
 * Replace the stored breakdown for a deposit invoice with a fresh snapshot.
 * Deletes existing lines then inserts the scaled lines. No-op insert if empty.
 */
export async function snapshotDepositBreakdown(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  invoiceId: string,
  inputs: BreakdownInput[],
  invoiceTotalCents: number
): Promise<void> {
  const lines = buildBreakdownLines(inputs, invoiceTotalCents);

  await admin.from("deposit_invoice_ingredients").delete().eq("invoice_id", invoiceId);

  if (lines.length === 0) return;

  await admin.from("deposit_invoice_ingredients").insert(
    lines.map((l) => ({
      invoice_id: invoiceId,
      ingredient_id: l.ingredient_id,
      ingredient_name: l.ingredient_name,
      unit: l.unit,
      quantity_per_bbl: l.quantity_per_bbl,
      cost_per_unit: l.cost_per_unit,
      line_total_cents: l.line_total_cents,
      sort_order: l.sort_order,
    }))
  );
}
