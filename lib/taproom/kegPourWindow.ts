/**
 * Recorded pour volume over one keg's life — the measured half of shrinkage.
 *
 * Shrinkage is beer that left the keg with no transaction behind it:
 *
 *   shrinkage = full_keg_fl_oz − Σ(recorded pour fl oz while that keg was on)
 *
 * A $0 comp still carries a transaction, so it counts as recorded and is NOT
 * shrinkage — the sales path filters on quantity, never price, which is exactly
 * what that requires. Beer poured with no ring at all (foam dumped to pull a
 * clean pint, an off-book giveaway, line cleaning) has no line item, so it falls
 * out of the sum and lands in shrinkage. That is the whole definition.
 */
import { fetchOrderSalesByDay } from "@/lib/square/inventory";
import { loadDraftPourVariations, type PourVar } from "./draftPourConsumption";

export interface PourWindow {
  flOz: number;
  /**
   * Pour variations with no fl oz mapping. Their sales are invisible to the sum,
   * so they would inflate shrinkage by exactly the volume they sold — a silent
   * "this beer is leaking" reading caused by a menu change, not by lost beer.
   * Non-empty means the window is unusable and the caller must fall back.
   */
  unmappedVariationIds: string[];
}

/**
 * Pure: day-bucketed pour sales ⇒ total fl oz for one recipe's pour variations.
 *
 * Day buckets are summed rather than filtered — the *request* carries the real
 * time bounds, so every bucket returned is already inside the window. That's why
 * this reads Square directly instead of the `draft_pour_consumption` ledger,
 * which is day-grain: a keg swapped at 6pm would split one day's pours across
 * two kegs and neither would be right.
 */
export function sumPourFlOz(
  salesByDay: Map<string, number>, // "<varId>\t<YYYY-MM-DD>" → units
  pourVars: PourVar[],
): PourWindow {
  const byVar = new Map<string, PourVar>();
  for (const v of pourVars) byVar.set(v.id, v);

  let flOz = 0;
  const unmapped = new Set<string>();
  for (const [key, units] of salesByDay) {
    const varId = key.split("\t")[0];
    const pv = byVar.get(varId);
    if (!pv) continue; // not a pour variation of this recipe
    if (pv.oz) flOz += units * pv.oz;
    else if (units > 0) unmapped.add(varId);
  }
  return { flOz, unmappedVariationIds: [...unmapped] };
}

/**
 * Recorded pour fl oz for `recipeId` between two restock rings.
 *
 * `sinceIso` is the tap's previous ring and `untilIso` this one, so the window
 * is bounded by the same events that bound the keg. Returns null when the recipe
 * has no pour variations configured at all — there is nothing to measure, and
 * the caller should fall back rather than report a full keg of shrinkage.
 */
export async function fetchPourFlOzBetween(
  supabase: Parameters<typeof loadDraftPourVariations>[0],
  recipeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<PourWindow | null> {
  const pourVarsByRecipe = await loadDraftPourVariations(supabase);
  return fetchPourFlOzBetweenWith(pourVarsByRecipe, recipeId, sinceIso, untilIso);
}

/**
 * Same, with the pour-variation map already loaded. The sync resolves several
 * restocks per run and the map is a two-query catalog read, so it loads once.
 */
export async function fetchPourFlOzBetweenWith(
  pourVarsByRecipe: Map<string, PourVar[]>,
  recipeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<PourWindow | null> {
  const pourVars = pourVarsByRecipe.get(recipeId);
  if (!pourVars || pourVars.length === 0) return null;

  // fetchOrderSalesByDay takes RFC3339 bounds verbatim and already drops invoice
  // orders and internal keg-transfer lines — the same exclusions the pour ledger
  // uses, so the two lenses can't disagree about what counts as a sale.
  const salesByDay = await fetchOrderSalesByDay(
    sinceIso,
    untilIso,
    pourVars.map((v) => v.id),
  );
  return sumPourFlOz(salesByDay, pourVars);
}
