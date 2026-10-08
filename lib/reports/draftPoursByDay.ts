import { addDaysStr } from "@/lib/utils/datetime";

/** One `draft_pour_consumption` row: a beer's poured fl oz on one business date. */
export interface DraftPourRow {
  recipe_id: string;
  business_date: string;
  fl_oz: number | string;
}

export interface DraftPoursRecipe {
  recipe_id: string;
  beer_name: string;
  /** business_date → fl oz. A day with no pours is absent, not zero. */
  by_day: Record<string, number>;
  total_fl_oz: number;
  /** Days in the window this beer actually poured. */
  days_poured: number;
  /**
   * Average over the days it poured, NOT over the window. A beer tapped four
   * days ago would otherwise read as a slow seller next to one on all fortnight.
   */
  avg_fl_oz_per_day: number;
}

export interface DraftPoursByDay {
  /** Every date in the window, oldest first — including days nothing poured. */
  days: string[];
  recipes: DraftPoursRecipe[];
  totals_by_day: Record<string, number>;
  total_fl_oz: number;
}

/**
 * Pivot per-(recipe, day) pour rows into one row per beer across a window of
 * `days` ending on `endDate` (inclusive). Beers with no pours in the window are
 * dropped; the rest are ordered biggest seller first.
 */
export function buildDraftPoursByDay(
  rows: DraftPourRow[],
  beerNameByRecipe: Map<string, string>,
  endDate: string,
  days: number,
): DraftPoursByDay {
  const dayList = Array.from({ length: days }, (_, i) => addDaysStr(endDate, i - (days - 1)));
  const inWindow = new Set(dayList);

  const byRecipe = new Map<string, Record<string, number>>();
  const totalsByDay: Record<string, number> = {};
  for (const r of rows) {
    if (!inWindow.has(r.business_date)) continue;
    const oz = Number(r.fl_oz) || 0;
    if (oz === 0) continue;
    const byDay = byRecipe.get(r.recipe_id) ?? {};
    byDay[r.business_date] = (byDay[r.business_date] ?? 0) + oz;
    byRecipe.set(r.recipe_id, byDay);
    totalsByDay[r.business_date] = (totalsByDay[r.business_date] ?? 0) + oz;
  }

  const recipes: DraftPoursRecipe[] = [...byRecipe.entries()].map(([recipeId, byDay]) => {
    const values = Object.values(byDay);
    const total = values.reduce((s, v) => s + v, 0);
    return {
      recipe_id: recipeId,
      beer_name: beerNameByRecipe.get(recipeId) ?? "—",
      by_day: byDay,
      total_fl_oz: total,
      days_poured: values.length,
      avg_fl_oz_per_day: values.length > 0 ? total / values.length : 0,
    };
  }).sort((a, b) => b.total_fl_oz - a.total_fl_oz || a.beer_name.localeCompare(b.beer_name));

  return {
    days: dayList,
    recipes,
    totals_by_day: totalsByDay,
    total_fl_oz: recipes.reduce((s, r) => s + r.total_fl_oz, 0),
  };
}
