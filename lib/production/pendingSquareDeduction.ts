// lib/production/pendingSquareDeduction.ts
//
// Which recipes is Square still going to decrement by itself?
//
// An absolute push sets Square's count to cold storage's. That is only correct
// when Square has nothing of its own left to subtract. Between shipping stock on
// a wholesale or distribution order and that order's invoice deducting, Square
// has EXACTLY that: a decrement still owed. Pushing into that window hands the
// pending deduction a lower starting point, and it then takes the same units a
// second time.
//
//   ship 24 of 100      cold storage 76, Square 100   (Square stale but owed -24)
//   push sets Square 76 cold storage 76, Square  76   (looks right)
//   invoice deducts 24  cold storage 76, Square  52   (wrong, by exactly the ship)
//
// Left alone, Square goes 100 → 76 on its own and lands correct. The push and
// the invoice are two mechanisms for one event; running both double-counts.
//
// So the push skips these recipes until the invoice settles, and the drift view
// labels them rather than reporting a variance that is expected and temporary.
//
// Contract brewing is deliberately NOT pending: those invoices bill packaging
// fees, excise and services, never inventory-tracked product SKUs, so Square
// will never decrement for them. Cold storage is the only side that moves, and
// the push is the only thing that can tell Square the beer is gone.
//
// Taproom rows are already terminal ('paid') at the point of sale.

/** Channels whose invoices carry inventory-tracked product SKUs, so Square self-decrements. */
const SELF_DECREMENTING_CHANNELS = new Set(["distribution", "wholesale"]);

export interface ExportStatusRow {
  recipeId: string | null;
  channel: string;
  status: string;
}

/**
 * PURE. Recipes with stock that has shipped but whose Square-side deduction has
 * not landed yet.
 *
 * `invoice_required` counts as pending just as much as `unpaid`: no invoice
 * exists yet, so the deduction is further away, not closer.
 */
export function selectPendingDeductionRecipes(rows: ExportStatusRow[]): Set<string> {
  const pending = new Set<string>();
  for (const r of rows) {
    if (!r.recipeId) continue;
    if (!SELF_DECREMENTING_CHANNELS.has(r.channel)) continue;
    if (r.status === "paid") continue;
    pending.add(r.recipeId);
  }
  return pending;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

export async function loadPendingDeductionRecipes(db: Db): Promise<Set<string>> {
  const { data, error } = await db
    .from("export_transactions")
    .select("recipe_id, channel, status")
    .neq("status", "paid");
  if (error) throw new Error(error.message);

  return selectPendingDeductionRecipes(
    ((data ?? []) as { recipe_id: string | null; channel: string; status: string }[]).map((r) => ({
      recipeId: r.recipe_id,
      channel: r.channel,
      status: r.status,
    })),
  );
}
