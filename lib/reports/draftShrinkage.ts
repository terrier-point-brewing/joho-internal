export interface SwapShrinkageRow {
  recipe_id: string;
  occurred_at: string;
  remaining_fl_oz: number;
  full_fl_oz: number;
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

/** Group deterministic swap-shrinkage rows into the per-recipe chart shape. */
export function aggregateShrinkage(
  rows: SwapShrinkageRow[],
  beerNameByRecipe: Map<string, string>,
): ShrinkageByRecipe[] {
  const byRecipe = new Map<string, SwapShrinkageRow[]>();
  for (const row of rows) {
    const list = byRecipe.get(row.recipe_id) ?? [];
    list.push(row);
    byRecipe.set(row.recipe_id, list);
  }

  return [...byRecipe.entries()]
    .map(([recipe_id, group]) => {
      const events: ShrinkageEvent[] = group
        .map((r) => ({
          date: r.occurred_at.slice(0, 10),
          shrinkage_fl_oz: round1(r.remaining_fl_oz),
          shrinkage_pct: r.full_fl_oz > 0 ? round1((r.remaining_fl_oz / r.full_fl_oz) * 100) : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const avgFlOz = group.reduce((s, r) => s + r.remaining_fl_oz, 0) / group.length;
      const avgPct =
        group.reduce((s, r) => s + (r.full_fl_oz > 0 ? r.remaining_fl_oz / r.full_fl_oz : 0), 0) / group.length;
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
