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
  total_committed: number;      // across all pre-brew batches
  this_batch_committed: number;
  /** Stock left for this batch after earlier-dated pre-brew batches take theirs. */
  available_to_batch: number;
  shortfall: number;            // this_batch_committed - available_to_batch (always > 0)
}

/**
 * Make this batch's commitments match the recipe × volume exactly.
 *
 * This REPLACES the batch's commitment set rather than adding to it. Upserting
 * alone would leave the previous recipe's ingredients behind on a recipe swap,
 * and the shortfall dialog reads commitments (not the recipe), so the batch
 * would report the union of both recipes — B-056 showed Epic Hazy IPA's twelve
 * ingredients while linked to Pace Yourself Pilsner. Anything not in the recipe
 * is released here, including every line when the recipe is emptied.
 */
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

  if (!ris?.length) {
    // A recipe with no lines commits nothing — drop whatever the batch still holds.
    await releaseCommitments(supabase, batchId);
    return;
  }

  await supabase
    .from("batch_ingredient_commitments")
    .upsert(
      ris.map((ri) => ({
        batch_id:      batchId,
        ingredient_id: ri.ingredient_id,
        committed_qty: ri.quantity_per_bbl * volumeBbl,
        // The unique key is (batch_id, ingredient_id) with no regard for
        // released_at, so an ingredient that was pruned on an earlier swap and
        // has now come back resolves to that same released row. Without this the
        // upsert would refresh its quantity but leave it released — committing
        // nothing, and silently hiding the shortfall.
        released_at:   null,
      })),
      { onConflict: "batch_id,ingredient_id" },
    );

  // Release the leftovers from whatever recipe this batch used before.
  await supabase
    .from("batch_ingredient_commitments")
    .update({ released_at: new Date().toISOString() })
    .eq("batch_id", batchId)
    .is("released_at", null)
    .not("ingredient_id", "in", `(${ris.map((ri) => ri.ingredient_id).join(",")})`);
}

/** Batch statuses that have NOT yet consumed their ingredients. */
const PRE_BREW_STATUSES = ["planning", "backlog"];

/**
 * Re-apply a recipe's ingredient lines to every pre-brew batch using it.
 *
 * Editing a recipe rewrites `recipe_ingredients`, but each batch's commitments
 * were computed at assignment time and would otherwise stay frozen at the old
 * quantities forever — B-056 sat at 900 lb of Pilsner Malt long after the recipe
 * had moved to 660. Batches past planning are skipped: their ingredients are
 * already physically deducted, so re-committing would double-charge stock.
 */
export async function resyncRecipeCommitments(
  supabase: SupabaseClient,
  recipeId: string,
): Promise<void> {
  const { data: batches } = await supabase
    .from("brew_batches")
    .select("id, volume_bbl")
    .eq("recipe_id", recipeId)
    .in("status", PRE_BREW_STATUSES);

  for (const b of batches ?? []) {
    if (b.volume_bbl == null) continue;
    await upsertCommitments(supabase, b.id, recipeId, Number(b.volume_bbl));
  }
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

export interface GetShortfallsOptions {
  /**
   * Skip Yeast-category ingredients. Set when the batch is flagged as a yeast
   * re-pitch — the yeast is cropped from a previous batch, so the recipe's
   * yeast line never draws stock and must not block the brewhouse assignment.
   */
  excludeYeast?: boolean;
}

/**
 * Return the ingredient shortfalls that would block THIS batch from brewing.
 *
 * Stock is allocated to pre-brew batches in planned_brew_date order: the batch
 * that brews first gets first claim. A batch is short only on what is left after
 * every earlier-dated batch has taken its share. That keeps the genuine
 * over-booking signal (the later batch reports the shortfall) without falsely
 * blocking the batch that is actually next to brew.
 *
 * Two things deliberately do NOT count against the pool:
 *   • commitments held by batches past planning — those ingredients are already
 *     physically deducted from stock_quantity, so counting the reservation too
 *     would double-charge them (this is what made B-034 report 9 phantom shorts)
 *   • the batch's own commitment, which is what we're testing for
 */
export async function getShortfalls(
  supabase: SupabaseClient,
  batchId: string,
  options: GetShortfallsOptions = {},
): Promise<IngredientShortfall[]> {
  // This batch's active commitments
  const { data: mine } = await supabase
    .from("batch_ingredient_commitments")
    .select("ingredient_id, committed_qty, ingredients(name, unit, stock_quantity, category)")
    .eq("batch_id", batchId)
    .is("released_at", null);

  if (!mine?.length) return [];

  // Where this batch sits in the brew queue. A batch with no planned date sorts
  // last, so it never displaces a dated batch from stock it has already claimed.
  const { data: self } = await supabase
    .from("brew_batches")
    .select("planned_brew_date")
    .eq("id", batchId)
    .maybeSingle();
  const myDate = self?.planned_brew_date ?? null;

  const shortfalls: IngredientShortfall[] = [];

  for (const c of mine) {
    const ing = (c.ingredients as unknown) as
      { name: string; unit: string; stock_quantity: number; category: string | null } | null;
    if (!ing) continue;
    if (options.excludeYeast && ing.category === "Yeast") continue;

    // Every unreleased commitment for this ingredient, with the owning batch's
    // status and queue position.
    const { data: all } = await supabase
      .from("batch_ingredient_commitments")
      .select("batch_id, committed_qty, brew_batches(status, planned_brew_date)")
      .eq("ingredient_id", c.ingredient_id)
      .is("released_at", null);

    // Claims that outrank this batch: still pre-brew, and brewing sooner.
    // Ties break on batch_id so two same-date batches get a stable, consistent
    // ordering rather than one that flips between requests.
    let priorClaims = 0;
    let totalCommitted = 0;
    for (const row of all ?? []) {
      const owner = (row.brew_batches as unknown) as
        { status: string; planned_brew_date: string | null } | null;
      if (!owner || !PRE_BREW_STATUSES.includes(owner.status)) continue;

      const qty = Number(row.committed_qty);
      totalCommitted += qty;
      if (row.batch_id === batchId) continue;

      const theirDate = owner.planned_brew_date ?? null;
      const outranks =
        theirDate == null && myDate == null ? row.batch_id < batchId
        : theirDate == null ? false
        : myDate == null    ? true
        : theirDate !== myDate ? theirDate < myDate
        : row.batch_id < batchId;
      if (outranks) priorClaims += qty;
    }

    // Clamped at zero: an earlier batch can only claim stock that exists, so its
    // own unmet deficit must not roll forward into this batch's shortfall. Without
    // the clamp B-056 reported "needs 450 lb Pilsner, short 1110" — 450 of its own
    // plus the 660 B-054 was already missing.
    const availableToMe = Math.max(0, Number(ing.stock_quantity) - priorClaims);
    const effective     = availableToMe - Number(c.committed_qty);

    if (effective < -0.001) {
      shortfalls.push({
        ingredient_id:        c.ingredient_id,
        name:                 ing.name,
        unit:                 ing.unit,
        stock_quantity:       Number(ing.stock_quantity),
        total_committed:      Math.round(totalCommitted * 1000) / 1000,
        this_batch_committed: Number(c.committed_qty),
        available_to_batch:   Math.round(availableToMe * 1000) / 1000,
        shortfall:            Math.round(Math.abs(effective) * 1000) / 1000,
      });
    }
  }

  return shortfalls;
}
