/**
 * One keg's shrinkage: beer that left it with no transaction behind it, measured
 * as its full volume less every pour recorded during its life. A $0 comp carries
 * a transaction, so it is NOT shrinkage; foam, off-book giveaways and line
 * cleaning are.
 */
export interface SwapShrinkageRow {
  recipe_id: string;
  occurred_at: string;
  unaccounted_fl_oz: number;
  full_fl_oz: number;
  /**
   * `beer_change` rows are excluded from the chart below. That keg was pulled
   * early to change beers, so its balance is mostly beer deliberately dumped —
   * averaging it with blown kegs reads as a shrinkage spike that no amount of
   * pour discipline could fix.
   */
  cause?: "keg_emptied" | "beer_change";
}

export interface ShrinkageEvent {
  date: string;
  shrinkage_fl_oz: number;
  shrinkage_pct: number;
}

export interface ShrinkageByRecipe {
  recipe_id: string;
  beer_name: string;
  events: ShrinkageEvent[];
  avg_shrinkage_fl_oz: number;
  avg_shrinkage_pct: number;
  keg_count: number;
}

const round1 = (n: number) => Number(n.toFixed(1));

/**
 * Group per-keg shrinkage rows into the per-recipe chart shape.
 *
 * Beer-change rows are dropped: that keg came off deliberately half-full, so its
 * balance measures a decision, not a loss the taproom can tighten up.
 */
export function aggregateShrinkage(
  rows: SwapShrinkageRow[],
  beerNameByRecipe: Map<string, string>,
): ShrinkageByRecipe[] {
  const byRecipe = new Map<string, SwapShrinkageRow[]>();
  for (const row of rows) {
    if (row.cause === "beer_change") continue;
    const list = byRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    byRecipe.set(row.recipe_id, list);
  }

  return [...byRecipe.entries()]
    .map(([recipe_id, group]) => {
      const events: ShrinkageEvent[] = group
        .map((r) => ({
          date: r.occurred_at.slice(0, 10),
          shrinkage_fl_oz: round1(r.unaccounted_fl_oz),
          shrinkage_pct: r.full_fl_oz > 0 ? round1((r.unaccounted_fl_oz / r.full_fl_oz) * 100) : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const avgFlOz = group.reduce((s, r) => s + r.unaccounted_fl_oz, 0) / group.length;
      const avgPct =
        group.reduce((s, r) => s + (r.full_fl_oz > 0 ? r.unaccounted_fl_oz / r.full_fl_oz : 0), 0) / group.length;
      return {
        recipe_id,
        beer_name: beerNameByRecipe.get(recipe_id) ?? "—",
        events,
        avg_shrinkage_fl_oz: round1(avgFlOz),
        avg_shrinkage_pct: round1(avgPct * 100),
        keg_count: group.length,
      };
    })
    .sort((a, b) => b.avg_shrinkage_fl_oz - a.avg_shrinkage_fl_oz);
}
