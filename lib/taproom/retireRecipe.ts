/**
 * Retirement state for a taproom recipe.
 *
 * Retiring means "stop planning more of this beer" — it greys the Draft Stats tap
 * card once critical, suppresses stockout forecast / needed_bbl in Production →
 * Intake, and makes the batch scheduler skip the recipe. It never affects
 * accounting: a retired beer's residual is still written off on swap.
 *
 * Two callers write this state — the settings route (manual Mark Retired /
 * Unretire) and the tap-swap queue route (retires the outgoing beer when a swap
 * is queued, un-retires the incoming beer when one is consumed) — so the payload
 * lives here rather than being duplicated per call site.
 */

export interface RetirePayload {
  recipe_id: string;
  is_retired: boolean;
  /** Mirrors `is_retired`: the retirement timestamp, or null once un-retired. */
  retired_at: string | null;
  retired_notes: string | null;
}

/**
 * Pure — the caller supplies `nowIso` so one timestamp can span several writes in
 * the same request (and so tests need no clock stubbing).
 */
export function buildRetirePayload(
  recipeId: string,
  isRetired: boolean,
  nowIso: string,
  notes?: string | null,
): RetirePayload {
  return {
    recipe_id: recipeId,
    is_retired: isRetired,
    retired_at: isRetired ? nowIso : null,
    retired_notes: notes || null,
  };
}
