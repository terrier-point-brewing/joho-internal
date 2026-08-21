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
import { conversionDelta, type BillLine } from "./recipeLineage";

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
 * Make this batch's commitments match the recipe × turns exactly.
 *
 * Quantities come from `quantity_per_turn` as entered, NOT from the derived
 * `quantity_per_bbl` rate. A turn is a brewhouse fill (20 bbl here) and the
 * grain bill is what goes into it; `quantity_per_bbl` divides that by
 * `expected_yield_bbl` (19.5), which is post-loss liquid. Multiplying that rate
 * back by a batch volume therefore inflated every ingredient by turn/yield —
 * B-058's 55 lb of Debittered Black was committed as 56.41. A lower yield means
 * less beer out, never more grain in.
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
  turns: number,
): Promise<void> {
  const { data: ris } = await supabase
    .from("recipe_ingredients")
    .select("ingredient_id, quantity_per_turn")
    .eq("recipe_id", recipeId);

  await writeCommitmentSet(
    supabase,
    batchId,
    (ris ?? []).map((ri) => ({
      ingredient_id: ri.ingredient_id,
      committed_qty: ri.quantity_per_turn * turns,
    })),
  );
}

/**
 * Make this batch's active commitments be exactly `rows`, and nothing else.
 *
 * Shared by the two ways a batch acquires ingredients — brewed from a recipe,
 * or converted off another batch — because the replace-don't-add semantics are
 * the same either way and getting them wrong is what left B-056 reporting the
 * union of two recipes.
 */
async function writeCommitmentSet(
  supabase: SupabaseClient,
  batchId: string,
  rows: Array<{ ingredient_id: string; committed_qty: number }>,
): Promise<void> {
  if (!rows.length) {
    // Nothing to commit — drop whatever the batch still holds.
    await releaseCommitments(supabase, batchId);
    return;
  }

  await supabase
    .from("batch_ingredient_commitments")
    .upsert(
      rows.map((r) => ({
        batch_id:      batchId,
        ingredient_id: r.ingredient_id,
        committed_qty: r.committed_qty,
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
    .not("ingredient_id", "in", `(${rows.map((r) => r.ingredient_id).join(",")})`);
}

/**
 * Commit what a CONVERSION adds, rather than what the beer costs to brew.
 *
 * A conversion-born batch is liquid that already exists: the base recipe's grain
 * went into the parent batch and was deducted there. Committing the derived
 * recipe's full bill would reserve all of it a second time — 725 lb of silo malt
 * for beer that is already in the tank. Committing nothing, which is what the
 * code did before it could tell base from addition, loses the puree and the
 * oranges entirely.
 *
 * So: the per-bbl difference between the two bills, scaled by the volume drawn
 * off. Rates rather than turns, because a conversion takes a volume of finished
 * liquid and never a brewhouse turn.
 *
 * This is the deliberate exception to "never multiply quantity_per_bbl back out"
 * — that rule exists because reconstructing a TURN from the rate inflates the
 * bill by turn/yield, the denominator being post-loss liquid rather than the
 * brewhouse fill. Here the multiplier IS post-loss liquid: 68 lb of puree per
 * 20 bbl turn is 3.4 lb for every bbl of finished Reaper's Harvest, and drawing
 * 23.5 bbl off the parent needs 79.9 lb of it. Reading quantity_per_turn instead
 * would charge a full turn's puree no matter how little liquid was converted.
 *
 * When the two recipes are not linked, or the derived bill adds nothing, the
 * batch ends up with no commitments — the same place it was before, which is the
 * right answer for liquid that consumed no new stock.
 */
export async function upsertConversionCommitments(
  supabase: SupabaseClient,
  batchId: string,
  derivedRecipeId: string,
  baseRecipeId: string,
  convertedVolumeBbl: number,
): Promise<void> {
  const volume = Number(convertedVolumeBbl);
  if (!Number.isFinite(volume) || volume <= 0) return;

  const [derived, base] = await Promise.all([
    supabase.from("recipe_ingredients").select("ingredient_id, quantity_per_bbl").eq("recipe_id", derivedRecipeId),
    supabase.from("recipe_ingredients").select("ingredient_id, quantity_per_bbl").eq("recipe_id", baseRecipeId),
  ]);

  const delta = conversionDelta(
    (derived.data ?? []) as BillLine[],
    (base.data ?? []) as BillLine[],
  );

  await writeCommitmentSet(
    supabase,
    batchId,
    delta.map((d) => ({
      ingredient_id: d.ingredient_id,
      committed_qty: d.quantity_per_bbl * volume,
    })),
  );
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
    .select("id, turns")
    .eq("recipe_id", recipeId)
    .in("status", PRE_BREW_STATUSES);

  for (const b of batches ?? []) {
    await upsertCommitments(supabase, b.id, recipeId, Math.max(1, Number(b.turns ?? 1)));
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
