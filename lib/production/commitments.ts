/**
 * Ingredient commitment helpers.
 *
 * A "commitment" reserves ingredient stock for a batch that is still in
 * planning/backlog.  It is NOT a stock deduction — the actual deduction
 * happens in tank-assignments when the batch hits the brewhouse.
 *
 * effective_available = stock_quantity - SUM(active commitments)
 *
 * Commitments are released when:
 *   • the batch is archived (cancelled), or
 *   • the batch is assigned to a brewhouse (stock is consumed instead)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface IngredientShortfall {
  ingredient_id: string;
  name: string;
  unit: string;
  stock_quantity: number;
  total_committed: number;   // across ALL active batches
  this_batch_committed: number;
  shortfall: number;         // total_committed - stock_quantity (always > 0)
}

/** Create or update commitments for every ingredient in the recipe × volume. */
export async function upsertCommitments(
  supabase: SupabaseClient,
  batchId: string,
  recipeId: string,
  volumeBbl: number,
): Promise<void> {
  const { data: ris } = await supabase
    .from("recipe_ingredients")
    .select("ingredient_id, quantity_per_bbl")
    .eq("recipe_id", recipeId);

  if (!ris?.length) return;

  await supabase
    .from("batch_ingredient_commitments")
    .upsert(
      ris.map((ri) => ({
        batch_id:      batchId,
        ingredient_id: ri.ingredient_id,
        committed_qty: ri.quantity_per_bbl * volumeBbl,
      })),
      { onConflict: "batch_id,ingredient_id" },
    );
}

/** Mark all active commitments for a batch as released (archived or brewed). */
export async function releaseCommitments(
  supabase: SupabaseClient,
  batchId: string,
): Promise<void> {
  await supabase
    .from("batch_ingredient_commitments")
    .update({ released_at: new Date().toISOString() })
    .eq("batch_id", batchId)
    .is("released_at", null);
}

/**
 * Return any ingredient shortfalls caused by this batch's commitments.
 * A shortfall exists when total active commitments across all batches
 * exceed the ingredient's current stock_quantity.
 */
export async function getShortfalls(
  supabase: SupabaseClient,
  batchId: string,
): Promise<IngredientShortfall[]> {
  // This batch's active commitments
  const { data: mine } = await supabase
    .from("batch_ingredient_commitments")
    .select("ingredient_id, committed_qty, ingredients(name, unit, stock_quantity)")
    .eq("batch_id", batchId)
    .is("released_at", null);

  if (!mine?.length) return [];

  const shortfalls: IngredientShortfall[] = [];

  for (const c of mine) {
    const ing = (c.ingredients as unknown) as { name: string; unit: string; stock_quantity: number } | null;
    if (!ing) continue;

    // Total committed for this ingredient across all unreleased batches
    const { data: all } = await supabase
      .from("batch_ingredient_commitments")
      .select("committed_qty")
      .eq("ingredient_id", c.ingredient_id)
      .is("released_at", null);

    const totalCommitted = (all ?? []).reduce((s, x) => s + Number(x.committed_qty), 0);
    const effective = Number(ing.stock_quantity) - totalCommitted;

    if (effective < -0.001) {
      shortfalls.push({
        ingredient_id:        c.ingredient_id,
        name:                 ing.name,
        unit:                 ing.unit,
        stock_quantity:       Number(ing.stock_quantity),
        total_committed:      Math.round(totalCommitted * 1000) / 1000,
        this_batch_committed: Number(c.committed_qty),
        shortfall:            Math.round(Math.abs(effective) * 1000) / 1000,
      });
    }
  }

  return shortfalls;
}
